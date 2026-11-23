"""graph_query_service：路径提取的内存匹配矩阵 + GraphQueryService 的检索流程。

`extract_paths` 是纯函数，把「操作符在内存里怎么判」逐个钉死（与 SQL 语义对照）；
`GraphQueryService` 用桩 repository / 桩向量池走通 retrieve_graph 全链路与错误分支。

跑法::

    python -m pytest tests/test_graph_query_service_paths.py -q
"""

from __future__ import annotations

import time

import pytest

from graph.service import graph_query_service as gqs
from graph.service.graph_query_service import extract_paths
from graph.models.graph_query_dto import GraphQueryDto, GraphFilter
from graph.models.graph_retrieve_dto import GraphRetrieveDto
from shared.errors.exception import EMException


# ----------------------------------------------------------------------
# extract_paths：操作符匹配
# ----------------------------------------------------------------------


def _entities(*specs):
    out = []
    for rid, props in specs:
        row = {'@rid': rid}
        row.update(props)
        out.append(row)
    return out


def _one_path(entities, edges, conditions):
    return extract_paths(entities, edges, conditions, max_depth=5)


def _chain_edges(*rids):
    """把 `#a:0 -> #b:0 -> ...` 串成边列表。"""
    edges = []
    for i in range(len(rids) - 1):
        edges.append({'@rid': f'#e{i}:0', 'out': rids[i], 'in': rids[i + 1]})
    return edges


def test_paths_forward_and_reverse_directions():
    entities = _entities(('#a:0', {'name': 'A'}), ('#b:0', {'name': 'B'}),
                         ('#c:0', {'name': 'C'}))
    edges = _chain_edges('#a:0', '#b:0', '#c:0')
    paths = extract_paths(entities, edges, {'_use_in_degree_zero': True})
    # 有出边的节点不产出「单节点路径」—— DFS 只在叶子处收口
    node_sets = {tuple(path['nodes']) for path in paths}
    assert node_sets == {('#a:0', '#b:0', '#c:0')}


def test_paths_reverse_walk_from_start_reaches_upstream():
    entities = _entities(('#a:0', {}), ('#b:0', {}))
    edges = [{'@rid': '#e0:0', 'out': '#a:0', 'in': '#b:0'}]
    # 起点 #b:0 有入边：反向遍历产出到达它的路径
    paths = extract_paths(entities, edges, {'@rid': '#b:0'})
    assert any(path['nodes'] == ['#a:0', '#b:0'] for path in paths)


def test_max_depth_truncates_exploration():
    entities = _entities(('#a:0', {}), ('#b:0', {}), ('#c:0', {}))
    edges = _chain_edges('#a:0', '#b:0', '#c:0')
    paths = extract_paths(entities, edges, {'_use_in_degree_zero': True}, max_depth=2)
    assert all(len(path['nodes']) <= 2 for path in paths)


def test_cycle_is_cut_by_visited_mask():
    entities = _entities(('#a:0', {}), ('#b:0', {}))
    edges = [{'@rid': '#e0:0', 'out': '#a:0', 'in': '#b:0'},
             {'@rid': '#e1:0', 'out': '#b:0', 'in': '#a:0'}]
    paths = extract_paths(entities, edges, {'_use_in_degree_zero': True}, max_depth=10)
    assert all(len(set(path['nodes'])) == len(path['nodes']) for path in paths)


def test_matched_nodes_without_outgoing_fall_back_to_in_degree_zero():
    entities = _entities(('#a:0', {'kind': 'leaf'}), ('#b:0', {'kind': 'root'}))
    edges = [{'@rid': '#e0:0', 'out': '#b:0', 'in': '#a:0'}]
    paths = _one_path(entities, edges, {'kind': 'leaf'})
    # 'leaf' 无出边且未显式指定起点 → 回退到入度 0 的 #b:0
    assert paths and paths[0]['nodes'][0] == '#b:0'


def test_list_start_conditions_union_their_matches():
    entities = _entities(('#a:0', {'n': 1}), ('#b:0', {'n': 2}),
                         ('#c:0', {'n': 3}), ('#d:0', {'n': 4}))
    edges = _chain_edges('#a:0', '#b:0') + _chain_edges('#c:0', '#d:0')
    paths = extract_paths(entities, edges, [{'n': 1}, {'n': 3}])
    starts = {path['nodes'][0] for path in paths}
    assert starts == {'#a:0', '#c:0'}


@pytest.mark.parametrize('spec, expected', [
    ({'n': {'op': 'eq', 'value': 1}}, True),
    ({'n': {'op': 'ne', 'value': 1}}, False),
    ({'n': {'op': 'gt', 'value': 0}}, True),
    ({'n': {'op': 'gt', 'value': 1}}, False),
    ({'n': {'op': 'gte', 'value': 1}}, True),
    ({'n': {'op': 'gte', 'value': 2}}, False),
    ({'n': {'op': 'lt', 'value': 2}}, True),
    ({'n': {'op': 'lt', 'value': 1}}, False),
    ({'n': {'op': 'lte', 'value': 1}}, True),
    ({'n': {'op': 'lte', 'value': 0}}, False),
    ({'n': {'op': 'gt', 'value': 0.5}}, True),
    ({'name': {'op': 'gt', 'value': 1}}, False),       # 非数值不参与数值比较
    ({'name': {'op': 'like', 'value': 'Al%'}}, True),
    ({'name': {'op': 'like', 'value': 'a_l'}}, False),  # 'a.l' 不命中 'Alice'
    ({'name': {'op': 'like', 'value': '%lic%'}}, True),
    ({'name': {'op': 'like', 'value': '%'}}, True),
    ({'name': {'op': 'like', 'value': 5}}, False),     # 非字符串模式
    ({'n': {'op': 'in', 'value': [1, 2]}}, True),
    ({'n': {'op': 'in', 'value': 'nope'}}, False),     # 非 list
    ({'n': {'op': 'in', 'value': [2]}}, False),
    ({'n': {'op': 'between', 'value': [1, 3]}}, True),
    ({'n': {'op': 'between', 'value': [2, 3]}}, False),
    ({'n': {'op': 'between', 'value': [1]}}, False),
    ({'tags': {'op': 'contains', 'value': 'vip'}}, False),
    ({'tags': {'op': 'contains', 'value': 'a'}}, True),
    ({'tags': {'op': 'contains', 'value': 'x'}}, False),
    ({'n': {'op': 'contains', 'value': 'vip'}}, False),  # 非列表实体值
    ({'tags': {'op': 'contains', 'value': {'nested': 1}}}, False),  # 嵌套条件不支持
    ({'tags': {'op': 'contains_all', 'value': ['a', 'b']}}, True),
    ({'tags': {'op': 'contains_all', 'value': ['a', 'c']}}, False),
    ({'tags': {'op': 'contains_all', 'value': 'a'}}, False),
    ({'tags': {'op': 'contains_any', 'value': ['c', 'b']}}, True),
    ({'tags': {'op': 'contains_any', 'value': ['c']}}, False),
    ({'n': {'op': 'mystery', 'value': 1}}, False),     # 未知操作符
    ({'n': [1, 9]}, True),                              # 列表值：成员判断
    ({'n': [2, 9]}, False),
    ({'n': 1}, True),
    ({'n': 2}, False),
    ({'missing': None}, True),                          # 行里没有的键 == None
])
def test_match_operator_semantics(spec, expected):
    entity = {'@rid': '#a:0', 'n': 1, 'name': 'Alice', 'tags': ['a', 'b']}
    start = extract_paths([entity], [], [dict(spec)])
    assert bool(start) is expected


def test_like_falls_back_to_literal_match_on_regex_escape():
    # `%` 转成 `.*`，`.` 保留：普通 like 语义命中
    entity = {'@rid': '#a:0', 'name': 'a.c'}
    assert extract_paths([entity], [], [{'name': {'op': 'like', 'value': 'a.c'}}])
    assert extract_paths([entity], [], [{'name': {'op': 'like', 'value': 'a%c'}}])


def test_paths_ignore_edges_with_unknown_endpoints():
    entities = _entities(('#a:0', {}), ('#b:0', {}))
    edges = [{'@rid': '#e0:0', 'out': '#ghost:0', 'in': '#b:0'},
             {'@rid': '#e1:0', 'out': '#a:0', 'in': '#b:0'},
             {'@rid': 'bad-rid', 'out': '#a:0', 'in': '#b:0'}]
    paths = extract_paths(entities, edges, {'_use_in_degree_zero': True})
    assert paths and paths[0]['nodes'] == ['#a:0', '#b:0']
    assert paths[0]['edges'] == ['#e1:0']


# ----------------------------------------------------------------------
# 模块级小函数
# ----------------------------------------------------------------------


def test_env_int_parses_and_falls_back(monkeypatch):
    monkeypatch.setenv('GRAPH_TEST_INT', '7')
    assert gqs._env_int('GRAPH_TEST_INT', 1) == 7
    monkeypatch.setenv('GRAPH_TEST_INT', 'bogus')
    assert gqs._env_int('GRAPH_TEST_INT', 3) == 3
    monkeypatch.setenv('GRAPH_TEST_INT', '')
    assert gqs._env_int('GRAPH_TEST_INT', 3) == 3
    assert gqs._env_int('GRAPH_TEST_INT_UNSET', 4) == 4


def test_validate_graph_base_whitelist():
    assert gqs._validate_graph_base('graph_abc123') == 'graph_abc123'
    with pytest.raises(ValueError):
        gqs._validate_graph_base('graph_a; drop')
    with pytest.raises(ValueError):
        gqs._validate_graph_base(None)
    with pytest.raises(ValueError):
        gqs._validate_graph_base('demo')


# ----------------------------------------------------------------------
# GraphQueryService：检索流程
# ----------------------------------------------------------------------

SCHEMA = {
    'entities': [{'entity_type': 'Person', 'properties': [
        {'name': 'entity_id', 'type': 'STRING', 'is_primary': True}]}],
    'edges': [],
}


class _Headers:
    def __init__(self, language='en'):
        self._language = language

    def get_language_option(self):
        return self._language


def _retrieve_dto(**overrides):
    payload = {'query': 'who', 'embedding': 'm', 'bases': ['graph_demo']}
    payload.update(overrides)
    return GraphRetrieveDto(**payload)


@pytest.fixture()
def service():
    return gqs.GraphQueryService()


def test_service_constructs_without_db(service):
    assert service.pg_db.dbname == 'rag_studio'


def test_check_kb_db_exists_delegates_to_pg(service, monkeypatch):
    from graph.repository import graph_pg
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: True)
    assert service.check_kb_db_exists('graph_demo') is True


def test_get_query_embedding_wraps_instruction(service, monkeypatch):
    captured = {}

    def fake_embedding(query, model, headers):
        captured['query'] = query
        return 'vec'

    monkeypatch.setattr(gqs.llmgateway_service, 'get_embedding_info', fake_embedding)
    embedding = service._get_query_embedding(_retrieve_dto(query='who'), _Headers())
    assert embedding == 'vec'
    assert captured['query'].startswith('Instruct:')


def test_get_query_embedding_failure_maps_to_em_exception(service, monkeypatch):
    def boom(*_args):
        raise RuntimeError('gateway down')

    monkeypatch.setattr(gqs.llmgateway_service, 'get_embedding_info', boom)
    with pytest.raises(EMException) as caught:
        service._get_query_embedding(_retrieve_dto(), _Headers())
    assert caught.value.err_code == 'embedding-service-error'


def test_get_query_embedding_keeps_prefixed_query_as_is(service, monkeypatch):
    monkeypatch.setattr(gqs.llmgateway_service, 'get_embedding_info',
                        lambda query, model, headers: query)
    embedding = service._get_query_embedding(
        _retrieve_dto(query='Instruct: X\nQuery: y'), _Headers())
    assert embedding.startswith('Instruct:')


def test_get_i18n_error_message_languages(service):
    assert service._get_i18n_error_message('kb-not-exists', 'zh') == '知识库不存在'
    assert service._get_i18n_error_message('kb-not-exists', 'en') == \
        'Knowledge base does not exist'
    assert service._get_i18n_error_message('kb-not-exists', 'fr') == \
        'Knowledge base does not exist'
    assert service._get_i18n_error_message('unknown-code', 'zh') == '未知错误'
    assert service._get_i18n_error_message('unknown-code', 'en') == 'Unknown error'


def test_create_empty_base_result_with_and_without_error(service):
    empty = service._create_empty_base_result('graph_demo')
    assert empty['entity_count'] == 0 and 'error' not in empty
    assert service._create_empty_base_result('b', 'oops')['error'] == 'oops'


def test_build_retrieve_result_counts(service):
    result = service._build_retrieve_result(
        [{'entity_count': 2, 'edge_count': 3}], 2, 3, _retrieve_dto(bases=['a', 'b']))
    assert result['base_count'] == 2
    assert result['total_entities'] == 2


def test_filter_system_fields_for_retrieve(service):
    filtered = service._filter_system_fields_for_retrieve({
        '@rid': '#1:0', '@class': 'Person', 'out': '#1:0', 'in': '#2:0',
        'out_Knows': '#2:0', 'in_Knows': '#1:0', 'name': 'x', 'entity_id': 'P_1'})
    assert filtered == {'name': 'x', 'entity_id': 'P_1'}


def test_collect_chunk_ids_from_entities_dedupes_and_splits(service):
    ids = service._collect_chunk_ids_from_entities([
        {'chunk_id': 'c1, c2'}, {'chunk_id': 'c2'}, {'chunk_id': ''}, {}])
    assert set(ids) == {'c1', 'c2'}


def test_expand_property_combinations_on_service(service):
    assert service._expand_property_combinations({'a': [1, 2], 'b': 'x', 'c': {
        'op': 'eq', 'value': 1}}) == [
        {'c': {'op': 'eq', 'value': 1}, 'a': 1, 'b': 'x'},
        {'c': {'op': 'eq', 'value': 1}, 'a': 2, 'b': 'x'},
    ]
    assert service._expand_property_combinations({}) == [{}]


def test_build_start_conditions_for_paths_with_rid_and_types(service):
    dto = GraphQueryDto(kb_id='graph_demo', query_type='path', filters=[
        GraphFilter(start_entity_type=['Person'], start_entity_properties={'n': ['a', 'b']},
                    start_entity_rid='#3:0'),
    ])
    conditions = service._build_start_conditions_for_paths(dto)
    assert conditions == [
        {'@rid': '#3:0', '@class': 'Person', 'n': 'a'},
        {'@rid': '#3:0', '@class': 'Person', 'n': 'b'},
    ]


def test_build_start_conditions_defaults_to_in_degree_zero(service):
    dto = GraphQueryDto(kb_id='graph_demo', query_type='path', filters=[])
    assert service._build_start_conditions_for_paths(dto) == {'_use_in_degree_zero': True}


def test_convert_subgraph_response_skip_pagination(service):
    dto = GraphQueryDto(kb_id='graph_demo', query_type='sub_graph', limit=1, offset=3)
    response = service._convert_subgraph_to_response(
        {'entities': [{'@rid': '#1:0'}], 'edges': [{'@rid': '#9:0'}]}, dto,
        include_paths=False)
    assert response['total'] == 1
    assert response['has_more'] is True
    assert response['offset'] == 3 and response['limit'] == 1
    assert 'next_cursor' not in response


def test_convert_subgraph_response_cursor_pagination(service):
    dto = GraphQueryDto(kb_id='graph_demo', query_type='sub_graph', limit=1, cursor='#1:0')
    response = service._convert_subgraph_to_response(
        {'entities': [], 'edges': [{'@rid': '#9:9'}]}, dto, include_paths=False)
    assert response['next_cursor'] == '#9:9'
    assert response['has_more'] is True

    # 没满一页时**不给** next_cursor，只给 has_more=False
    dto = GraphQueryDto(kb_id='graph_demo', query_type='sub_graph', limit=5, cursor='#1:0')
    response = service._convert_subgraph_to_response(
        {'entities': [], 'edges': [{'@rid': '#9:9'}]}, dto, include_paths=False)
    assert 'next_cursor' not in response
    assert response['has_more'] is False


def test_convert_subgraph_response_paths_from_start_conditions(service):
    entities = [{'@rid': '#a:0', 'name': 'A'}, {'@rid': '#b:0', 'name': 'B'}]
    edges = [{'@rid': '#e0:0', 'out': '#a:0', 'in': '#b:0'}]
    dto = GraphQueryDto(kb_id='graph_demo', query_type='sub_graph', filters=[
        GraphFilter(start_entity_rid='#a:0')], limit=10)
    response = service._convert_subgraph_to_response(
        {'entities': entities, 'edges': edges}, dto, include_paths=True)
    assert response['paths'] == [{'nodes': ['#a:0', '#b:0'], 'edges': ['#e0:0']}]


def test_convert_subgraph_response_tolerates_non_list_payload(service):
    dto = GraphQueryDto(kb_id='graph_demo', query_type='sub_graph', limit=10)
    response = service._convert_subgraph_to_response({'entities': None, 'edges': 'x'},
                                                     dto, include_paths=False)
    assert response['entities'] == [] and response['edges'] == []


def test_query_subgraph_pops_temp_columns(service, monkeypatch):
    from graph.repository import graph_pg
    monkeypatch.setattr(graph_pg, 'start_entity_ids', lambda base, filters: {'P1'})
    monkeypatch.setattr(graph_pg, 'subgraph', lambda *args, **kwargs: ([
        {'@rid': '#e0:0', 'out': '#a:0', 'in': '#b:0', 'out_entity_id': 'P1',
         'in_entity_id': 'P2'},
    ], [{'@rid': '#a:0'}]))
    monkeypatch.setattr('infrastructure.db.connection_info.get_db_conn_info',
                        lambda: {'database': 'rag_studio'})
    dto = GraphQueryDto(kb_id='graph_demo', query_type='sub_graph', depth=2,
                        direction='both', limit=5, offset=0, prioritize_levels=True)
    response = service._query_subgraph(dto, include_paths=False)
    assert response['edges'] == [{'@rid': '#e0:0', 'out': '#a:0', 'in': '#b:0'}]
    assert response['total'] == 1


def test_query_subgraph_collects_edge_filters_from_dto(service, monkeypatch):
    from graph.repository import graph_pg
    captured = {}

    def fake_subgraph(base, seeds, depth, direction, edge_types, edge_properties,
                      vertex_groups, limit, offset, cursor=None, **kwargs):
        captured.update({'seeds': seeds, 'edge_types': edge_types,
                         'edge_properties': edge_properties,
                         'vertex_groups': vertex_groups, 'cursor': cursor,
                         'prioritize': kwargs.get('prioritize_levels')})
        return [], []

    monkeypatch.setattr(graph_pg, 'start_entity_ids', lambda base, filters: set())
    monkeypatch.setattr(graph_pg, 'subgraph', fake_subgraph)
    dto = GraphQueryDto(kb_id='graph_demo', query_type='sub_graph', depth=3,
                        direction='out', filters=[GraphFilter(
                            path_edge_type=['Knows', 'Knows'],
                            path_edge_properties={'w': 1},
                            path_entity_type=['Person'],
                            path_entity_properties={'n': 'x'})],
                        cursor='#4:0', prioritize_levels=False)
    service._query_subgraph(dto, include_paths=False)
    assert captured['edge_types'] == ['Knows']
    assert captured['edge_properties'] == {'w': 1}
    assert captured['vertex_groups'] == [{'entity_type': ['Person'], 'properties': {'n': 'x'}}]
    assert captured['cursor'] == '#4:0'
    assert captured['prioritize'] is False


def test_retrieve_single_base_rejects_illegal_base(service):
    result = service._retrieve_single_base('bad base', 'vec', _retrieve_dto(), 'zh')
    assert result['error'] == '图数据库不存在'
    assert result['entity_count'] == 0


def test_retrieve_single_base_reports_missing_db(service, monkeypatch):
    from graph.repository import graph_pg
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: False)
    result = service._retrieve_single_base('graph_demo', 'vec', _retrieve_dto(), 'en')
    assert result['error'] == 'Graph database does not exist'


def test_retrieve_single_base_chunks_only_when_no_entity_seeds(service, monkeypatch):
    from graph.repository import graph_pg
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: True)
    monkeypatch.setattr(graph_pg, 'entity_names', lambda base, limit: [])
    monkeypatch.setattr(service, '_retrieve_seed_ids',
                        lambda base, embedding, dto: ([], ['c1']))
    monkeypatch.setattr(service, '_query_chunks_by_ids',
                        lambda base, ids: {'c1': {'chunk_id': 'c1'}})
    result = service._retrieve_single_base('graph_demo', 'vec', _retrieve_dto(), 'zh')
    assert result['seed_entity_ids'] == []
    assert result['chunk_count'] == 1
    assert result['entities'] == []


def test_retrieve_single_base_empty_without_any_seed(service, monkeypatch):
    from graph.repository import graph_pg
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: True)
    monkeypatch.setattr(graph_pg, 'entity_names', lambda base, limit: [])
    monkeypatch.setattr(service, '_retrieve_seed_ids',
                        lambda base, embedding, dto: ([], []))
    result = service._retrieve_single_base('graph_demo', 'vec', _retrieve_dto(), 'zh')
    assert result == service._create_empty_base_result('graph_demo')


def test_retrieve_single_base_full_flow_strips_entity_chunks(service, monkeypatch):
    from graph.repository import graph_pg
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: True)
    monkeypatch.setattr(graph_pg, 'entity_names', lambda base, limit: [])
    monkeypatch.setattr(service, '_retrieve_seed_ids',
                        lambda base, embedding, dto: (['P1'], ['c1']))
    monkeypatch.setattr(service, '_retrieve_subgraph_for_base', lambda base, seeds, dto: {
        'base': base, 'entities': [{'entity_id': 'P1', 'chunks': ['x']}],
        'edges': [], 'entity_count': 1, 'edge_count': 0})
    monkeypatch.setattr(service, '_query_chunks_by_ids',
                        lambda base, ids: {'c1': {'chunk_id': 'c1'}, 'c9': {'chunk_id': 'c9'}})
    result = service._retrieve_single_base('graph_demo', 'vec', _retrieve_dto(), 'zh')
    assert result['chunks'] == {'c1': {'chunk_id': 'c1'}, 'c9': {'chunk_id': 'c9'}}
    assert result['chunk_count'] == 2
    assert result['seed_entity_ids'] == ['P1']
    assert 'chunks' not in result['entities'][0]


def test_retrieve_subgraph_for_base_maps_errors_to_empty(service, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError('down')

    monkeypatch.setattr(service, '_query_subgraph', boom)
    result = service._retrieve_subgraph_for_base('graph_demo', ['P1'], _retrieve_dto())
    assert result['error'] == 'down'
    assert result['entity_count'] == 0


def test_query_vector_index_passes_labels_only_for_entity_edge(service, monkeypatch):
    captured = {}

    def fake_pool(sql, params):
        captured['sql'] = sql
        captured['params'] = params
        return True, []

    class _Pool:
        pg_select_zip_values_operator_with_params = staticmethod(fake_pool)

    monkeypatch.setattr(gqs, '_db_pool', _Pool())
    dto = _retrieve_dto(labels=['Person'])
    service._query_vector_index('graph_demo', 'entity', 'vec', dto)
    assert 'labels && %s::text[]' in captured['sql']
    assert ['Person'] in captured['params']

    service._query_vector_index('graph_demo', 'chunk', 'vec', dto, seed_k=50)
    assert 'labels' not in captured['sql']


def test_query_vector_index_tolerates_failed_status(service, monkeypatch):
    class _Pool:
        def pg_select_zip_values_operator_with_params(self, sql, params):
            return False, 'error'

    monkeypatch.setattr(gqs, '_db_pool', _Pool())
    rows = service._query_vector_index('graph_demo', 'entity', 'vec', _retrieve_dto())
    assert rows == []


def test_extract_entity_ids_from_records(service):
    records = [{'key_id': 'P1'},
               {'key_id': 'K1', 'source_id': 'P1', 'target_id': 'P2'},
               {'key_id': 'K2', 'source_id': None, 'target_id': 'P2'},
               {'key_id': None}]
    assert service._extract_entity_ids_from_records(records, 'edge') == \
        ['P1', 'P2', 'P2']
    # entity：只要有 key_id 就收（边行的 key_id 是 edge_id，也照收 —— 上游不区分）
    assert service._extract_entity_ids_from_records(records, 'entity') == \
        ['P1', 'K1', 'K2']


def test_query_chunks_by_ids_maps_rows(service, monkeypatch):
    class _Pool:
        def pg_select_zip_values_operator_with_params(self, sql, params):
            assert 'id = ANY(%s)' in sql
            assert params == (['c1', 'c2'],)
            return True, [{'id': 'c1', 'source': 'a.md', 'chunk_order': 1,
                           'spilt_type': 'system', 'text': '正文', 'label': 'L',
                           'table_name': 't', 'table_id': '1'}]

    monkeypatch.setattr(gqs, '_db_pool', _Pool())
    chunks = service._query_chunks_by_ids('graph_demo', ['c1', 'c2', ' '])
    assert chunks['c1']['source'] == 'a.md'
    assert 'c2' not in chunks
    assert service._query_chunks_by_ids('graph_demo', []) == {}


def test_query_chunks_by_ids_handles_failure(service, monkeypatch):
    class _Pool:
        def pg_select_zip_values_operator_with_params(self, sql, params):
            return False, 'boom'

    monkeypatch.setattr(gqs, '_db_pool', _Pool())
    assert service._query_chunks_by_ids('graph_demo', ['c1']) == {}
    with pytest.raises(ValueError):
        service._query_chunks_by_ids('bad base', ['c1'])


def test_build_subgraph_query_for_seeds_uses_depth_defaults(service):
    dto = service._build_subgraph_query_for_seeds('graph_demo', ['P1'],
                                                  _retrieve_dto(depth=2, limit=1000))
    assert dto.filters[0].start_entity_properties == {'entity_id': ['P1']}
    assert dto.depth == 2
    assert dto.limit == gqs._DEPTH_LIMIT_DEFAULTS[2]
    assert dto.prioritize_levels is True

    custom = service._build_subgraph_query_for_seeds('graph_demo', ['P1'],
                                                     _retrieve_dto(depth=3, limit=77))
    assert custom.limit == 77


def test_retrieve_graph_aggregates_bases(service, monkeypatch):
    monkeypatch.setattr(service, '_get_query_embedding', lambda dto, headers: 'vec')
    monkeypatch.setattr(service, '_retrieve_single_base',
                        lambda base, vec, dto, lang: {
                            'base': base, 'entity_count': 2, 'edge_count': 1})
    result = service.retrieve_graph(
        _retrieve_dto(bases=['graph_demo', 'graph_other']), _Headers('zh'))
    assert result['base_count'] == 2
    assert result['total_entities'] == 4
    assert result['total_edges'] == 2
    assert [item['base'] for item in result['base_results']] == \
        ['graph_demo', 'graph_other']


# ----------------------------------------------------------------------
# 词面缓存
# ----------------------------------------------------------------------


def test_entity_mention_trie_caches_and_evicts(service, monkeypatch):
    from graph.repository import graph_pg
    gqs._MENTION_CACHE.clear()
    builds = {'n': 0}

    def fake_names(base, limit):
        builds['n'] += 1
        return [('P1', 'Alice')]

    monkeypatch.setattr(graph_pg, 'entity_names', fake_names)
    trie = service._entity_mention_trie('graph_demo')
    assert service._entity_mention_trie('graph_demo') is trie
    assert builds['n'] == 1

    # 过期后重建
    stamp = time.time() - gqs._MENTION_CACHE_TTL - 1
    gqs._MENTION_CACHE['graph_demo'] = (stamp, trie)
    service._entity_mention_trie('graph_demo')
    assert builds['n'] == 2

    # 超容量时清空
    now = time.time()
    for index in range(gqs._MENTION_CACHE_MAX_BASES):
        gqs._MENTION_CACHE[f'base_{index}'] = (now, {})
    service._entity_mention_trie('brand_new_base')
    assert 'base_0' not in gqs._MENTION_CACHE
    gqs._MENTION_CACHE.clear()


def test_lexical_seed_entity_ids_disabled_by_env(service, monkeypatch):
    monkeypatch.setenv('GRAPH_LEXICAL_SEEDS_ENABLED', '0')
    assert service._lexical_seed_entity_ids('graph_demo', 'Alice') == []
    assert service._lexical_seed_entity_ids('graph_demo', '') == []
