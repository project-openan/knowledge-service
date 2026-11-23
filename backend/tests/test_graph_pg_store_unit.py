"""graph_pg 的 SQL 组装与行映射（假连接，不碰真库）。

钉三类分支：

1. 行形状：``_vertex_row`` / ``_edge_row``（RID 合成、JSON 字符串兜底、DATE 归一）；
2. CRUD/查询的 SQL 组装与参数顺序（``_condition`` 全操作符、游标分页、keyword）；
3. 失败分支：查不到 → GraphException（KG0xx），行数 0 → not deleted/updated。

跑法::

    python -m pytest tests/test_graph_pg_store_unit.py -q
"""

from __future__ import annotations

import json

import pytest

from graph.repository import graph_pg
from graph.errors import GraphException
from graph.models.kg_struct import EdgeData, EntityData


class FakeCursor:
    """记录 SQL 与参数；按预设脚本回结果。"""

    def __init__(self, conn, results=None, rowcount=1, error=None):
        self.conn = conn
        self._results = list(results or [])
        self.rowcount = rowcount
        self._error = error
        self.description = [('entity_id',), ('entity_type',), ('properties',), ('id',)]
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if self._error is not None:
            raise self._error

    def fetchone(self):
        if self._error is not None:
            raise self._error
        return self._results[0] if self._results else None

    def fetchall(self):
        if self._error is not None:
            raise self._error
        rows, self._results = self._results, []
        return rows

    def close(self):
        pass


class FakeConn:
    def __init__(self, cursor=None):
        self._cursor = cursor or FakeCursor(self)
        self.commits = 0

    def cursor(self):
        return self._cursor

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def commit(self):
        self.commits += 1


@pytest.fixture()
def kb(monkeypatch):
    """把 graph_pg 的连接来源换成假连接。"""
    from infrastructure.db import kb as db

    holder = {}

    def install(cursor):
        conn = FakeConn(cursor)
        holder['conn'] = conn
        monkeypatch.setattr(db, 'connection', lambda: conn)
        return conn

    return install


CLIENT = graph_pg.new_client('graph_demo')


# ----------------------------------------------------------------------
# 行形状
# ----------------------------------------------------------------------


def test_vertex_row_parses_json_string_properties():
    row = ('Person_1', 'Person', '{"name": "Alice"}', 7)
    shaped = graph_pg._vertex_row(row)
    assert shaped['name'] == 'Alice'
    assert shaped['@rid'] == '#7:0'


def test_vertex_row_blank_json_falls_back_to_empty():
    shaped = graph_pg._vertex_row(('P', 'Person', '', 3))
    assert shaped == {'@rid': '#3:0', '@class': 'Person', 'entity_id': 'P'}
    with pytest.raises(ValueError):
        graph_pg._vertex_row(('P', 'Person', 'not-json', 3))


def test_edge_row_without_vertex_ids_uses_business_ids_as_endpoints():
    row = ('Knows_1', 'Knows', 'Person_1', 'Person_2', '{}', 3, None, None)
    shaped = graph_pg._edge_row(row)
    assert shaped['out'] == 'Person_1'
    assert shaped['in'] == 'Person_2'


def test_normalize_value_appends_midnight_for_date_strings():
    assert graph_pg._normalize_value('2024-01-02') == '2024-01-02 00:00:00'
    assert graph_pg._normalize_value('2024-01-02T10:00:00') == '2024-01-02T10:00:00'
    assert graph_pg._normalize_value(5) == 5


def test_split_properties_drops_reserved_and_at_keys_and_normalizes_dates():
    props = {'name': 'x', '@rid': '#1:0', 'entity_id': 'keep-out', 'day': '2024-05-06'}
    assert graph_pg._split_properties(props, {'entity_id'}) == {
        'name': 'x', 'day': '2024-05-06 00:00:00'}
    assert graph_pg._split_properties(None, set()) == {}


# ----------------------------------------------------------------------
# CRUD
# ----------------------------------------------------------------------


def test_entity_exists_true_false_and_error_paths(kb):
    kb(FakeCursor(FakeConn(), results=[(1,)]))
    assert graph_pg.entity_exists(CLIENT, 'Person', 'Person_1') is True

    kb(FakeCursor(FakeConn(), results=[]))
    assert graph_pg.entity_exists(CLIENT, 'Person', 'Person_1') is False

    kb(FakeCursor(FakeConn(), error=RuntimeError('boom')))
    assert graph_pg.entity_exists(CLIENT, 'Person', 'Person_1') is False


def test_edge_exists_true_false_and_error_paths(kb):
    kb(FakeCursor(FakeConn(), results=[(1,)]))
    assert graph_pg.edge_exists(CLIENT, 'Knows', 'Knows_1') is True

    kb(FakeCursor(FakeConn(), results=[]))
    assert graph_pg.edge_exists(CLIENT, 'Knows', 'Knows_1') is False

    kb(FakeCursor(FakeConn(), error=RuntimeError('boom')))
    assert graph_pg.edge_exists(CLIENT, 'Knows', 'Knows_1') is False


def test_get_entity_properties_raises_kg020_when_missing(kb):
    kb(FakeCursor(FakeConn(), results=[]))
    with pytest.raises(GraphException) as caught:
        graph_pg.get_entity_properties(CLIENT, 'Person', 'Person_x')
    assert caught.value.err_code == 'KG020'


def test_get_edge_properties_raises_kg022_when_missing(kb):
    kb(FakeCursor(FakeConn(), results=[]))
    with pytest.raises(GraphException) as caught:
        graph_pg.get_edge_properties(CLIENT, 'Knows', 'Knows_x')
    assert caught.value.err_code == 'KG022'


def test_add_entity_failure_wraps_kg007(kb):
    kb(FakeCursor(FakeConn(), error=RuntimeError('dup')))
    with pytest.raises(GraphException) as caught:
        graph_pg.add_entity(CLIENT, EntityData('P_1', 'Person', {'name': 'x'}))
    assert caught.value.err_code == 'KG007'


def test_add_edge_checks_both_endpoints(kb):
    cursor = FakeCursor(FakeConn(), results=[(1,)])
    conn = kb(cursor)
    graph_pg.add_edge(CLIENT, EdgeData('K_1', 'Knows', 'Person_1', 'Person_2',
                                       {'since': 2024}))
    assert len(conn._cursor.executed) == 3

    # 源点不存在 → KG012
    kb(FakeCursor(FakeConn(), results=[]))
    with pytest.raises(GraphException) as caught:
        graph_pg.add_edge(CLIENT, EdgeData('K_1', 'Knows', 'Ghost_1', 'Person_2', {}))
    assert 'Source entity not found' in caught.value.args[0]

    # 两端都在，INSERT 失败 → KG012 (Failed to add edge)
    calls = {'execute': 0}

    class SeqCursor(FakeCursor):
        def execute(self, sql, params=None):
            calls['execute'] += 1
            self.executed.append((sql, params))
            if calls['execute'] >= 3:
                raise RuntimeError('dup')
            self._results = [(1,)]

        def fetchone(self):
            return self._results[0] if self._results else None

    kb(SeqCursor(FakeConn()))
    with pytest.raises(GraphException) as caught:
        graph_pg.add_edge(CLIENT, EdgeData('K_1', 'Knows', 'Person_1', 'Person_2', {}))
    assert 'Failed to add edge' in caught.value.args[0]


def test_update_entity_empty_properties_is_kg014(kb):
    with pytest.raises(GraphException) as caught:
        graph_pg.update_entity(CLIENT, 'Person', 'Person_1', {})
    assert caught.value.err_code == 'KG014'


def test_update_entity_rowcount_zero_is_kg014(kb):
    kb(FakeCursor(FakeConn(), rowcount=0))
    with pytest.raises(GraphException) as caught:
        graph_pg.update_entity(CLIENT, 'Person', 'Person_1', {'name': 'x'})
    assert caught.value.err_code == 'KG014'


def test_update_edge_empty_properties_is_kg024(kb):
    with pytest.raises(GraphException) as caught:
        graph_pg.update_edge(CLIENT, 'Knows', 'Knows_1', {})
    assert caught.value.err_code == 'KG024'


def test_update_edge_rowcount_zero_is_kg024(kb):
    kb(FakeCursor(FakeConn(), rowcount=0))
    with pytest.raises(GraphException) as caught:
        graph_pg.update_edge(CLIENT, 'Knows', 'Knows_1', {'since': 1})
    assert caught.value.err_code == 'KG024'


def test_delete_entity_rowcount_zero_is_kg017(kb):
    kb(FakeCursor(FakeConn(), rowcount=0))
    with pytest.raises(GraphException) as caught:
        graph_pg.delete_entity(CLIENT, 'Person', 'Person_1')
    assert caught.value.err_code == 'KG017'


def test_delete_edge_rowcount_zero_is_kg027(kb):
    kb(FakeCursor(FakeConn(), rowcount=0))
    with pytest.raises(GraphException) as caught:
        graph_pg.delete_edge(CLIENT, 'Knows', 'Knows_1')
    assert caught.value.err_code == 'KG027'


def test_delete_edges_by_entity_returns_rowcount(kb):
    kb(FakeCursor(FakeConn(), rowcount=3))
    assert graph_pg.delete_edges_by_entity(CLIENT, 'Person', 'Person_1') == 3


# ----------------------------------------------------------------------
# 批量 upsert
# ----------------------------------------------------------------------


def test_upsert_entities_bulk_batches_by_500_and_skips_empty(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    graph_pg.upsert_entities_bulk('graph_demo', [])
    assert cursor.executed == []

    rows = [(f'T{i}', f'T_{i}', {'n': i}, ['L1']) for i in range(501)]
    graph_pg.upsert_entities_bulk('graph_demo', rows)
    assert len(cursor.executed) == 2
    first_params = cursor.executed[0][1]
    assert len(first_params) == 500 * 3
    assert json.loads(first_params[2])['#labels'] == ['L1']

    # labels 为空列表 / 非 list：不写 #labels
    cursor2 = FakeCursor(FakeConn())
    kb(cursor2)
    graph_pg.upsert_entities_bulk('graph_demo', [('T', 'T_1', {'n': 1}, [])])
    assert '#labels' not in json.loads(cursor2.executed[0][1][2])


def test_upsert_edges_bulk_batches(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    rows = [(f'E{i}', f'E_{i}', 'S_1', 'T_1', {'w': 1}, None) for i in range(600)]
    graph_pg.upsert_edges_bulk('graph_demo', rows)
    assert len(cursor.executed) == 2


def test_upsert_entity_and_edge_single_row_write_labels(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    graph_pg.upsert_entity('graph_demo', 'Person', 'P_1', {'name': 'x'}, ['Tag'])
    graph_pg.upsert_edge('graph_demo', 'Knows', 'K_1', 'P_1', 'P_2', {}, ['E'])
    assert len(cursor.executed) == 2
    entity_json = json.loads(cursor.executed[0][1][2])
    edge_json = json.loads(cursor.executed[1][1][4])
    assert entity_json['#labels'] == ['Tag']
    assert edge_json['#labels'] == ['E']


# ----------------------------------------------------------------------
# 列表 / 批量删除
# ----------------------------------------------------------------------


def test_list_all_vertices_paginates_until_short_page(kb):
    page1 = [(f'P{i}', 'Person', {}, i) for i in range(2)]
    cursor = FakeCursor(FakeConn(), results=page1[:1])
    kb(cursor)
    # 第一次 fetchall 返回满页（2 行 == page_size），第二次返回短页
    cursor._results = list(page1)
    seen = []

    original_fetchall = cursor.fetchall

    def fetchall():
        rows = original_fetchall()
        seen.append(len(rows))
        if len(seen) == 1:
            cursor._results = [('P9', 'Person', {}, 9)]  # 短页
        return rows

    cursor.fetchall = fetchall
    rows = graph_pg.list_all_vertices(CLIENT, page_size=2)
    assert len(rows) == 3
    assert seen == [2, 1]


def test_list_all_edges_paginates(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    pages = [
        [('K1', 'Knows', 'P1', 'P2', '{}', 1, 10, 11),
         ('K2', 'Knows', 'P2', 'P3', '{}', 2, 11, 12)],
        [('K3', 'Knows', 'P3', 'P4', '{}', 3, 12, 13)],
    ]
    state = {'page': 0}

    def fetchall():
        page = pages[min(state['page'], len(pages) - 1)]
        state['page'] += 1
        return page

    cursor.fetchall = fetchall
    rows = graph_pg.list_all_edges(CLIENT, page_size=2)
    assert [row['edge_id'] for row in rows] == ['K1', 'K2', 'K3']


def test_list_vertices_by_chunk_ids_matches_comma_lists(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    pages = [
        [('P1', 'Person', {'chunk_id': 'c1,c2'}, 1),
         ('P2', 'Person', {'chunk_id': None}, 2),
         ('P3', 'Person', {'chunk_id': 'c3'}, 3)],
    ]
    state = {'page': 0}

    def fetchall():
        page = pages[min(state['page'], len(pages) - 1)]
        state['page'] += 1
        return page

    cursor.fetchall = fetchall
    matched = graph_pg.list_vertices_by_chunk_ids(CLIENT, ['c2', 'c3'])
    assert [row['entity_id'] for row in matched] == ['P1', 'P3']
    assert graph_pg.list_vertices_by_chunk_ids(CLIENT, []) == []


def test_delete_entities_by_chunk_ids_collects_and_continues(monkeypatch, kb):
    kb(FakeCursor(FakeConn()))
    monkeypatch.setattr(graph_pg, 'list_vertices_by_chunk_ids', lambda client, ids: [
        {'@class': 'Person', 'entity_id': 'P1', 'chunk_id': 'c1'},
        {'@class': 'Person', 'entity_id': 'P2', 'chunk_id': 'c1'},
    ])

    def fake_delete(client, entity_type, entity_id):
        if entity_id == 'P1':
            return
        raise RuntimeError('locked')

    monkeypatch.setattr(graph_pg, 'delete_entity', fake_delete)
    deleted = graph_pg.delete_entities_by_chunk_ids(CLIENT, ['c1'])
    assert deleted == ['P1']


# ----------------------------------------------------------------------
# 条件与查询
# ----------------------------------------------------------------------


@pytest.mark.parametrize('value, expected_sql, expected_params', [
    (['a', 'b'], "properties->>'k' = ANY(%s)", [['a', 'b']]),
    ([], 'FALSE', []),
    (None, "properties->>'k' IS NULL", []),
    ('plain', "properties->>'k' = %s", ['plain']),
    ({'op': 'eq', 'value': 1}, "properties->>'k' = %s", [1]),
    ({'op': 'ne', 'value': 1}, "properties->>'k' <> %s", [1]),
    ({'op': 'gt', 'value': 1}, "(properties->>'k')::numeric > %s", [1]),
    ({'op': 'lte', 'value': 1}, "(properties->>'k')::numeric <= %s", [1]),
    ({'op': 'like', 'value': 'a%'}, "properties->>'k' LIKE %s", ['a%']),
    ({'op': 'in', 'value': [1, 2]}, "properties->>'k' = ANY(%s)", [[1, 2]]),
    ({'op': 'in', 'value': []}, 'FALSE', []),
    ({'op': 'between', 'value': [1, 2]},
     "(properties->>'k')::numeric BETWEEN %s AND %s", [1, 2]),
    ({'op': 'between', 'value': [1]}, 'FALSE', []),
    ({'op': 'contains', 'value': 'vip'}, "properties->'k' @> %s::jsonb", [json.dumps(['vip'])]),
    ({'op': 'contains_all', 'value': ['a', 'b']},
     "properties->'k' @> %s::jsonb", [json.dumps(['a', 'b'])]),
    ({'op': 'contains_any', 'value': ['a']},
     "EXISTS (SELECT 1 FROM jsonb_array_elements_text(properties->'k') AS item "
     "WHERE item = ANY(%s))", [['a']]),
    ({'op': 'unknown', 'value': 1}, 'FALSE', []),
    ({'op': 'and', 'value': [{'op': 'eq', 'value': 1}, {'op': 'ne', 'value': 2}]},
     "(properties->>'k' = %s AND properties->>'k' <> %s)", [1, 2]),
    ({'op': 'or', 'value': []}, 'FALSE', []),
])
def test_condition_operator_matrix(value, expected_sql, expected_params):
    params: list = []
    assert graph_pg._condition('k', value, params) == expected_sql
    assert params == expected_params


def test_condition_and_group_nesting():
    params: list = []
    sql = graph_pg._condition('k', {'op': 'or', 'value': [
        {'op': 'and', 'value': [{'op': 'eq', 'value': 1}, {'op': 'eq', 'value': 2}]}]}, params)
    assert sql == "((properties->>'k' = %s AND properties->>'k' = %s))"
    assert params == [1, 2]


def test_json_key_rejects_unsafe_names():
    with pytest.raises(ValueError):
        graph_pg._json_key('a; drop')


def test_groups_sql_or_joins_type_and_property_conditions():
    groups = [
        {'entity_type': ['Person'], 'properties': {'age': {'op': 'gte', 'value': 18}}},
        {'entity_type': [], 'properties': {'bogus': {'op': 'nope', 'value': 1}}},
        {},
    ]
    sql, params = graph_pg._groups_sql(groups, 'entity_type', 'entity_type')
    assert sql == "(entity_type = ANY(%s) AND (properties->>'age')::numeric >= %s)"
    assert params == [['Person'], 18]


@pytest.mark.parametrize('raw, expected', [
    ('#12:3', 12),
    ('12:3', 12),
    ('  #7:0  ', 7),
    ('abc', None),
    ('', None),
    (None, None),
])
def test_parse_rid(raw, expected):
    assert graph_pg._parse_rid(raw) == expected


def test_query_vertices_with_keyword_cursor_and_offset(kb):
    cursor = FakeCursor(FakeConn(), results=[('P1', 'Person', {}, 5)])
    kb(cursor)
    rows = graph_pg.query_vertices(
        'graph_demo', [{'entity_type': ['Person']}], 10, 20,
        cursor='#4:1', keyword='林')
    assert rows[0]['entity_id'] == 'P1'
    sql, params = cursor.executed[0]
    assert 'WHERE' in sql and 'e.id > 4' in sql
    assert 'ILIKE' in sql
    assert params[-2:] == [10, 0]  # 游标分页时 offset 固定 0


def test_query_vertices_without_groups_only_keyword(kb):
    cursor = FakeCursor(FakeConn(), results=[])
    kb(cursor)
    graph_pg.query_vertices('graph_demo', [], 10, 0, None, keyword='abc')
    sql, params = cursor.executed[0]
    assert 'entity_type' not in sql.split('WHERE')[1].split('ILIKE')[0]
    assert params[:2] == ['%abc%', '%abc%']
    assert params[-2:] == [10, 0]


def test_query_vertices_plain_offset(kb):
    cursor = FakeCursor(FakeConn(), results=[])
    kb(cursor)
    graph_pg.query_vertices('graph_demo', [{'entity_type': ['Person']}], 10, 7)
    sql, params = cursor.executed[0]
    assert 'e.id >' not in sql
    assert params[-2:] == [10, 7]


def test_query_edges_with_cursor_no_groups(kb):
    cursor = FakeCursor(FakeConn(), results=[])
    kb(cursor)
    graph_pg.query_edges('graph_demo', [], 5, 0, cursor='#9:0')
    sql, params = cursor.executed[0]
    assert 'WHERE e.id > 9' in sql
    assert params[-2:] == [5, 0]


def test_edges_between_entities_and_vertices_by_entity_ids_empty(kb):
    kb(FakeCursor(FakeConn()))
    assert graph_pg.edges_between_entities('graph_demo', []) == []
    assert graph_pg.vertices_by_entity_ids('graph_demo', []) == []
    assert graph_pg.vertices_by_rids('graph_demo', []) == []
    assert graph_pg.vertices_by_rids('graph_demo', ['junk']) == []


def test_vertices_by_rids_parses_and_queries(kb):
    cursor = FakeCursor(FakeConn(), results=[('P1', 'Person', {}, 4)])
    kb(cursor)
    rows = graph_pg.vertices_by_rids('graph_demo', ['#4:0', 'bad'])
    assert rows[0]['entity_id'] == 'P1'
    assert cursor.executed[0][1] == ([4],)


def test_resolve_entity_id_by_rid(kb):
    cursor = FakeCursor(FakeConn(), results=[('P1',)])
    kb(cursor)
    assert graph_pg.resolve_entity_id_by_rid('graph_demo', '#4:0') == 'P1'
    assert graph_pg.resolve_entity_id_by_rid('graph_demo', 'bad') is None

    kb(FakeCursor(FakeConn(), results=[]))
    assert graph_pg.resolve_entity_id_by_rid('graph_demo', '#4:0') is None


def test_start_entity_ids_from_lists_rids_and_type_groups(kb):
    cursor = FakeCursor(FakeConn(), results=[('P9', 'Person', {}, 9)])
    kb(cursor)
    ids = graph_pg.start_entity_ids('graph_demo', [
        {'start_entity_properties': {'entity_id': ['P1', None, 'P2']}},
        {'start_entity_rid': '#9:0'},
        {'start_entity_type': ['Person'], 'start_entity_properties': {'name': 'x'}},
    ])
    assert ids == {'P1', 'P2', 'P9'}
    assert graph_pg.start_entity_ids('graph_demo', []) == set()


# ----------------------------------------------------------------------
# 子图
# ----------------------------------------------------------------------


def test_select_edge_ids_cursor_semantics():
    levels = {3: 0, 5: 1, 7: 1, 2: 0}
    assert graph_pg._select_edge_ids(levels, limit=2, offset=0, cursor_id=4,
                                     prioritize_levels=False) == [5, 7]
    assert graph_pg._select_edge_ids(levels, limit=2, offset=1, cursor_id=None,
                                     prioritize_levels=False) == [3, 5]


def test_select_edge_ids_prioritizes_levels_when_no_pagination():
    levels = {i: 0 if i < 8 else 1 for i in range(10)}
    selected = graph_pg._select_edge_ids(levels, limit=10, offset=0, cursor_id=None,
                                         prioritize_levels=True)
    # 每层先配 5 条，再补余量：两层都进入结果
    assert len(selected) == 10
    level_of = [levels[edge_id] for edge_id in selected]
    assert level_of[:5] == [0] * 5 or level_of[:5] == [1] * 5
    assert set(level_of) == {0, 1}


def test_select_edge_ids_prioritize_sorts_by_level_with_offset():
    levels = {1: 2, 2: 0, 3: 1}
    selected = graph_pg._select_edge_ids(levels, limit=2, offset=1, cursor_id=None,
                                         prioritize_levels=True)
    assert selected == [3, 1]


def test_subgraph_without_seeds_returns_all_edges_and_vertices(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    edge_page = [('K1', 'Knows', 'P1', 'P2', '{"w": 1}', 1, 10, 11)]
    vertex_page = [('P1', 'Person', {}, 10), ('P2', 'Person', {}, 11)]
    state = {'n': 0}

    def fetchall():
        state['n'] += 1
        return edge_page if state['n'] == 1 else vertex_page

    cursor.fetchall = fetchall
    edge_rows, vertex_rows = graph_pg.subgraph(
        'graph_demo', None, 2, 'both', [], {}, [], 10, 0)
    assert edge_rows[0]['out_entity_id'] == 'P1'
    assert edge_rows[0]['in_entity_id'] == 'P2'
    assert [row['entity_id'] for row in vertex_rows] == ['P1', 'P2']


def test_subgraph_without_seeds_applies_cursor_and_vertex_groups(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    edge_page = [('K1', 'Knows', 'P1', 'P2', '{}', 1, 10, 11),
                 ('K2', 'Knows', 'P2', 'P3', '{}', 2, 11, 12)]
    vertex_page = [('P1', 'Person', {}, 10)]
    state = {'n': 0}

    def fetchall():
        state['n'] += 1
        return edge_page if state['n'] == 1 else vertex_page

    cursor.fetchall = fetchall
    edge_rows, _ = graph_pg.subgraph(
        'graph_demo', None, 2, 'bogus-direction', [], {}, [{'entity_type': ['Person']}],
        limit=1, offset=1, cursor='#1:0')
    # cursor 先过滤 id>1，再被 vertex_groups 过滤掉 P2-P3 的边
    assert edge_rows == []


def test_subgraph_with_seeds_walks_levels_and_returns_touched_vertices(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    edge_page = [('K1', 'Knows', 'P1', 'P2', '{}', 1, 10, 11)]
    vertex_page = [('P1', 'Person', {}, 10), ('P2', 'Person', {}, 11)]
    state = {'n': 0}

    def fetchall():
        state['n'] += 1
        if state['n'] == 1:
            return edge_page
        if state['n'] == 2:
            return []  # 第二层无边
        if state['n'] == 3:
            return edge_page  # 按 ids 取边
        return vertex_page

    cursor.fetchall = fetchall
    edge_rows, vertex_rows = graph_pg.subgraph(
        'graph_demo', {'P1'}, 2, 'both', [], {}, [], 10, 0, prioritize_levels=True)
    assert edge_rows and edge_rows[0]['edge_id'] == 'K1'
    assert {row['entity_id'] for row in vertex_rows} == {'P1', 'P2'}


def test_subgraph_with_seeds_no_edges_returns_seed_vertices(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    vertex_page = [('P1', 'Person', {}, 10)]
    state = {'n': 0}

    def fetchall():
        state['n'] += 1
        return [] if state['n'] == 1 else vertex_page

    cursor.fetchall = fetchall
    edge_rows, vertex_rows = graph_pg.subgraph(
        'graph_demo', {'P1'}, 1, 'out', [], {}, [], 10, 0)
    assert edge_rows == []
    assert [row['entity_id'] for row in vertex_rows] == ['P1']


def test_subgraph_direction_in_filters_by_target(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    captured = {}
    edge_page = [('K1', 'Knows', 'P1', 'P2', '{}', 1, 10, 11)]

    def fetchall():
        call = len(cursor.executed)
        if call == 1:
            captured['sql'], captured['params'] = cursor.executed[0]
            return edge_page
        return [] if call == 2 else [('P1', 'Person', {}, 10)]

    cursor.fetchall = fetchall
    graph_pg.subgraph('graph_demo', {'P1'}, 1, 'in', [], {}, [], 10, 0)
    sql, params = captured['sql'], captured['params']
    assert 'target_id = ANY(%s)' in sql
    assert params[0] == ['P1']


def test_subgraph_edge_type_and_property_filters_apply(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    captured = {}
    edge_page = [('K1', 'Knows', 'P1', 'P2', '{}', 1, 10, 11)]

    def fetchall():
        call = len(cursor.executed)
        if call == 1:
            captured['sql'], captured['params'] = cursor.executed[0]
            return edge_page
        return edge_page if call == 2 else [('P1', 'Person', {}, 10)]

    cursor.fetchall = fetchall
    graph_pg.subgraph('graph_demo', {'P1'}, 1, 'out', ['Knows'], {'w': 3}, [], 10, 0)
    sql, params = captured['sql'], captured['params']
    assert 'edge_type = ANY(%s)' in sql
    assert "properties->>'w' = %s" in sql
    assert params[0] == ['P1'] and params[1] == ['Knows'] and params[2] == 3


# ----------------------------------------------------------------------
# 杂项与身份辅助
# ----------------------------------------------------------------------


def test_vertices_by_matching_groups_delegates_to_query_vertices(kb):
    cursor = FakeCursor(FakeConn(), results=[('P1', 'Person', {}, 4)])
    kb(cursor)
    rows = graph_pg.vertices_by_matching_groups('graph_demo', [{'entity_type': ['Person']}])
    assert rows[0]['entity_id'] == 'P1'


def test_entity_names_falls_back_to_entity_id_when_name_missing(kb):
    cursor = FakeCursor(FakeConn(), results=[('P1', '张三'), ('P2', None), (None, 'x')])
    kb(cursor)
    names = graph_pg.entity_names('graph_demo', limit=5)
    assert names == [('P1', '张三'), ('P2', 'P2')]
    sql, params = cursor.executed[0]
    assert 'LIMIT %s' in sql and params == (5,)


def test_present_ids_validates_field_and_batches(kb):
    kb(FakeCursor(FakeConn(), results=[('P1',)]))
    assert graph_pg.present_ids('graph_demo', 'entity_id', ['P1', 'P2']) == {'P1'}
    kb(FakeCursor(FakeConn(), results=[('K1',)]))
    assert graph_pg.present_ids('graph_demo', 'edge_id', ['K1']) == {'K1'}
    assert graph_pg.present_ids('graph_demo', 'entity_id', []) == set()
    with pytest.raises(ValueError):
        graph_pg.present_ids('graph_demo', 'bogus', ['x'])


def test_graph_db_name_helpers():
    assert graph_pg.graph_db_name('abc') == 'graph_abc'
    assert graph_pg.extract_entity_id_from_rid('#1:0') == '#1:0'
    assert graph_pg.extract_entity_id_from_rid(None) is None
    assert graph_pg.extract_entity_id_from_rid('') is None
    assert graph_pg.extract_entity_type_from_id('Person_001') == 'Person'
    assert graph_pg.extract_entity_type_from_id('nounderscore') is None
    assert graph_pg.extract_entity_type_from_id(None) is None
    assert graph_pg.extract_entity_type_from_id('_leading') == ''


def test_table_names_and_ident_validation():
    assert graph_pg.vertex_table('graph_demo') == 'graph_demo_vertex'
    assert graph_pg.edge_table('graph_demo') == 'graph_demo_edge'
    with pytest.raises(Exception):
        graph_pg._ident('bad name; drop')


def test_ensure_database_exists_runs_ddl(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    assert graph_pg.ensure_database_exists(CLIENT) is True
    sql = cursor.executed[0][0]
    assert 'CREATE TABLE IF NOT EXISTS kb_index.graph_demo_vertex' in sql
    assert 'CREATE TABLE IF NOT EXISTS kb_index.graph_demo_edge' in sql


def test_is_database_exists_false_on_error(monkeypatch):
    monkeypatch.setattr('infrastructure.db.ddl.table_exists',
                        lambda name: (_ for _ in ()).throw(RuntimeError('down')))
    assert graph_pg.is_database_exists(CLIENT) is False


def test_count_entities_and_edges_none_when_missing(monkeypatch):
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: False)
    assert graph_pg.count_entities_and_edges('graph_demo') is None


def test_count_entities_and_edges_counts_both_tables(kb, monkeypatch):
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: True)
    cursor = FakeCursor(FakeConn(), results=[(7, 9)])
    kb(cursor)
    counts = graph_pg.count_entities_and_edges('graph_demo')
    assert counts == {'entityCount': 7, 'edgeCount': 9}

    kb(FakeCursor(FakeConn(), results=[(None, None)]))
    assert graph_pg.count_entities_and_edges('graph_demo') == {
        'entityCount': 0, 'edgeCount': 0}


def test_drop_database_runs_two_drops(kb):
    cursor = FakeCursor(FakeConn())
    kb(cursor)
    graph_pg.drop_database(CLIENT, 'graph_demo')
    sqls = [sql for sql, _params in cursor.executed]
    assert any('DROP TABLE IF EXISTS kb_index.graph_demo_edge' in sql for sql in sqls)
    assert any('DROP TABLE IF EXISTS kb_index.graph_demo_vertex' in sql for sql in sqls)


def test_client_repr_carries_dbname():
    assert repr(CLIENT) == "PgGraphClient('graph_demo')"
