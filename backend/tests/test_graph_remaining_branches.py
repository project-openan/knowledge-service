"""graph 域最后一批分支：graph_import_api 主流程、query_task_status、
write_service 的索引同步/删除兜底、schema_service 的 update 查重与 edge 属性循环、
graph_pg 的补漏、api.py 的检索 500 与 graph_download 体解析。

跑法::

    python -m pytest tests/test_graph_remaining_branches.py -q
"""

from __future__ import annotations

import json
import zipfile

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from shared.errors.api import KbApiError


# ----------------------------------------------------------------------
# graph_extract_service：任务状态查询成功路径
# ----------------------------------------------------------------------


def test_query_task_status_maps_row_and_dates(monkeypatch):
    from datetime import datetime

    from graph.repository import graph_extract_store
    from graph.service import graph_extract_service as svc

    monkeypatch.setattr(graph_extract_store, 'select_task', lambda task_id: {
        'id': 't-1', 'kb_id': 'kb1', 'schema_id': 's-1', 'operator_id': 5,
        'file_count': 2, 'status': 'COMPLETED', 'progress': 100,
        'error_message': None, 'result_file_path': '/tmp/out',
        'created_by': None,
        'created_at': datetime(2024, 1, 1, 8, 0, 5),
        'updated_at': datetime(2024, 1, 1, 9, 0, 0),
        'start_time': datetime(2024, 1, 1, 8, 0, 6),
        'finish_time': datetime(2024, 1, 1, 9, 0, 1)})
    row = svc.query_task_status('t-1')
    assert row['taskId'] == 't-1'
    assert row['status'] == 'COMPLETED'
    assert row['createdDate'] == '2024-01-01 08:00:05'
    assert row['finishTime'] == '2024-01-01 09:00:01'
    assert row['createdBy'] is None

    assert svc._format_date('raw-value') == 'raw-value'
    assert svc._format_date(None) is None


def test_query_task_status_missing_is_0004(monkeypatch):
    from graph.repository import graph_extract_store
    from graph.service import graph_extract_service as svc
    from shared.errors.api import KbValidationError

    monkeypatch.setattr(graph_extract_store, 'select_task', lambda task_id: None)
    with pytest.raises(KbValidationError) as caught:
        svc.query_task_status('ghost')
    assert 'graph.extract.task.not.exist' in caught.value.key
    assert caught.value.code == '0004'


# ----------------------------------------------------------------------
# graph_write_service：索引同步与删除的小分支
# ----------------------------------------------------------------------


def _kbase(table='graph_demo'):
    return {'kbase_id': 'kb-1', 'table_name': table, 'embedding_model': 'm'}


def test_sync_entity_index_skips_without_base_or_text(monkeypatch):
    from graph.repository import graph_pg
    from graph.service import graph_write_service as svc

    calls = []
    monkeypatch.setattr(graph_pg, 'get_entity_properties', lambda *a: {'name': 'x'})
    monkeypatch.setattr(svc, '_embed_one', lambda text, model: [0.1])
    # 没有 table_name → 直接返回
    svc._sync_entity_index({'kbase_id': 'kb'}, object(), 'P1', 'Person')
    # 文本为空（entity_type 空 + 属性全被剔）→ 不写向量
    monkeypatch.setattr(graph_pg, 'get_entity_properties', lambda *a: {})
    from graph.repository import graph_index_store
    monkeypatch.setattr(graph_index_store, 'upsert_vectors',
                        lambda *a, **k: calls.append(a))
    svc._sync_entity_index(_kbase(), object(), 'P1', '')
    assert calls == []


def test_sync_edge_index_skips_without_base(monkeypatch):
    from graph.service import graph_write_service as svc

    svc._sync_edge_index({'kbase_id': 'kb'}, object(), 'K1', 'Knows')  # 不抛


def test_delete_index_helpers_tolerate_errors(monkeypatch):
    from graph.repository import graph_index_store
    from graph.service import graph_write_service as svc

    # 无 table_name → 直接返回
    svc._delete_entity_index({'kbase_id': 'kb'}, 'P1')
    svc._delete_edge_index({'kbase_id': 'kb'}, 'K1')
    svc._delete_edge_index(_kbase(), None)

    calls = []
    monkeypatch.setattr(graph_index_store, 'delete_vector_keys',
                        lambda base, key_type, ids: calls.append((key_type, ids)))
    monkeypatch.setattr(graph_index_store, 'delete_edge_vectors_touching',
                        lambda base, ids: calls.append(('touching', ids)))
    svc._delete_entity_index(_kbase(), 'P1')
    svc._delete_edge_index(_kbase(), 'K1')
    assert ('entity', ['P1']) in calls and ('touching', ['P1']) in calls
    assert ('edge', ['K1']) in calls

    def boom(*a, **k):
        raise RuntimeError('index down')

    monkeypatch.setattr(graph_index_store, 'delete_vector_keys', boom)
    svc._delete_entity_index(_kbase(), 'P1')      # 只记日志
    svc._delete_edge_index(_kbase(), 'K1')


def test_delete_entity_failure_wraps(monkeypatch):
    from graph.repository import graph_pg
    from graph.service import graph_write_service as svc
    from knowledge_base.service import kbase_service as kbase_store

    payload = {'kbId': 'kb-1', 'entityId': 'Person_1', 'entityType': 'Person'}
    monkeypatch.setattr(kbase_store, 'get_kbase_row', lambda kb: {'kbase_id': 'kb-1'})
    monkeypatch.setattr(graph_pg, 'new_client', lambda name: {'name': name})
    monkeypatch.setattr(graph_pg, 'graph_db_name', lambda kb: f'graph_{kb}')
    monkeypatch.setattr(graph_pg, 'entity_exists', lambda *a: True)
    monkeypatch.setattr(graph_pg, 'delete_edges_by_entity', lambda *a: 0)
    monkeypatch.setattr(graph_pg, 'delete_entity',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    monkeypatch.setattr(svc, '_delete_entity_index', lambda *a, **k: None)
    with pytest.raises(KbApiError) as caught:
        svc.delete_entity(payload)
    assert 'entity.delete.failed' in caught.value.key
    assert caught.value.code == '0005'


def test_create_and_update_and_delete_edge_gaps(monkeypatch):
    from graph.repository import graph_pg
    from graph.service import graph_write_service as svc
    from knowledge_base.service import kbase_service as kbase_store

    SCHEMA = {
        'entities': [{'entity_type': 'Person', 'properties': []},
                     {'entity_type': 'Robot', 'properties': []}],
        'edges': [{'edge_type': 'Knows', 'source_entity': 'Person',
                   'target_entity': 'Robot', 'properties': []}],
    }
    # 「匹配上的定义引用了未声明实体」的两个专用 schema
    SOURCE_UNDEF = {
        'entities': [{'entity_type': 'Robot', 'properties': []}],
        'edges': [{'edge_type': 'Knows', 'source_entity': 'Person',
                   'target_entity': 'Person', 'properties': []}],
    }
    TARGET_UNDEF = {
        'entities': [{'entity_type': 'Person', 'properties': []}],
        'edges': [{'edge_type': 'Knows', 'source_entity': 'Person',
                   'target_entity': 'Robot', 'properties': []}],
    }
    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb: {'kbase_id': 'kb-1', 'schema_obj': SCHEMA})
    monkeypatch.setattr(graph_pg, 'new_client', lambda name: {'name': name})
    monkeypatch.setattr(graph_pg, 'graph_db_name', lambda kb: f'graph_{kb}')
    monkeypatch.setattr(graph_pg, 'edge_exists', lambda *a: False)
    monkeypatch.setattr(graph_pg, 'entity_exists', lambda *a: True)
    monkeypatch.setattr(graph_pg, 'add_edge', lambda *a: None)
    monkeypatch.setattr(graph_pg, 'get_edge_properties',
                        lambda *a: {'source_id': 'Person_1', 'target_id': 'Robot_1'})
    monkeypatch.setattr(svc, '_sync_edge_index', lambda *a, **k: None)
    monkeypatch.setattr(svc, '_delete_edge_index', lambda *a, **k: None)

    payload = {'kbId': 'kb-1', 'edgeId': 'Knows_1', 'edgeType': 'Knows',
               'sourceId': 'Person_1', 'targetId': 'Robot_1', 'properties': {}}
    assert svc.create_edge(payload)['success'] is True

    # 端点类型未在 schema 声明（定义匹配上了、但实体类型没声明）
    with pytest.raises(KbApiError) as caught:
        svc.create_edge(dict(payload, sourceId='Person_1', targetId='Alien_1'))
    assert 'edge.node.type.pair.mismatch' in caught.value.key

    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb: {'kbase_id': 'kb-1', 'schema_obj': SOURCE_UNDEF})
    with pytest.raises(KbApiError) as caught:
        svc.create_edge(dict(payload, sourceId='Person_1', targetId='Person_2'))
    assert 'edge.source.node.type.undefined' in caught.value.key

    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb: {'kbase_id': 'kb-1', 'schema_obj': TARGET_UNDEF})
    with pytest.raises(KbApiError) as caught:
        svc.create_edge(dict(payload, sourceId='Person_1', targetId='Robot_1'))
    assert 'edge.target.node.type.undefined' in caught.value.key
    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb: {'kbase_id': 'kb-1', 'schema_obj': SCHEMA})

    # add_edge 意外失败 → 0005
    monkeypatch.setattr(graph_pg, 'add_edge',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('down')))
    with pytest.raises(KbApiError) as caught:
        svc.create_edge(payload)
    assert 'edge.create.failed' in caught.value.key

    # update：边不存在
    monkeypatch.setattr(graph_pg, 'edge_exists', lambda *a: False)
    with pytest.raises(KbApiError) as caught:
        svc.update_edge({'kbId': 'kb-1', 'edgeId': 'Knows_1',
                         'edgeType': 'Knows', 'properties': {}})
    assert 'edge.not.exists' in caught.value.key

    # delete：不存在 → 业务异常；删除失败 → 0005
    with pytest.raises(KbApiError) as caught:
        svc.delete_edge({'kbId': 'kb-1', 'edgeId': 'Knows_1', 'edgeType': 'Knows'})
    assert 'edge.not.exists' in caught.value.key

    monkeypatch.setattr(graph_pg, 'edge_exists', lambda *a: True)
    monkeypatch.setattr(graph_pg, 'delete_edge',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('down')))
    with pytest.raises(KbApiError) as caught:
        svc.delete_edge({'kbId': 'kb-1', 'edgeId': 'Knows_1', 'edgeType': 'Knows'})
    assert 'edge.delete.failed' in caught.value.key


def test_validate_update_properties_with_empty_schema_properties():
    SCHEMA = {'entities': [{'entity_type': 'Person', 'properties': []}]}
    # schema 没声明属性：第二个循环仍跑 → 每个键都报 property.not.defined
    with pytest.raises(KbApiError) as caught:
        from graph.service import graph_write_service as svc
        svc._validate_update_properties(SCHEMA, 'Person', {'anything': 1}, 'entity')
    assert 'entity.property.not.defined' in caught.value.key


# ----------------------------------------------------------------------
# graph_schema_service：update 查重 / 边属性校验循环 / import 目录项
# ----------------------------------------------------------------------


def test_validate_edge_properties_checks_names_types_and_desc():
    from graph.service import graph_schema_service as svc

    properties = [{'name': 'since', 'type': 'INTEGER', 'desc': 'd'}]
    svc.validate_edge_properties(properties, 'Knows')
    with pytest.raises(KbApiError):
        svc.validate_edge_properties([{'name': '1x', 'type': 'INTEGER', 'desc': 'd'}],
                                     'Knows')
    with pytest.raises(KbApiError):
        svc.validate_edge_properties([{'name': 'since', 'type': 'INT', 'desc': 'd'}],
                                     'Knows')
    with pytest.raises(KbApiError):
        svc.validate_edge_properties([{'name': 'since', 'type': 'INTEGER',
                                       'desc': None}], 'Knows')


def test_update_schema_detects_name_owned_by_another_row(monkeypatch):
    from graph.repository import graph_schema_store
    from graph.service import graph_schema_service as svc

    rows = {
        's-1': {'schema_id': 's-1', 'schema_name': '甲', 'schema_obj': {
            'schema_id': 's-1', 'schema_name': '甲', 'schema_desc': 'd',
            'entities': [{'entity_type': 'Person', 'entity_desc': 'd',
                          'properties': [{'name': 'p', 'type': 'STRING', 'desc': 'd',
                                          'is_primary': True}]}],
            'edges': []}, 'created_by': 'u'},
        's-2': {'schema_id': 's-2', 'schema_name': '乙', 'schema_obj': {},
                'created_by': 'u'},
    }
    monkeypatch.setattr(graph_schema_store, 'get_schema_by_id',
                        lambda schema_id: rows.get(schema_id))
    monkeypatch.setattr(graph_schema_store, 'get_schema_by_name',
                        lambda name: next((row for row in rows.values()
                                           if row['schema_name'] == name), None))
    monkeypatch.setattr(graph_schema_store, 'update_schema', lambda **kw: 1)

    edges = rows['s-1']['schema_obj']['edges']
    # 改成别人占用的名字 → duplicate
    with pytest.raises(KbApiError) as caught:
        svc.update_schema({'schema_id': 's-1', 'schema_name': '乙', 'schema_desc': 'd',
                           'entities': rows['s-1']['schema_obj']['entities'],
                           'edges': edges}, 'u')
    assert 'graph.schema.name.duplicate' in caught.value.key

    # 改成自己的名字 → 放行
    result = svc.update_schema({'schema_id': 's-1', 'schema_name': '甲',
                                'schema_desc': 'd',
                                'entities': rows['s-1']['schema_obj']['entities'],
                                'edges': edges}, 'u')
    assert result == {'schema_name': '甲'}


def test_import_schema_skips_directory_entries_and_sizes(monkeypatch):
    import io

    from graph.repository import graph_schema_store
    from graph.service import graph_schema_service as svc

    doc = {'schema_id': 's-new', 'schema_name': '新模板', 'schema_desc': 'd',
           'entities': [{'entity_type': 'Person', 'entity_desc': 'd',
                         'properties': [{'name': 'p', 'type': 'STRING', 'desc': 'd',
                                         'is_primary': True}]}],
           'edges': []}
    monkeypatch.setattr(graph_schema_store, 'is_schema_exist', lambda i, n: False)
    monkeypatch.setattr(graph_schema_store, 'insert_schema', lambda **kw: None)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('dir/', b'')
        archive.writestr('doc.json', json.dumps(doc, ensure_ascii=False))
    result = svc.import_schema('b.zip', buffer.getvalue(), 'emp', None)
    assert result['successCount'] == 1

    # 解压总量超限
    big = io.BytesIO()
    with zipfile.ZipFile(big, 'w') as archive:
        archive.writestr('doc.json', b'x' * (svc.MAX_EXTRACT_SIZE_OF_MB * 1024 * 1024 + 1))
    with pytest.raises(KbApiError) as caught:
        svc.import_schema('b.zip', big.getvalue(), 'emp', None)
    assert 'file.size.limit.check' in caught.value.key


def test_decode_entry_name_fallbacks():
    import zipfile as _zip
    from graph.service import graph_schema_service as svc

    info = _zip.ZipInfo('plain.json')
    info.flag_bits = 0
    assert svc._decode_entry_name(info) == 'plain.json'

    # cp437/gbk 都解不动时原样返回
    weird = _zip.ZipInfo('ok.json')
    weird.flag_bits = 0x800
    weird.filename = 'ok.json'
    assert svc._decode_entry_name(weird) == 'ok.json'


# ----------------------------------------------------------------------
# graph_pg：补漏
# ----------------------------------------------------------------------


class _Cursor:
    def __init__(self, results=None, rowcount=1, error=None):
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


class _Conn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture()
def pg_conn(monkeypatch):
    from infrastructure.db import kb as db

    def install(cursor):
        conn = _Conn(cursor)
        monkeypatch.setattr(db, 'connection', lambda: conn)
        return cursor

    return install


def test_get_entity_and_edge_properties_found(pg_conn):
    from graph.repository import graph_pg

    cursor = pg_conn(_Cursor(results=[('P1', 'Person', '{"n": 1}', 4)]))
    row = graph_pg.get_entity_properties(graph_pg.new_client('graph_demo'),
                                         'Person', 'P1')
    assert row['n'] == 1 and row['@rid'] == '#4:0'
    sql, _params = cursor.executed[0]
    assert 'WHERE entity_id = %s' in sql

    cursor = pg_conn(_Cursor(results=[('K1', 'Knows', 'P1', 'P2', '{}', 5, 9, 10)]))
    row = graph_pg.get_edge_properties(graph_pg.new_client('graph_demo'),
                                       'Knows', 'K1')
    assert row['out'] == '#9:0' and row['in'] == '#10:0'


def test_add_edge_target_missing_is_kg012(pg_conn):
    from graph.repository import graph_pg
    from graph.errors import GraphException
    from graph.models.kg_struct import EdgeData

    calls = {'n': 0}

    class Two(_Cursor):
        def fetchone(self):
            calls['n'] += 1
            return (1,) if calls['n'] == 1 else None

    pg_conn(Two())
    with pytest.raises(GraphException) as caught:
        graph_pg.add_edge(graph_pg.new_client('graph_demo'),
                          EdgeData('K', 'Knows', 'P1', 'G1', {}))
    assert 'Target entity not found' in caught.value.args[0]


def test_upsert_edges_bulk_empty_and_labelless(pg_conn):
    from graph.repository import graph_pg

    cursor = _Cursor()
    pg_conn(cursor)
    graph_pg.upsert_edges_bulk('graph_demo', [])
    assert cursor.executed == []

    graph_pg.upsert_edges_bulk('graph_demo', [
        ('Knows', 'K1', 'P1', 'P2', {'w': 1}, []),
    ])
    assert len(cursor.executed) == 1


def test_edges_between_and_vertices_by(pg_conn):
    from graph.repository import graph_pg

    cursor = _Cursor(results=[])
    pg_conn(cursor)
    assert graph_pg.edges_between_entities('graph_demo', ['P1', 'P2']) == []
    sql, params = cursor.executed[0]
    assert 'source_id = ANY(%s)' in sql
    assert params == (['P1', 'P2'], ['P1', 'P2'])

    cursor = _Cursor(results=[('P1', 'Person', '{}', 3)])
    pg_conn(cursor)
    rows = graph_pg.vertices_by_entity_ids('graph_demo', ['P1'])
    assert rows[0]['entity_id'] == 'P1'


def test_start_entity_ids_resolves_rid_only(pg_conn, monkeypatch):
    from graph.repository import graph_pg

    cursor = _Cursor(results=[('P9',)])
    pg_conn(cursor)
    ids = graph_pg.start_entity_ids('graph_demo', [{'start_entity_rid': '#9:0'}])
    assert ids == {'P9'}


def test_subgraph_with_seeds_applies_vertex_group_filter(pg_conn, monkeypatch):
    from graph.repository import graph_pg

    cursor = _Cursor()
    pg_conn(cursor)
    pages = [
        [('K1', 'Knows', 'P1', 'P2', '{}', 1, 10, 11)],           # 层遍历
        [('K1', 'Knows', 'P1', 'P2', '{}', 1, 10, 11)],           # 按 ids 取边
        [('P1', 'Person', '{}', 10), ('P2', 'Person', '{}', 11)],  # 端点顶点
        [],                                                        # vertex_groups 查无实体
    ]
    state = {'n': 0}

    def fetchall():
        page = pages[min(state['n'], len(pages) - 1)]
        state['n'] += 1
        return page

    cursor.fetchall = fetchall
    edge_rows, _vertices = graph_pg.subgraph(
        'graph_demo', {'P1'}, 1, 'both', [], {}, [{'entity_type': ['Ghost']}],
        10, 0)
    # 两端都不在允许的顶点集合里 → 边被过滤光
    assert edge_rows == []


def test_count_entities_and_edges_fetchone_none(pg_conn, monkeypatch):
    from graph.repository import graph_pg

    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: True)
    pg_conn(_Cursor(results=[]))
    assert graph_pg.count_entities_and_edges('graph_demo') == {
        'entityCount': 0, 'edgeCount': 0}


# ----------------------------------------------------------------------
# graph_index_store：维度超限与索引重抛
# ----------------------------------------------------------------------


def test_ensure_vector_table_skips_hnsw_for_huge_dimension(monkeypatch):
    from graph.repository import graph_index_store as store
    from infrastructure.db import ddl


    class _Cursor:
        executed = []

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            _Cursor.executed.append(sql)

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(store, 'connection', lambda: _Conn())
    store.ensure_vector_table('g', ddl.HNSW_MAX_DIMENSIONS + 128, with_hnsw=True)
    ddl_sql = '\n'.join(_Cursor.executed)
    assert 'USING hnsw' not in ddl_sql          # 只 DROP，不建
    assert 'DROP INDEX IF EXISTS' in ddl_sql

    # 非法维度
    with pytest.raises(ValueError):
        store.ensure_vector_table('g', -1)


def test_ensure_vector_indexes_reraises_other_errors(monkeypatch):
    from graph.repository import graph_index_store as store

    def boom(base, parallel, with_hnsw=True):
        raise RuntimeError('disk quota')

    monkeypatch.setattr(store, '_create_indexes', boom)
    with pytest.raises(RuntimeError):
        store.ensure_vector_indexes('g')


def test_delete_chunks_without_vector_table(monkeypatch):
    from graph.repository import graph_index_store as store
    from infrastructure.db import ddl

    monkeypatch.setattr(ddl, 'table_exists', lambda name: name.endswith('_chunk'))
    monkeypatch.setattr(ddl, 'delete_chunks_by_source', lambda table, sources: 2)

    class _Cursor:
        def __init__(self):
            self.executed = []

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            self.executed.append((sql, params))

        def fetchall(self):
            return [('c1',)]

    conn = type('C', (), {'cursor': lambda self: _Cursor(),
                          '__enter__': lambda self: self,
                          '__exit__': lambda self, *e: False})()
    monkeypatch.setattr(store, 'connection', lambda: conn)
    assert store.delete_chunks_by_sources('g', ['a.md']) == 2


def test_allowed_coerces_ids_to_str():
    from graph.repository import graph_index_store as store

    assert store._allowed({'7': {'P1'}}, 7, 'P1') is True
    assert store._allowed({'Person': set()}, 'Person', 42) is False


def test_entity_mention_cap_breaks_at_limit():
    from graph.service.entity_mention import build_mention_trie, find_mentions

    names = [(f'E{i}', f'Entity Number {i}') for i in range(6)]
    trie = build_mention_trie(names)
    found = find_mentions('Entity Number 0 Entity Number 1 Entity Number 2 '
                          'Entity Number 3 Entity Number 4 Entity Number 5',
                          trie, max_mentions=3)
    assert len(found) == 3


# ----------------------------------------------------------------------
# task_runtime / api.py
# ----------------------------------------------------------------------


def test_start_and_shutdown_are_noop_in_memory_mode():
    from graph import task_runtime

    task_runtime.start()
    task_runtime.shutdown(0)


def test_graph_retrieve_route_unexpected_error_is_problem():
    from graph import api as graph_api
    from graph.service import graph_retrieve_gateway as gateway
    from shared.prefixes import RKB_PREFIX

    app = FastAPI()
    app.include_router(graph_api.build_router(), prefix=RKB_PREFIX)
    client = TestClient(app)

    original = gateway.retrieve_result

    def boom(dto, headers):
        raise RuntimeError('unexpected')

    gateway.retrieve_result = boom
    try:
        response = client.post(f'{RKB_PREFIX}/retrieval/graph', json={
            'query': 'q', 'embedding': 'm', 'bases': ['graph_kb1']})
    finally:
        gateway.retrieve_result = original
    assert response.status_code == 500
    assert response.headers['content-type'].startswith('application/problem+json')


def test_graph_download_parses_body_when_payload_absent():
    from graph import api as graph_api
    from shared.prefixes import RKB_PREFIX

    app = FastAPI()

    @app.post(f'{RKB_PREFIX}/echo-export')
    async def route(request: Request):
        return await graph_api.graph_download(
            request, lambda payload: (b'data', 'x.zip'))

    client = TestClient(app)

    response = client.post(f'{RKB_PREFIX}/echo-export', json={'kbId': 'kb1'})
    assert response.status_code == 200, response.text
    assert response.content == b'data'

    # 非法 JSON 体 → 400 malformed_request
    response = client.post(f'{RKB_PREFIX}/echo-export', content=b'not json',
                           headers={'content-type': 'application/json'})
    assert response.status_code == 400

    # 没带 Content-Type → 415
    response = client.post(f'{RKB_PREFIX}/echo-export', content=b'{"kbId": "kb"}')
    assert response.status_code == 415
