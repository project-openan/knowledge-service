"""graph_query_api.query 的四条 query_type 分派与状态守卫（桩 kbase / 图存储）。

跑法::

    python -m pytest tests/test_graph_query_api_flows.py -q
"""

from __future__ import annotations

import pytest

from graph.service import graph_query_api as api
from shared.errors.api import KbApiError

SCHEMA = {
    'entities': [{'entity_type': 'Person', 'properties': [
        {'name': 'name', 'type': 'STRING', 'is_primary': True}]}],
    'edges': [{'edge_type': 'Knows', 'properties': []}],
}

VERTEX_ROW = {'@rid': '#1:0', '@class': 'Person', 'entity_id': 'P1', 'name': '张三'}
EDGE_ROW = {'@rid': '#2:0', '@class': 'Knows', 'edge_id': 'K1',
            'source_id': 'P1', 'target_id': 'P1', 'out': '#1:0', 'in': '#1:0'}


@pytest.fixture()
def query_env(monkeypatch):
    from knowledge_base.service import kbase_service as kbase_store
    from graph.repository import graph_pg

    state = {'kbase': {'kbase_id': 'kb1', 'status': '5', 'schema_obj': SCHEMA},
             'db_exists': True,
             'vertices': [VERTEX_ROW],
             'edges': [EDGE_ROW],
             'seeds': {'P1'},
             'subgraph': ([EDGE_ROW], [VERTEX_ROW])}

    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb_id: state['kbase'] if kb_id == 'kb1' else None)
    from types import SimpleNamespace
    monkeypatch.setattr(graph_pg, 'graph_db_name_for_query', lambda kb_id: kb_id)
    monkeypatch.setattr(graph_pg, 'new_client',
                        lambda dbname: SimpleNamespace(dbname=dbname))
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: state['db_exists'])
    monkeypatch.setattr(graph_pg, 'query_vertices',
                        lambda dbname, groups, limit, offset, cursor=None, keyword=None:
                        list(state['vertices']))
    monkeypatch.setattr(graph_pg, 'query_edges',
                        lambda dbname, groups, limit, offset, cursor=None:
                        list(state['edges']))
    monkeypatch.setattr(graph_pg, 'edges_between_entities', lambda dbname, ids: [])
    monkeypatch.setattr(graph_pg, 'vertices_by_entity_ids', lambda dbname, ids: [])
    monkeypatch.setattr(graph_pg, 'start_entity_ids', lambda dbname, filters: set(state['seeds']))
    monkeypatch.setattr(graph_pg, 'subgraph',
                        lambda *args, **kwargs: state['subgraph'])
    return state


def _payload(**overrides):
    payload = {'kb_id': 'graph_kb1', 'query_type': 'entity'}
    payload.update(overrides)
    return payload


def test_query_entity_type_returns_flat_entities_and_edges(query_env):
    response = api.query(_payload())
    assert response['entities'][0]['entity_id'] == 'P1'
    assert response['entities'][0]['entity_type'] == 'Person'
    assert response['entity_num'] == 1 and response['edge_num'] == 0
    assert response['total'] == 1
    assert response['has_more'] is False and response['offset'] == 0 and \
        response['limit'] == 100


def test_query_edge_type_returns_edges(query_env):
    response = api.query(_payload(query_type='edge'))
    assert response['edges'][0]['edge_id'] == 'K1'
    assert response['total'] == 1 and response['edge_num'] == 1


def test_query_path_type_returns_only_paths(query_env):
    response = api.query(_payload(query_type='path', depth=2,
                                  filters=[{'start_entity_rid': '#1:0'}]))
    assert response['entities'] == [] and response['edges'] == []
    # 自环边：正向与反向各产出一条（都被环掩码截断为单节点路径）
    assert len(response['paths']) == 2
    assert all(path['nodes'] == ['#1:0'] for path in response['paths'])
    assert response['total'] == 2


def test_query_sub_graph_type_pops_temp_columns(query_env):
    response = api.query(_payload(query_type='sub_graph'))
    edge = response['edges'][0]
    assert edge['edge_id'] == 'K1' and edge['edge_type'] == 'Knows'
    assert 'out_entity_id' not in edge and '@rid' not in edge
    assert response['total'] == 1


def test_query_unknown_kbase_and_db(query_env):
    with pytest.raises(KbApiError) as caught:
        api.query(_payload(kb_id='graph_nope'))
    assert 'RetCode.kbase.not.exist' in caught.value.key

    query_env['db_exists'] = False
    with pytest.raises(KbApiError) as caught:
        api.query(_payload())
    assert 'RetCode.kbase.not.exist' in caught.value.key


def test_query_build_status_guards(query_env):
    query_env['kbase'] = {**query_env['kbase'], 'status': '3'}
    with pytest.raises(KbApiError) as caught:
        api.query(_payload())
    assert 'graph.query.building' in caught.value.key

    query_env['kbase'] = {**query_env['kbase'], 'status': '103'}
    with pytest.raises(KbApiError) as caught:
        api.query(_payload())
    assert 'graph.query.build.failed' in caught.value.key

    # 状态为 None：不拦
    query_env['kbase'] = {**query_env['kbase'], 'status': None}
    api.query(_payload())


def test_query_without_schema_returns_empty(query_env):
    # schema 为空的早退路径**不做** ensure/entity_num 补齐 —— paths 仍是 null
    query_env['kbase'] = {**query_env['kbase'], 'schema_obj': None}
    response = api.query(_payload())
    assert response['entities'] == []
    assert response['paths'] is None      # 早退路径不做 ensure 补齐
    assert response['entity_num'] == 0    # 骨架响应自带的 0


def test_query_database_failure_is_wrapped(query_env, monkeypatch):
    from graph.repository import graph_pg

    def boom(*args, **kwargs):
        raise RuntimeError('db down')

    monkeypatch.setattr(graph_pg, 'query_vertices', boom)
    with pytest.raises(KbApiError) as caught:
        api.query(_payload())
    assert 'graph.query.database.operation.failed' in caught.value.key


def test_query_strips_every_prefix_occurrence(query_env):
    # ``replace`` 是全局替换：``graph_graph_kb1`` 也落到 ``kb1``
    assert api.query(_payload(kb_id='graph_graph_kb1'))['entity_num'] == 1


def test_query_subgraph_without_edges_is_empty(query_env):
    query_env['subgraph'] = ([], [])
    response = api.query(_payload(query_type='sub_graph'))
    assert response['entities'] == [] and response['edges'] == []
    assert response['total'] == 0 and response['has_more'] is False


def test_query_subgraph_with_filters_collects_path_fields(query_env):
    captured = {}

    def fake_subgraph(dbname, seeds, depth, direction, edge_types, edge_properties,
                      vertex_groups, limit, offset, cursor=None, **kwargs):
        captured.update({'seeds': seeds, 'edge_types': edge_types,
                         'edge_properties': edge_properties,
                         'vertex_groups': vertex_groups, 'direction': direction})
        return ([], [])

    from graph.repository import graph_pg

    original = graph_pg.subgraph
    graph_pg.subgraph = fake_subgraph
    try:
        api.query(_payload(query_type='sub_graph', depth=3, direction='out', filters=[
            {'path_edge_type': ['Knows'], 'path_edge_properties': {'w': 1},
             'path_entity_type': ['Person'], 'path_entity_properties': {'n': 1}},
            {'path_edge_type': ['Knows', 'Free']},
        ]))
    finally:
        graph_pg.subgraph = original

    assert captured['edge_types'] == ['Knows', 'Free']
    assert captured['edge_properties'] == {'w': 1}
    assert captured['vertex_groups'] == [{'entity_type': ['Person'], 'properties': {'n': 1}}]
    assert captured['direction'] == 'out'


def test_helper_functions():
    assert api._limit({}) == 100
    assert api._limit({'limit': 7}) == 7
    assert api._cursor({'cursor': '  #1:0 '}) == '#1:0'
    assert api._cursor({'cursor': ''}) is None
    assert api._cursor({}) is None
    assert api._filter_items({'filters': [{'entity_type': ['P'], 'properties': {'a': 1},
                                           'junk': 2}]}, 'entity_type') == [
        {'entity_type': ['P'], 'properties': {'a': 1}}]
    assert api._filter_items({}, 'edge_type') == []
    assert api._limit({'limit': None}) == 100


def test_start_conditions_placeholder_and_expand():
    assert api._start_conditions_for_paths({}) == {'_use_in_degree_zero': True}
    conditions = api._start_conditions_for_paths({'filters': [
        {'start_entity_type': ['Person'], 'start_entity_properties': {'n': [1, 2]}}]})
    assert conditions == [{'@class': 'Person', 'n': 1}, {'@class': 'Person', 'n': 2}]

    # 只有操作符条件时也保留
    conditions = api._start_conditions_for_paths({'filters': [
        {'start_entity_properties': {'n': {'op': 'eq', 'value': 1}}}]})
    assert conditions == [{'n': {'op': 'eq', 'value': 1}}]
