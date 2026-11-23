"""graph_write_service：六个写端点的校验阶梯与流程（桩 kbase / 图存储 / 索引）。

钉三类：

1. **校验矩阵**：id 格式四分支、属性类型全枚举、update 的系统字段拦截；
2. **流程**：create/update/delete × entity/edge 的成功路径与业务异常原样上抛；
3. **兜底**：未预期异常 → 0005 + 不泄漏内部细节；库不存在时的空指针文案原样保留。

跑法::

    python -m pytest tests/test_graph_write_service_flows.py -q
"""

from __future__ import annotations

import pytest

from graph.service import graph_write_service as svc
from graph.models.kg_struct import EdgeData, EntityData
from shared.errors.api import KbApiError

SCHEMA = {
    'entities': [
        {'entity_type': 'Person', 'properties': [
            {'name': 'name', 'type': 'STRING'},
            {'name': 'age', 'type': 'INTEGER'},
            {'name': 'born', 'type': 'DATE'},
            {'name': 'tags', 'type': 'EMBEDDEDLIST'},
        ]},
        {'entity_type': 'Company', 'properties': []},
    ],
    'edges': [
        {'edge_type': 'WorksAt', 'source_entity': 'Person', 'target_entity': 'Company',
         'properties': [{'name': 'since', 'type': 'INTEGER'}]},
        {'edge_type': 'Free', 'source_entity': None, 'target_entity': None},
    ],
}


def _kbase(schema_obj=SCHEMA):
    return {'kbase_id': 'kb-1', 'table_name': 'graph_demo',
            'embedding_model': 'm', 'schema_obj': schema_obj}


@pytest.fixture()
def graph_env(monkeypatch):
    """桩 kbase 行 + 图存储存在性；索引同步替换为记录器。"""
    from graph.repository import graph_pg

    # 默认：实体存在、边**不存在**（create 语义）；update/delete 的用例自己翻转
    state = {'kbase': _kbase(), 'entity_exists': True, 'edge_exists': False,
             'clients': [], 'edge_props': {}}

    monkeypatch.setattr(svc.kbase_store, 'get_kbase_row',
                        lambda kb_id: state['kbase'] if kb_id == 'kb-1' else None)
    monkeypatch.setattr(svc.kbase_store, 'set_kbase_status_modified',
                        lambda kb_id: state.setdefault('published', kb_id))
    monkeypatch.setattr(graph_pg, 'new_client',
                        lambda dbname: {'dbname': dbname, 'name': 'client'})
    monkeypatch.setattr(graph_pg, 'graph_db_name', lambda kb_id: f'graph_{kb_id}')
    def fake_entity_exists(client, entity_type, entity_id):
        text = str(entity_id)
        if text.endswith('_ghost') or text.startswith('Ghost'):
            return False
        if text == 'Company_1':
            return True
        return state['entity_exists']

    monkeypatch.setattr(graph_pg, 'entity_exists', fake_entity_exists)
    monkeypatch.setattr(graph_pg, 'edge_exists',
                        lambda client, edge_type, edge_id: state['edge_exists'])
    monkeypatch.setattr(graph_pg, 'get_entity_properties',
                        lambda client, entity_type, entity_id:
                        {'entity_id': entity_id, 'name': 'x'})
    monkeypatch.setattr(graph_pg, 'get_edge_properties',
                        lambda client, edge_type, edge_id: state['edge_props'].get(
                            edge_id, {'source_id': 'Person_1', 'target_id': 'Company_1',
                                      'out': 'Person_1', 'in': 'Company_1'}))
    monkeypatch.setattr(graph_pg, 'add_entity',
                        lambda client, entity: state.setdefault('entities', []).append(
                            entity.entity_id))
    monkeypatch.setattr(graph_pg, 'add_edge',
                        lambda client, edge: state.setdefault('edges', []).append(
                            edge.edge_id))
    monkeypatch.setattr(graph_pg, 'update_entity',
                        lambda client, entity_type, entity_id, properties: None)
    monkeypatch.setattr(graph_pg, 'update_edge',
                        lambda client, edge_type, edge_id, properties: None)
    monkeypatch.setattr(graph_pg, 'delete_entity',
                        lambda client, entity_type, entity_id: None)
    monkeypatch.setattr(graph_pg, 'delete_edge',
                        lambda client, edge_type, edge_id: None)
    monkeypatch.setattr(svc, '_sync_entity_index', lambda *a, **k: None)
    monkeypatch.setattr(svc, '_sync_edge_index', lambda *a, **k: None)
    monkeypatch.setattr(svc, '_delete_entity_index', lambda *a, **k: None)
    monkeypatch.setattr(svc, '_delete_edge_index', lambda *a, **k: None)
    return state


# ----------------------------------------------------------------------
# 纯校验
# ----------------------------------------------------------------------


def test_kbase_blank_id_is_literal_validation():
    with pytest.raises(KbApiError) as caught:
        svc._kbase('   ')
    assert caught.value.code == '0004'


def test_require_kbase_missing_follows_language(graph_env):
    with pytest.raises(KbApiError) as caught:
        svc._require_kbase('kb-x')
    assert caught.value.key == 'RetCode.kbase.not.exist'
    assert caught.value.code == '0005'


def test_schema_obj_accepts_dict_json_and_rejects_garbage():
    assert svc._schema_obj({'schema_obj': {'a': 1}}) == {'a': 1}
    assert svc._schema_obj({'schema_obj': '{"a": 2}'}) == {'a': 2}
    assert svc._schema_obj({'schema_obj': 'not json'}) is None
    assert svc._schema_obj({'schema_obj': None}) is None
    assert svc._schema_obj(None) is None


def test_definitions_require_list_shape():
    assert svc._entity_definitions({'entities': {}}) is None
    assert svc._edge_definitions({'edges': 'x'}) is None


def test_schema_properties_accepts_list_and_map_forms():
    as_list = svc._schema_properties({'properties': [{'name': 'a', 'type': 'STRING'},
                                                     {'name': '', 'type': 'STRING'}]})
    assert as_list == {'a': {'name': 'a', 'type': 'STRING'}}
    as_map = svc._schema_properties({'properties': {'a': {'type': 'STRING'}, 'b': 'x'}})
    assert as_map == {'a': {'type': 'STRING'}}
    assert svc._schema_properties({'properties': 'x'}) == {}


@pytest.mark.parametrize('value, ok', [
    ('Person_1', True), ('Person_001', True),
    (None, False), ('x' * 101, False), ('Wrong_1', False), ('Person_', False),
    ('Person_走', False),
])
def test_validate_id_format_branches(value, ok):
    if ok:
        svc._validate_id_format(value, 'entity', 'Person', 'entity_id')
        return
    with pytest.raises(KbApiError):
        svc._validate_id_format(value, 'entity', 'Person', 'entity_id')


def test_validate_entity_type_and_edge_type_undefined():
    with pytest.raises(KbApiError) as caught:
        svc._validate_entity_type({}, 'Person')
    assert caught.value.key == 'RetCode.graph.entity.type.not.defined'
    with pytest.raises(KbApiError):
        svc._validate_entity_type(SCHEMA, 'Robot')
    with pytest.raises(KbApiError):
        svc._validate_edge_type({}, 'WorksAt')
    assert svc._validate_edge_type(SCHEMA, 'WorksAt')['edge_type'] == 'WorksAt'


@pytest.mark.parametrize('declared, value, ok', [
    ('STRING', 'x', True), ('STRING', 1, False),
    ('BOOLEAN', True, True), ('BOOLEAN', 1, False),
    ('INTEGER', 3, True), ('INTEGER', True, False), ('INTEGER', 1.5, False),
    ('DOUBLE', 1.5, True), ('DOUBLE', 3, True), ('DOUBLE', 'x', False),
    ('DATE', '2024-01-02', True), ('DATE', '2024-13-99', False),
    ('DATETIME', '2024-01-02T03:04:05', True),
    ('DATETIME', '2024-01-02 03:04:05', True),
    ('DATETIME', '2024-01-02', False),
    ('BINARY', b'x', True), ('BINARY', 'x', True), ('BINARY', 5, False),
    ('EMBEDDED', {'a': 1}, True), ('EMBEDDEDMAP', {}, True), ('LINKMAP', {}, True),
    ('EMBEDDEDLIST', [1], True), ('LINKLIST', [], True),
    ('EMBEDDEDSET', {1}, True), ('LINKSET', [1], True),
    ('LINK', 'Person_1', True), ('LINK', 1, False),
    ('MYSTERY', object(), True),          # 未登记的类型静默放行
])
def test_matches_type_matrix(declared, value, ok):
    assert svc._matches_type(declared, value) is ok


def test_validate_property_value_types_first_mismatch_raises():
    props = {'name': 'x', 'age': 'not-a-number'}
    schema_properties = {'name': {'type': 'STRING'}, 'age': {'type': 'INTEGER'}}
    with pytest.raises(KbApiError) as caught:
        svc._validate_property_value_types(props, schema_properties, 'entity')
    assert 'entity.property.type.mismatch' in caught.value.key

    svc._validate_property_value_types({'name': None}, schema_properties, 'entity')
    svc._validate_property_value_types({}, schema_properties, 'entity')
    svc._validate_property_value_types({'name': 'x'}, {}, 'entity')


def test_validate_entity_properties_undeclared_key_rejected():
    with pytest.raises(KbApiError) as caught:
        svc._validate_entity_properties(SCHEMA, 'Person', {'bogus': 1})
    assert 'entity.property.not.defined' in caught.value.key
    svc._validate_entity_properties(SCHEMA, 'Person', {})
    # schema 没声明属性 → 不做白名单
    svc._validate_entity_properties(SCHEMA, 'Company', {'anything': 1})


def test_validate_update_properties_blocks_system_fields_first():
    with pytest.raises(KbApiError) as caught:
        svc._validate_update_properties(SCHEMA, 'Person', {'@rid': 'x'}, 'entity')
    assert 'entity.system.field.cannot.update' in caught.value.key
    with pytest.raises(KbApiError) as caught:
        svc._validate_update_properties(SCHEMA, 'Person', {'bogus': 1}, 'entity')
    assert 'entity.property.not.defined' in caught.value.key
    svc._validate_update_properties(SCHEMA, 'Person', {'name': 'x'}, 'entity')

    with pytest.raises(KbApiError) as caught:
        svc._validate_update_properties(SCHEMA, 'WorksAt', {'out': 'x'}, 'edge')
    assert 'edge.system.field.cannot.update' in caught.value.key
    with pytest.raises(KbApiError) as caught:
        svc._validate_update_properties(SCHEMA, 'Ghost', {'a': 1}, 'edge')
    assert 'edge.type.not.defined' in caught.value.key


def test_index_base_and_clean_properties():
    assert svc._index_base({'table_name': 'graph_demo'}) == 'graph_demo'
    assert svc._index_base({'table_name': ''}) is None
    assert svc._index_base({}) is None
    cleaned = svc._clean_properties({'name': 'x', '@rid': 'r', 'out_Knows': 'k',
                                     'in_x': 'i', 'out': 'o'})
    assert cleaned == {'name': 'x'}


def test_edge_endpoints_prefer_business_columns():
    assert svc._edge_endpoints({'source_id': 'Person_1', 'target_id': 'Company_1'}) == \
        ('Person_1', 'Company_1')
    assert svc._edge_endpoints({'out': 'Person_rid', 'in': 'Company_rid'}) == \
        ('Person_rid', 'Company_rid')
    assert svc._edge_endpoints({}) == (None, None)


def test_mark_kbase_modified_swallows_errors(monkeypatch):
    def boom(_kb_id):
        raise RuntimeError('db down')

    monkeypatch.setattr(svc.kbase_store, 'set_kbase_status_modified', boom)
    svc._mark_kbase_modified('kb-1')  # 不抛


def test_failure_wraps_by_error_type(monkeypatch):
    inner = svc._failure(KbApiError('RetCode.kbase.not.exist'), 'some.key', 'zh')
    assert inner.code == '0005'

    npe = svc._failure(svc._NullKbaseNpe('Cannot invoke "X.y()"'), 'some.key', 'zh')
    # 空指针文案**原样保留**在参数里（库不存在时的那条对外可见内容）
    assert 'Cannot invoke' in str(npe.args)

    plain = svc._failure(RuntimeError('secret sql detail'), 'some.key', 'zh')
    # 未预期异常的内部细节**不进**对外参数
    assert all('secret sql detail' not in str(arg) for arg in plain.args)
    assert plain.code == '0005'


def test_entity_and_edge_response_shapes():
    response = svc._entity_response(True, 'RetCode.graph.entity.create.success',
                                    'Person_1', 'Person', 2, 'zh')
    assert response['entityId'] == 'Person_1'
    assert response['affectedEdges'] == 2

    edge = svc._edge_response(True, 'RetCode.graph.edge.update.success', 'WorksAt_1',
                              'WorksAt', '#1:0', '#2:0', 'en')
    assert edge['sourceId'] == '#1:0'


def test_require_required_blank_values():
    with pytest.raises(KbApiError) as caught:
        svc._require_required('  ', 'x')
    assert caught.value.code == '0004'
    svc._require_required(0, 'x')  # 0 不是空


# ----------------------------------------------------------------------
# 实体流程
# ----------------------------------------------------------------------


def _entity_payload(**overrides):
    payload = {'kbId': 'kb-1', 'entityId': 'Person_1', 'entityType': 'Person',
               'properties': {'name': '张三'}}
    payload.update(overrides)
    return payload


def test_create_entity_requires_all_fields(graph_env):
    for field in ('kbId', 'entityId', 'entityType'):
        payload = _entity_payload()
        payload[field] = '   '
        with pytest.raises(KbApiError) as caught:
            svc.create_entity(payload)
        assert caught.value.code == '0004'
    payload = _entity_payload()
    payload['properties'] = None
    with pytest.raises(KbApiError) as caught:
        svc.create_entity(payload)
    assert caught.value.code == '0004'


def test_create_entity_missing_kbase_keeps_npe_text(graph_env):
    with pytest.raises(KbApiError) as caught:
        svc.create_entity(_entity_payload(kbId='kb-x'))
    assert caught.value.code == '0005'
    assert 'Cannot invoke' in (caught.value.render('zh') or '')


def test_create_entity_schema_undefined(graph_env):
    graph_env['kbase'] = {**_kbase(), 'schema_obj': None}
    with pytest.raises(KbApiError) as caught:
        svc.create_entity(_entity_payload())
    assert 'entity.schema.undefined' in caught.value.key


def test_create_entity_business_errors_pass_through(graph_env):
    with pytest.raises(KbApiError) as caught:
        svc.create_entity(_entity_payload(entityType='Robot'))
    assert caught.value.code == '0004' or caught.value.code == '0005'
    assert 'entity.type.not.defined' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.create_entity(_entity_payload(entityId='Bad_1'))
    assert 'entity.id.format.invalid' in caught.value.key


def test_create_entity_already_exists(graph_env):
    with pytest.raises(KbApiError) as caught:
        svc.create_entity(_entity_payload())
    assert 'entity.already.exists' in caught.value.key


def test_create_entity_success_publishes_state(graph_env):
    written = {}
    graph_env['entity_exists'] = False

    from graph.repository import graph_pg
    original = graph_pg.add_entity
    graph_pg.add_entity = lambda client, entity: written.update(
        {'id': entity.entity_id, 'type': entity.entity_type})
    try:
        response = svc.create_entity(_entity_payload())
    finally:
        graph_pg.add_entity = original
    assert response['success'] is True
    assert response['entityId'] == 'Person_1'
    assert written['id'] == 'Person_1'
    assert graph_env.get('published') == 'kb-1'


def test_create_entity_with_edge_info_success(graph_env):
    graph_env['entity_exists'] = False
    payload = _entity_payload(edgeInfo={
        'edgeId': 'WorksAt_9', 'edgeType': 'WorksAt',
        'currentEntityId': 'Company_1', 'direction': 'out',
        'properties': {'since': 2020}})
    response = svc.create_entity(payload)
    assert response['success'] is True


def test_create_entity_edge_write_failure_rolls_back(monkeypatch, graph_env):
    from graph.repository import graph_pg
    graph_env['entity_exists'] = False
    rolled = []
    monkeypatch.setattr(graph_pg, 'add_edge',
                        lambda client, edge: (_ for _ in ()).throw(RuntimeError('edge down')))
    monkeypatch.setattr(svc, '_rollback_created_entity',
                        lambda client, kbase, entity_id, entity_type, edge_id:
                        rolled.append(entity_id))
    payload = _entity_payload(edgeInfo={
        'edgeId': 'WorksAt_9', 'edgeType': 'WorksAt',
        'currentEntityId': 'Company_1'})
    with pytest.raises(KbApiError) as caught:
        svc.create_entity(payload)
    assert 'entity.create.failed' in caught.value.key
    assert rolled == ['Person_1']


def test_prepare_edge_for_entity_validations(graph_env):
    from graph.repository import graph_pg
    client = {'dbname': 'graph_demo'}
    with pytest.raises(KbApiError) as caught:
        svc._prepare_edge_for_entity(client, SCHEMA, 'Person_1', {'edgeType': 'Ghost'})
    assert 'edge.type.not.defined' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc._prepare_edge_for_entity(client, SCHEMA, 'Person_1', {
            'edgeId': 'Bad_1', 'edgeType': 'WorksAt', 'currentEntityId': 'Company_1'})
    assert 'edge.id.format.invalid' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc._prepare_edge_for_entity(client, SCHEMA, 'Person_1', {
            'edgeId': 'WorksAt_1', 'edgeType': 'WorksAt', 'currentEntityId': 'Ghost_1'})
    assert 'edge.target.not.exists' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc._prepare_edge_for_entity(client, SCHEMA, 'Person_1', {
            'edgeId': 'WorksAt_1', 'edgeType': 'WorksAt',
            'currentEntityId': 'Company_1', 'direction': 'sideways'})
    assert 'edge.direction.invalid' in caught.value.key

    prepared = svc._prepare_edge_for_entity(client, SCHEMA, 'Person_1', {
        'edgeId': 'WorksAt_1', 'edgeType': 'WorksAt',
        'currentEntityId': 'Company_1', 'direction': 'out',
        'properties': {'since': 1}})
    assert (prepared['source_id'], prepared['target_id']) == ('Person_1', 'Company_1')

    with pytest.raises(KbApiError) as caught:
        svc._prepare_edge_for_entity(client, SCHEMA, 'Person_1', {
            'edgeId': 'WorksAt_1', 'edgeType': 'WorksAt',
            'currentEntityId': 'Company_1', 'properties': {'bogus': 1}})
    assert 'edge.property.not.defined' in caught.value.key


def test_validate_edge_node_types_matrix(graph_env):
    from graph.repository import graph_pg
    with pytest.raises(KbApiError) as caught:
        svc._validate_edge_node_types(SCHEMA, 'Ghost', 'Person_1', 'Company_1')
    assert 'edge.type.not.defined' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc._validate_edge_node_types(SCHEMA, 'WorksAt', 'notype', 'Company_1')
    assert 'edge.source.node.type.invalid' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc._validate_edge_node_types(SCHEMA, 'WorksAt', 'Person_1', 'notype')
    assert 'edge.target.node.type.invalid' in caught.value.key

    # 两端都为 null 的定义被跳过，不参与匹配
    with pytest.raises(KbApiError) as caught:
        svc._validate_edge_node_types(SCHEMA, 'Free', 'Person_1', 'Company_1')
    assert 'edge.node.type.pair.mismatch' in caught.value.key

    matched = svc._validate_edge_node_types(SCHEMA, 'WorksAt', 'Person_1', 'Company_1')
    assert matched['edge_type'] == 'WorksAt'


def test_update_entity_flow(graph_env):
    graph_env['entity_exists'] = True
    response = svc.update_entity(_entity_payload(properties={'name': 'new'}))

    assert response['success'] is True
    assert response['entityId'] == 'Person_1'

    with pytest.raises(KbApiError) as caught:
        svc.update_entity(_entity_payload(entityId='Person_ghost'))
    assert 'entity.not.exists' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.update_entity(_entity_payload(properties={'@class': 'x'}))
    assert 'entity.system.field.cannot.update' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.update_entity(_entity_payload(properties={'age': 'nope'}))
    assert 'entity.property.type.mismatch' in caught.value.key


def test_delete_entity_flow(graph_env, monkeypatch):
    from graph.repository import graph_pg
    graph_env['entity_exists'] = True
    calls = []
    monkeypatch.setattr(graph_pg, 'delete_edges_by_entity', lambda *a: 4)
    monkeypatch.setattr(graph_pg, 'delete_entity',
                        lambda *a: calls.append(a))
    response = svc.delete_entity(_entity_payload())
    assert response['affectedEdges'] == 4
    assert calls

    with pytest.raises(KbApiError) as caught:
        svc.delete_entity(_entity_payload(entityId='Person_ghost'))
    assert 'entity.not.exists' in caught.value.key


# ----------------------------------------------------------------------
# 边流程
# ----------------------------------------------------------------------


def _edge_payload(**overrides):
    payload = {'kbId': 'kb-1', 'edgeId': 'WorksAt_1', 'edgeType': 'WorksAt',
               'sourceId': 'Person_1', 'targetId': 'Company_1',
               'properties': {'since': 2020}}
    payload.update(overrides)
    return payload


def test_create_edge_requires_all_fields(graph_env):
    for field in ('kbId', 'edgeId', 'edgeType', 'sourceId', 'targetId'):
        payload = _edge_payload()
        payload[field] = ''
        with pytest.raises(KbApiError):
            svc.create_edge(payload)
    payload = _edge_payload()
    payload['properties'] = None
    with pytest.raises(KbApiError):
        svc.create_edge(payload)


def test_create_edge_success(graph_env):
    response = svc.create_edge(_edge_payload())
    assert response['success'] is True
    assert (response['sourceId'], response['targetId']) == ('Person_1', 'Company_1')


def test_create_edge_business_branches(graph_env):
    graph_env['edge_exists'] = True
    with pytest.raises(KbApiError) as caught:
        svc.create_edge(_edge_payload())
    assert 'edge.already.exists' in caught.value.key

    graph_env['edge_exists'] = False
    with pytest.raises(KbApiError) as caught:
        svc.create_edge(_edge_payload(sourceId='nounderscore'))
    assert 'entity.id.invalid' in caught.value.key

    graph_env['entity_exists'] = True
    with pytest.raises(KbApiError) as caught:
        svc.create_edge(_edge_payload(targetId='Ghost_9'))
    assert 'edge.target.not.exists' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.create_edge(_edge_payload(sourceId='Person_ghost'))
    assert 'edge.source.not.exists' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.create_edge(_edge_payload(edgeType='Free', edgeId='Free_1'))
    assert 'edge.node.type.pair.mismatch' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.create_edge(_edge_payload(properties={'bogus': 1}))
    assert 'edge.property.not.defined' in caught.value.key


def test_update_edge_flow(graph_env):
    graph_env['edge_exists'] = True
    response = svc.update_edge(_edge_payload(properties={'since': 2021}))
    assert response['success'] is True
    assert response['sourceId'] == 'Person_1'
    assert response['targetId'] == 'Company_1'

    with pytest.raises(KbApiError) as caught:
        svc.update_edge(_edge_payload(properties={'bogus': 1}))
    assert 'edge.property.not.defined' in caught.value.key


def test_update_edge_reports_rid_endpoints_when_business_ids_missing(graph_env):
    graph_env['edge_exists'] = True
    graph_env['edge_props']['WorksAt_1'] = {'out': '#11:0', 'in': '#12:0'}
    response = svc.update_edge(_edge_payload(properties={'since': 2021}))
    # update 响应里的两端是 **RID**（不做 id 提取）
    assert (response['sourceId'], response['targetId']) == ('#11:0', '#12:0')


def test_delete_edge_flow(graph_env):
    graph_env['edge_exists'] = True
    response = svc.delete_edge(_edge_payload())
    assert response['success'] is True
    assert response['sourceId'] == 'Person_1'


def test_write_unexpected_error_wrapped_as_0005(monkeypatch, graph_env):
    from graph.repository import graph_pg
    graph_env['edge_exists'] = True
    monkeypatch.setattr(graph_pg, 'delete_edge',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('boom')))
    with pytest.raises(KbApiError) as caught:
        svc.delete_edge(_edge_payload())
    assert caught.value.code == '0005'
    assert 'edge.delete.failed' in caught.value.key


def test_validate_edge_properties_for_def_allows_empty():
    svc._validate_edge_properties_for_def({}, {})
    with pytest.raises(KbApiError):
        svc._validate_edge_properties_for_def(
            {'properties': [{'name': 'since'}]}, {'bogus': 1})
