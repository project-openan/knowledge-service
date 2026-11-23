"""graph_schema_service 的六个端点逻辑（桩 graph_schema 表）。

钉三条：list 是 camelCase 而 detail 是 snake_case；create 缺 schema_id 仍会把
**DTO 的 None** 交给 INSERT（刻意的坏行为）；import 的条目名按 GBK 解码、
failedCount 恒为 0（一个坏文件全批失败）。

跑法::

    python -m pytest tests/test_graph_schema_service_endpoints.py -q
"""

from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime

import pytest

from graph.service import graph_schema_service as svc
from shared.errors.api import KbApiError, KbServerError

SCHEMA = {
    'schema_id': 's-1', 'schema_name': '模板一', 'schema_desc': '描述',
    'entities': [{'entity_type': 'Person', 'entity_desc': '人', 'properties': [
        {'name': 'person_id', 'type': 'STRING', 'desc': '主键', 'is_primary': True,
         'is_embedding': False, 'is_index': False}]}],
    'edges': [{'edge_type': 'Knows', 'edge_desc': '认识', 'direction': 'ANY',
               'source_entity': 'Person', 'target_entity': 'Person', 'properties': []}],
}


@pytest.fixture()
def schema_store(monkeypatch):
    from graph.repository import graph_schema_store as store

    state = {'rows': {'s-1': {'schema_id': 's-1', 'schema_name': '模板一',
                              'schema_desc': '描述',
                              'schema_obj': SCHEMA,   # PG jsonb 取出来就是 dict
                              'created_at': datetime(2024, 1, 1, 8, 0, 0),
                              'updated_at': datetime(2024, 1, 2, 9, 0, 0),
                              'created_by': 'emp-1', 'updated_by': 'emp-1',
                              'status': 0}},
             'inserted': [], 'updated': [], 'deleted': []}

    monkeypatch.setattr(store, 'get_schema_by_id',
                        lambda schema_id: state['rows'].get(schema_id))
    monkeypatch.setattr(store, 'get_schema_by_name',
                        lambda name: next((row for row in state['rows'].values()
                                           if row['schema_name'] == name), None))
    monkeypatch.setattr(store, 'is_schema_exist', lambda schema_id, name:
                        any(row['schema_id'] == schema_id or row['schema_name'] == name
                            for row in state['rows'].values()))
    monkeypatch.setattr(store, 'insert_schema',
                        lambda **kwargs: state['inserted'].append(kwargs))
    monkeypatch.setattr(store, 'update_schema',
                        lambda **kwargs: state['updated'].append(kwargs) or 1)
    monkeypatch.setattr(store, 'delete_schema_by_id',
                        lambda schema_id: state['deleted'].append(schema_id) or 1)
    monkeypatch.setattr(store, 'list_by_user',
                        lambda emp_no: [row for row in state['rows'].values()
                                        if emp_no is None or row['created_by'] == emp_no])
    return state


# ----------------------------------------------------------------------
# VO 装配
# ----------------------------------------------------------------------


def test_list_vo_is_camel_case_with_millis(schema_store):
    rows = svc.list_schemas('emp-1')
    assert rows[0]['schemaId'] == 's-1'
    assert rows[0]['createTime'] == str(int(datetime(2024, 1, 1, 8, 0, 0)
                                             .timestamp() * 1000))
    assert rows[0]['tenantId'] is None
    assert svc.list_schemas('someone-else') == []


def test_detail_vo_is_snake_case_and_expands_schema_obj(schema_store):
    detail = svc.schema_detail('s-1')
    assert detail['schema_id'] == 's-1'
    assert detail['entities'][0]['entity_type'] == 'Person'
    assert detail['entities'][0]['properties'][0]['is_primary'] is True
    assert detail['edges'][0]['edge_type'] == 'Knows'
    assert detail['create_user'] == 'emp-1'

    with pytest.raises(KbApiError) as caught:
        svc.schema_detail('missing')
    assert 'graph.extract.schema.not.found' in caught.value.key


def test_millis_tolerates_plain_values():
    assert svc._millis(None) is None
    assert svc._millis(123) == '123'
    assert svc._millis('x') == 'x'


# ----------------------------------------------------------------------
# delete / create / update
# ----------------------------------------------------------------------


def test_delete_schema_allows_only_creator(schema_store):
    result = svc.delete_schema('s-1', 'emp-1', 'zh')
    assert result == {'schemaId': 's-1', 'schemaName': '模板一', 'deleted': True,
                      'message': result['message']}
    assert schema_store['deleted'] == ['s-1']

    with pytest.raises(KbApiError) as caught:
        svc.delete_schema('s-1', 'emp-2')
    assert 'permission.not.allow' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.delete_schema('missing', 'emp-1')
    assert 'graph.extract.schema.not.found' in caught.value.key


def test_create_schema_binds_dto_schema_id_not_generated_uuid(schema_store):
    schema_store['rows'].pop('s-1')   # 避开夹具里的同名既有行
    result = svc.create_schema(dict(SCHEMA), 'emp-1', None)
    assert result == {'schema_name': '模板一'}
    inserted = schema_store['inserted'][0]
    assert inserted['schema_id'] == 's-1'
    assert inserted['schema_obj']['schema_id'] == 's-1'


def test_create_schema_missing_id_still_inserts_none(schema_store):
    """刻意的坏行为：UUID 生成在对象上，INSERT 绑的是 DTO 的 None。"""
    schema_store['rows'].pop('s-1')
    payload = dict(SCHEMA)
    payload['schema_id'] = None
    svc.create_schema(payload, 'emp-1', None)
    assert schema_store['inserted'][0]['schema_id'] is None


def test_create_schema_rejects_duplicates(schema_store):
    with pytest.raises(KbApiError) as caught:
        svc.create_schema(dict(SCHEMA, schema_id='other'), 'emp-1', None)
    assert 'graph.schema.import.duplicate' in caught.value.key


def test_update_schema_renames_with_duplicate_guard(schema_store):
    result = svc.update_schema({**SCHEMA, 'schema_name': '模板一'}, 'emp-2')
    assert result == {'schema_name': '模板一'}

    # 校验在「名字查重」之后跑：空白名撞 validate_schema_name
    with pytest.raises(KbApiError) as caught:
        svc.update_schema(dict(SCHEMA, schema_name='  '), 'emp-1')
    assert 'graph.schema.name.invalid.chars' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.update_schema(dict(SCHEMA, schema_id='missing'), 'emp-1')
    assert 'graph.extract.schema.not.found' in caught.value.key


def test_to_schema_obj_preserves_none_edges():
    obj = svc.to_schema_obj({'schema_id': 's', 'schema_name': 'n', 'schema_desc': 'd',
                             'entities': None, 'edges': None})
    assert obj['entities'] is None and obj['edges'] is None

    obj = svc.to_schema_obj({'schema_name': 'n', 'schema_desc': 'd'})
    assert obj['schema_id'] is None and obj['entities'] is None and obj['edges'] is None


# ----------------------------------------------------------------------
# import
# ----------------------------------------------------------------------


def _zip_bytes(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def _import_doc():
    doc = json.loads(json.dumps(SCHEMA, ensure_ascii=False))
    doc['schema_id'] = 's-import'
    doc['schema_name'] = '导入模板'
    return doc


def test_import_schema_inserts_each_json_entry(schema_store):
    content = _zip_bytes({
        '导入模板.json': json.dumps(_import_doc(), ensure_ascii=False).encode(),
        'notes.txt': b'ignored',
    })
    result = svc.import_schema('bundle.zip', content, 'emp-1', None)
    assert result['successCount'] == 1
    assert result['failedCount'] == 0 and result['failedDetails'] == []
    assert '导入模板' in result['successIds']
    assert schema_store['inserted'][0]['created_by'] == 'emp-1'


def test_import_schema_generates_id_when_blank(schema_store):
    doc = _import_doc()
    doc['schema_id'] = '  '
    content = _zip_bytes({'x.json': json.dumps(doc, ensure_ascii=False).encode()})
    result = svc.import_schema('b.zip', content, 'emp-1', None)
    assert schema_store['inserted'][0]['schema_id'] not in ('', '  ', None)


def test_import_schema_size_and_format_guards(schema_store):
    big = b'x' * (svc.MAX_ZIP_FILE_SIZE_OF_MB * svc.FILE_SIZE_OF_1_MB + 1)
    with pytest.raises(KbApiError) as caught:
        svc.import_schema('b.zip', big, 'emp-1', None)
    assert 'file.size.limit.check' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.import_schema('b.zip', b'not a zip', 'emp-1', None)
    assert 'graph.schema.import.failed' in caught.value.key

    empty = _zip_bytes({'notes.txt': b'x'})
    with pytest.raises(KbApiError) as caught:
        svc.import_schema('b.zip', empty, 'emp-1', None)
    assert 'graph.schema.import.no.valid.structure' in caught.value.key


def test_import_schema_rejects_bad_json_entry(schema_store):
    content = _zip_bytes({'x.json': b'{invalid'})
    with pytest.raises(KbApiError) as caught:
        svc.import_schema('b.zip', content, 'emp-1', None)
    assert 'graph.schema.import.failed' in caught.value.key


def test_import_schema_rejects_duplicate_entry(schema_store):
    # 既有行 s-1 / 模板一：导入同 id 或同名都撞查重
    content = _zip_bytes({'x.json': json.dumps(SCHEMA, ensure_ascii=False).encode()})
    with pytest.raises(KbApiError) as caught:
        svc.import_schema('b.zip', content, 'emp-1', None)
    assert 'graph.schema.import.duplicate' in caught.value.key


def test_decode_entry_name_gbk_and_utf8_flags():
    import zipfile as _zip

    buffer = io.BytesIO()
    with _zip.ZipFile(buffer, 'w') as archive:
        archive.writestr('schema.json', b'{}')

    info = _zip.ZipInfo('模板.json')
    info.flag_bits = 0
    raw = '模板.json'.encode('gbk').decode('cp437', errors='replace')
    info.filename = raw
    assert svc._decode_entry_name(info).endswith('.json')

    info2 = _zip.ZipInfo('utf8.json')
    info2.flag_bits = 0x800
    assert svc._decode_entry_name(info2) == 'utf8.json'

    info3 = _zip.ZipInfo('bad\xff.json')
    info3.flag_bits = 0
    assert svc._decode_entry_name(info3).endswith('.json')


# ----------------------------------------------------------------------
# 校验器补充（既有测试没覆盖的分支）
# ----------------------------------------------------------------------


def test_validate_schema_name_and_desc():
    with pytest.raises(KbApiError):
        svc.validate_schema_name(None)
    with pytest.raises(KbApiError):
        svc.validate_schema_name('')
    with pytest.raises(KbApiError):
        svc.validate_schema_name('a' * 100)
    with pytest.raises(KbApiError):
        svc.validate_schema_name('bad name!')       # 空格与标点
    svc.validate_schema_name('模板_1')

    with pytest.raises(KbApiError):
        svc.validate_desc(None)
    with pytest.raises(KbApiError):
        svc.validate_desc('a' * 1001)
    with pytest.raises(KbApiError):
        svc.validate_desc('   ')
    svc.validate_desc('x')


def test_validate_property_name_and_type():
    null_key, reserved_key, length_key, chars_key = ('k.null', 'k.reserved',
                                                     'k.length', 'k.chars')
    with pytest.raises(KbApiError):
        svc.validate_property_name(None, null_key, reserved_key, length_key, chars_key)
    with pytest.raises(KbApiError):
        svc.validate_property_name('a' * 64, null_key, reserved_key, length_key,
                                   chars_key)
    with pytest.raises(KbApiError):
        svc.validate_property_name('1abc', null_key, reserved_key, length_key, chars_key)
    with pytest.raises(KbApiError):
        svc.validate_property_name('SELECT', null_key, reserved_key, length_key,
                                   chars_key)
    svc.validate_property_name('good_name', null_key, reserved_key, length_key,
                               chars_key)

    with pytest.raises(KbApiError):
        svc.validate_property_type(None)
    with pytest.raises(KbApiError):
        svc.validate_property_type('INT')      # 没有 INT
    svc.validate_property_type('INTEGER')


def test_validate_graph_schema_obj_end_to_end():
    svc.validate_graph_schema_obj(SCHEMA)

    broken = dict(SCHEMA, edges=None)
    with pytest.raises(KbServerError):
        svc.validate_graph_schema_obj(broken)

    broken = dict(SCHEMA, entities=[])
    with pytest.raises(KbApiError):
        svc.validate_graph_schema_obj(broken)

    duplicate_edge = dict(SCHEMA, edges=[
        {'edge_type': 'Knows', 'edge_desc': 'd', 'direction': 'ANY',
         'source_entity': 'Person', 'target_entity': 'Person', 'properties': []},
        {'edge_type': 'Knows', 'edge_desc': 'd', 'direction': 'ANY',
         'source_entity': 'Person', 'target_entity': 'Person', 'properties': []},
    ])
    with pytest.raises(KbApiError) as caught:
        svc.validate_graph_schema_obj(duplicate_edge)
    assert 'edge.duplicate.type' in caught.value.key

    undefined_ref = dict(SCHEMA, edges=[
        {'edge_type': 'Knows', 'edge_desc': 'd', 'direction': 'ANY',
         'source_entity': 'Robot', 'target_entity': 'Person', 'properties': []}])
    with pytest.raises(KbApiError) as caught:
        svc.validate_graph_schema_obj(undefined_ref)
    assert 'edge.entity.not.found' in caught.value.key


def test_entity_property_validators():
    with pytest.raises(KbApiError) as caught:
        svc.validate_entity_properties([], 'Person')
    assert 'property.not.empty' in caught.value.key

    properties = [{'name': 'a', 'type': 'STRING', 'desc': 'd', 'is_primary': True}]
    with pytest.raises(KbApiError) as caught:
        svc.validate_entity_properties([properties[0], dict(properties[0])], 'Person')
    assert 'property.duplicate.name' in caught.value.key

    with pytest.raises(KbApiError) as caught:
        svc.validate_entity_properties([{'name': 'a', 'type': 'STRING', 'desc': 'd'}],
                                       'Person')
    assert 'property.primary.not.found' in caught.value.key

    # 边属性允许为空；重复名仍拒绝
    svc.validate_edge_properties(None, 'Knows')
    svc.validate_edge_properties([], 'Knows')
    duplicate = [{'name': 'a', 'type': 'STRING', 'desc': 'd'}]
    with pytest.raises(KbApiError) as caught:
        svc.validate_edge_properties([duplicate[0], dict(duplicate[0])], 'Knows')
    assert 'edge.property.duplicate.name' in caught.value.key


def test_class_type_rules():
    with pytest.raises(KbApiError):
        svc.validate_class_type(None)
    with pytest.raises(KbApiError):
        svc.validate_class_type('')
    with pytest.raises(KbApiError):
        svc.validate_class_type('a' * 64)
    with pytest.raises(KbApiError):
        svc.validate_class_type('Person2')     # 数字被拒（正则不含数字）
    with pytest.raises(KbApiError):
        svc.validate_class_type('ORDER')
    svc.validate_class_type('PersonCompany')


def test_validate_schema_entities_desc_and_duplicates():
    entities = [{'entity_type': 'Person', 'entity_desc': 'd', 'properties': [
        {'name': 'a', 'type': 'STRING', 'desc': 'd', 'is_primary': True}]}]
    svc.validate_schema_entities(entities)

    duplicate = [entities[0], dict(entities[0])]
    with pytest.raises(KbApiError) as caught:
        svc.validate_schema_entities(duplicate)
    assert 'entities.duplicate.entity_type' in caught.value.key

    bad_desc = [dict(entities[0], entity_desc=None)]
    with pytest.raises(KbApiError) as caught:
        svc.validate_schema_entities(bad_desc)
    assert 'desc.null' in caught.value.key


def test_entity_and_edge_normalizers():
    entity = svc._entity({'entity_type': 'Person', 'entity_desc': 'd',
                          'properties': [{'name': 'a', 'type': 'STRING'}],
                          'unknown': 1})
    assert list(entity) == list(svc.ENTITY_KEYS)
    assert svc._entity({'entity_type': 'P', 'entity_desc': 'd', 'properties': None})[
        'properties'] is None

    edge = svc._edge({'edge_type': 'Knows', 'edge_desc': 'd', 'direction': 'ANY',
                      'source_entity': 'Person', 'target_entity': 'Person',
                      'properties': [{'name': 'a', 'type': 'STRING'}]})
    assert list(edge) == list(svc.EDGE_KEYS)
    assert svc._edge({'edge_type': 'K', 'edge_desc': 'd', 'direction': 'ANY',
                      'source_entity': 'Person', 'target_entity': 'Person',
                      'properties': None})['properties'] is None
