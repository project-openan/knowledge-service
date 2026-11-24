"""graph_review_service 的全流程 + graph_common 的展平与条件拼装。

review 钉的是：四条校验是 **0004**、库不存在是 **0005**、数据库异常**回空图**；
graph_common 钉的是：展平补空串、主键兜底链、以及「schema 里 properties 只认
List 形态」这条容易被「顺手统一」掉的差异。

跑法::

    python -m pytest tests/test_graph_review_and_common.py -q
"""

from __future__ import annotations

import pytest

from graph.service import graph_common
from graph.service import graph_review_service as review_svc
from shared.errors.api import KbApiError

SCHEMA = {
    'entities': [{'entity_type': 'Person', 'properties': [
        {'name': 'person_id', 'type': 'STRING', 'is_primary': True},
        {'name': 'name', 'type': 'STRING'},
        {'name': 'age', 'type': 'INTEGER'},
    ]}],
    'edges': [{'edge_type': 'Knows', 'properties': [{'name': 'since'}]}],
}


# ----------------------------------------------------------------------
# graph_common
# ----------------------------------------------------------------------


def test_schema_obj_accepts_dict_json_and_returns_none_on_garbage():
    assert graph_common.schema_obj({'schema_obj': {'a': 1}}) == {'a': 1}
    assert graph_common.schema_obj({'schema_obj': '{"a": 1}'}) == {'a': 1}
    assert graph_common.schema_obj({'schema_obj': 'oops'}) is None
    assert graph_common.schema_obj({}) is None
    assert graph_common.schema_obj(None) is None


def test_schema_index_collects_types_pks_display_and_properties():
    schema = graph_common.SchemaIndex(SCHEMA)
    assert schema.entity_types == {'Person'}
    assert schema.edge_types == {'Knows'}
    assert schema.entity_primary_keys['Person'] == ['person_id']
    assert schema.entity_display_fields['Person'] == 'person_id'
    assert schema.entity_properties['Person'] == {'person_id', 'name', 'age'}
    assert schema.edge_properties['Knows'] == {'since'}

    empty = graph_common.SchemaIndex(None)
    assert empty.entity_types == set() and empty.edge_types == set()
    # properties 不是 List → 一律空集合
    bad = graph_common.SchemaIndex({'entities': [{'entity_type': 'X',
                                                  'properties': {'a': {}}}]})
    assert bad.entity_properties['X'] == set()
    assert bad.entity_primary_keys['X'] == ['id']       # 默认主键


def test_primary_key_fallback_chain():
    definition = {'entity_type': 'X', 'primaryKeys': ['a'], 'pk': ['b']}
    assert graph_common._extract_primary_keys(definition) == ['a']
    definition = {'entity_type': 'X', 'pk': ['b'], 'pks': ['c']}
    assert graph_common._extract_primary_keys(definition) == ['b']
    definition = {'entity_type': 'X', 'properties': [
        {'name': 'p', 'is_primary': True}, {'name': 'q'}]}
    assert graph_common._extract_primary_keys(definition) == ['p']
    assert graph_common._extract_primary_keys({'entity_type': 'X'}) == ['id']


def test_display_field_falls_back_to_first_property_then_name():
    assert graph_common._extract_display_field({'properties': [
        {'name': 'a'}, {'name': 'b', 'is_primary': True}]}) == 'b'
    assert graph_common._extract_display_field({'properties': [
        {'name': 'a'}]}) == 'a'
    assert graph_common._extract_display_field({}) == 'name'


def test_without_system_fields_drops_nulls():
    row = {'name': 'x', '@rid': 'r', 'out': 'o', 'in': 'i', '#labels': ['L'],
           'none': None}
    assert graph_common._without_system_fields(row) == {'name': 'x'}


def test_schema_filtered_fills_blank_for_missing():
    assert graph_common._schema_filtered({'a': 1}, {'a', 'b'}) == {'a': 1, 'b': ''}
    assert graph_common._schema_filtered({'a': None}, {'a'}) == {'a': ''}
    assert graph_common._schema_filtered({'a': 1}, set()) == {}


def test_derive_entity_id_chain():
    assert graph_common._derive_entity_id({'entity_id': 'E1'}, ['id']) == 'E1'
    assert graph_common._derive_entity_id({'id': '7'}, ['id']) == '7'
    assert graph_common._derive_entity_id({'a': '1', 'b': '2'}, ['a', 'b']) == '1|2'
    assert graph_common._derive_entity_id({}, ['id']) == ''


def test_to_entity_and_edge_with_schema():
    schema = graph_common.SchemaIndex(SCHEMA)
    entity = graph_common.to_entity({
        '@class': 'Person', 'entity_id': 'P1', 'person_id': 'P1', 'name': '张三',
        'age': None, '@rid': '#1:0'}, schema)
    # 展示字段取**主键属性**（is_primary），不是 name
    assert entity == {'entity_id': 'P1', 'entity_type': 'Person', 'entity_name': 'P1',
                      'properties': {'person_id': 'P1', 'name': '张三', 'age': ''}}

    # 没有 @class 的行静默丢弃
    assert graph_common.to_entity({'entity_id': 'P'}, schema) is None

    # 展示字段（主键属性）缺失回落成 entityId
    entity = graph_common.to_entity({'@class': 'Person'}, schema)
    assert entity['entity_name'] == ''
    entity = graph_common.to_entity({'@class': 'Person', 'person_id': 'P9'}, schema)
    assert entity['entity_name'] == 'P9'

    edge = graph_common.to_edge({
        '@class': 'Knows', 'edge_id': 'K1', 'source_id': 'P1', 'target_id': 'P2',
        'out': '#1:0', 'in': '#2:0', 'since': 2020}, schema)
    assert edge == {'edge_id': 'K1', 'edge_type': 'Knows', 'source_id': 'P1',
                    'target_id': 'P2', 'properties': {'since': 2020}}

    # id 缺失回落 out/in 的原始 RID；edge_id 缺失是 None（不是空串）
    edge = graph_common.to_edge({'@class': 'Knows', 'out': '#7:0', 'in': '#8:0'}, schema)
    assert edge['edge_id'] is None
    assert edge['source_id'] == '#7:0'
    assert edge['target_id'] == '#8:0'


def test_sql_literal_helpers():
    assert graph_common.escape_sql_value("a'b\\c") == "a\\'b\\\\c"
    assert graph_common.format_sql_value(True) == 'TRUE'
    assert graph_common.format_sql_value(False) == 'FALSE'
    assert graph_common.format_sql_value(3) == '3'
    assert graph_common.format_sql_value([1, 'a']) == "[1,'a']"
    assert graph_common.format_sql_value('x') == "'x'"
    assert graph_common.backtick('@rid') == '@rid'
    assert graph_common.backtick('`raw`') == '`raw`'
    assert graph_common.backtick('name') == '`name`'

    assert graph_common.simple_property_condition('a', None) == '`a` IS NULL'
    assert graph_common.simple_property_condition('a', []) == 'FALSE'
    assert graph_common.simple_property_condition('a', [1, 'x']) == \
        '`a` IN [1,\'x\']'
    assert graph_common.simple_property_condition('a', "it's") == "`a` = 'it\\'s'"
    assert graph_common.simple_property_condition('a', 5) == '`a` = 5'
    assert graph_common.simple_property_condition('a', 5, use_backtick=False) == 'a = 5'


# ----------------------------------------------------------------------
# graph_review_service
# ----------------------------------------------------------------------


@pytest.fixture()
def review_env(monkeypatch):
    from knowledge_base.service import kbase_service as kbase_store
    from graph.repository import graph_pg

    state = {'kbase': {'kbase_id': 'kb1', 'schema_obj': SCHEMA},
             'db_exists': True,
             'seeds': {'P1'},
             'subgraph': ([{'@rid': '#2:0', '@class': 'Knows', 'edge_id': 'K1',
                            'source_id': 'P1', 'target_id': 'P1', 'out': '#1:0',
                            'in': '#1:0', 'out_entity_id': 'P1', 'in_entity_id': 'P1'}],
                          [{'@rid': '#1:0', '@class': 'Person', 'entity_id': 'P1'}])}

    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb_id: state['kbase'] if kb_id == 'kb1' else None)
    from types import SimpleNamespace
    monkeypatch.setattr(graph_pg, 'graph_db_name', lambda kb_id: f'graph_{kb_id}')
    monkeypatch.setattr(graph_pg, 'new_client',
                        lambda dbname: SimpleNamespace(dbname=dbname))
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: state['db_exists'])
    monkeypatch.setattr(graph_pg, 'start_entity_ids', lambda dbname, filters: set(state['seeds']))
    monkeypatch.setattr(graph_pg, 'subgraph', lambda *args, **kwargs: state['subgraph'])
    return state


def test_review_validation_is_0004(review_env):
    for payload, key in (
            ({}, 'graph.review.kbid.empty'),
            ({'kbId': '  '}, 'graph.review.kbid.empty'),
            ({'kbId': 'kb1', 'direction': 'sideways'}, 'graph.review.direction.invalid'),
            ({'kbId': 'kb1', 'depth': 0}, 'graph.review.depth.invalid'),
            ({'kbId': 'kb1', 'depth': 11}, 'graph.review.depth.invalid'),
            ({'kbId': 'kb1', 'limit': 0}, 'graph.review.limit.invalid'),
            ({'kbId': 'kb1', 'limit': 10001}, 'graph.review.limit.invalid'),
    ):
        with pytest.raises(KbApiError) as caught:
            review_svc.review(payload)
        assert caught.value.code == '0004'
        assert key in caught.value.key


def test_review_missing_kbase_is_0005(review_env):
    with pytest.raises(KbApiError) as caught:
        review_svc.review({'kbId': 'nope'})
    assert caught.value.code == '0005'
    assert 'kbase.not.exist' in caught.value.key


def test_review_without_schema_returns_empty(review_env):
    review_env['kbase'] = {'kbase_id': 'kb1', 'schema_obj': None}
    assert review_svc.review({'kbId': 'kb1'}) == review_svc._empty()


def test_review_success_maps_rows_to_schema_shape(review_env):
    result = review_svc.review({'kbId': 'kb1', 'depth': 2, 'limit': 100,
                                'direction': 'both', 'filters': [
                                    {'path_edge_type': ['Knows']}]})
    assert result['entity_num'] == 1
    assert result['entities'][0]['entity_type'] == 'Person'
    assert result['edges'][0]['edge_id'] == 'K1'
    assert 'out_entity_id' not in result['edges'][0]


def test_review_db_failure_returns_empty(review_env, monkeypatch):
    from graph.repository import graph_pg

    def boom(*args, **kwargs):
        raise RuntimeError('down')

    monkeypatch.setattr(graph_pg, 'subgraph', boom)
    assert review_svc.review({'kbId': 'kb1'}) == review_svc._empty()

    review_env['db_exists'] = False
    assert review_svc.review({'kbId': 'kb1'}) == review_svc._empty()


def test_review_defaults_apply(review_env):
    captured = {}

    from graph.repository import graph_pg
    original = graph_pg.subgraph

    def fake_subgraph(dbname, seeds, depth, direction, edge_types, edge_properties,
                      vertex_groups, limit, offset, cursor=None, **kwargs):
        captured.update({'depth': depth, 'limit': limit, 'direction': direction,
                         'offset': offset, 'cursor': cursor})
        return original(dbname, seeds, depth, direction, edge_types,
                        edge_properties, vertex_groups, limit, offset, cursor, **kwargs)

    graph_pg.subgraph = fake_subgraph
    try:
        review_svc.review({'kbId': 'kb1'})
    finally:
        graph_pg.subgraph = original
    assert captured == {'depth': 10, 'limit': 1000, 'direction': 'both',
                        'offset': 0, 'cursor': None}
