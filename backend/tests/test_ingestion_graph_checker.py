"""``GraphChecker``（知识图谱数据检查器）的纯逻辑测试。

不连 DB / 网络：schema 与实体/边数据全部就地构造。钉住：

1. 实体/边数据的完整校验链（type → id → source/target → properties）；
2. 属性类型修复（LLM 产出的值类型不可信，需按 schema 转换或填默认值）；
3. 主键属性不允许为空。

跑法::

    python -m pytest tests/test_ingestion_graph_checker.py -q
"""

import logging
from datetime import datetime

import pytest

from ingestion.client.graph_checker import GraphChecker

SCHEMA = {
    'entities': [
        {
            'entity_type': 'Person',
            'properties': [
                {'name': 'name', 'type': 'STRING', 'is_primary': True},
                {'name': 'age', 'type': 'INTEGER'},
            ],
        },
        {
            'entity_type': 'Event',
            'properties': [{'name': 'date', 'type': 'DATE'}],
        },
    ],
    'edges': [
        {
            'edge_type': 'KNOWS',
            'properties': [
                {'name': 'since', 'type': 'STRING', 'is_primary': True},
                {'name': 'weight', 'type': 'DOUBLE'},
            ],
        },
    ],
}

PERSON_ENTITY = {
    'entity_type': 'Person',
    'entity_id': 'Person_alice',
    'properties': {
        'chunk_id': 'c-1',
        'name': 'alice',
        'age': 30,
    },
}

KNOWS_EDGE = {
    'edge_type': 'KNOWS',
    'edge_id': 'KNOWS_1',
    'source_id': 'Person_alice',
    'target_id': 'Person_bob',
    'properties': {'since': '2020', 'weight': 0.5},
}


def _checker(schema=None):
    return GraphChecker(SCHEMA if schema is None else schema)


# ---------------------------------------------------------------------------
# 构造与基础校验
# ---------------------------------------------------------------------------

def test_schema_without_definitions_is_accepted():
    checker = _checker({})
    assert checker.entity_definitions == {}
    assert checker.edge_definitions == {}


def test_schema_skips_entries_without_type():
    checker = _checker({
        'entities': [{'entity_type': '', 'properties': []}, {'no_type': True}],
        'edges': [{'edge_type': None}],
    })
    assert checker.entity_definitions == {}
    assert checker.edge_definitions == {}


@pytest.mark.parametrize('value, field', [
    (None, 'x'),
    (42, 'x'),
    ('   ', 'x'),
])
def test_non_empty_string_rejects(value, field):
    assert _checker()._validate_non_empty_string(value, field) is not None


def test_non_empty_string_accepts():
    assert _checker()._validate_non_empty_string('ok', 'x') is None


def test_id_prefix_must_match():
    assert _checker()._validate_id_prefix('Edge_1', 'Person', "Entity 'entity_id'")


# ---------------------------------------------------------------------------
# 属性字段集合与取值校验
# ---------------------------------------------------------------------------

def test_properties_field_count_reports_missing_and_extra():
    props = {'chunk_id': 'c', 'extra': 1}
    expected = {'name', 'age', 'chunk_id'}
    error = _checker()._validate_properties_field_count(props, expected, exclude_chunk_id=True)
    # 集合求差后 join，先后顺序不保证 —— 只断言两段都在
    assert 'Property fields mismatch' in error
    assert 'name' in error and 'age' in error
    assert 'Extra properties: extra' in error


def test_properties_field_count_exact_match():
    assert _checker()._validate_properties_field_count({'name': 'a'}, {'name'}) is None


def test_validate_property_value_primary_rules():
    checker = _checker()
    primary = {'name': 'name', 'type': 'STRING', 'is_primary': True}
    assert checker._validate_property_value('name', None, primary)
    assert checker._validate_property_value('name', '  ', primary)
    assert checker._validate_property_value('name', '', primary)
    assert checker._validate_property_value('name', 'alice', primary) is None


def test_validate_property_value_nullable_date():
    checker = _checker()
    assert checker._validate_property_value('date', None, {'name': 'date', 'type': 'DATE'}) is None
    assert checker._validate_property_value('date', None, {'name': 'date', 'type': 'STRING'})


# ---------------------------------------------------------------------------
# check_entity_data / check_edge_data 校验链
# ---------------------------------------------------------------------------

def test_valid_entity_passes():
    assert _checker().check_entity_data(PERSON_ENTITY) == (True, None)


def test_valid_edge_passes():
    assert _checker().check_edge_data(KNOWS_EDGE) == (True, None)


def test_entity_missing_type_field():
    ok, error = _checker().check_entity_data({'entity_id': 'Person_a'})
    assert ok is False
    assert error == "Entity data missing 'entity_type' field"


def test_entity_type_not_in_schema():
    ok, error = _checker().check_entity_data({**PERSON_ENTITY, 'entity_type': 'Robot'})
    assert ok is False
    assert "Entity type 'Robot' is not defined in schema" in error


def test_entity_id_missing_or_bad():
    checker = _checker()
    ok, error = checker.check_entity_data({'entity_type': 'Person'})
    assert error == "Entity data missing required 'entity_id' field"
    ok, error = checker.check_entity_data({**PERSON_ENTITY, 'entity_id': None})
    assert error == "Entity 'entity_id' cannot be empty"
    ok, error = checker.check_entity_data({**PERSON_ENTITY, 'entity_id': 'Robot_x'})
    assert "must start with 'Person_'" in error


def test_entity_missing_properties_field():
    data = {k: v for k, v in PERSON_ENTITY.items() if k != 'properties'}
    ok, error = _checker().check_entity_data(data)
    assert error == "Entity data missing 'properties' field"


def test_entity_missing_chunk_id():
    props = {k: v for k, v in PERSON_ENTITY['properties'].items() if k != 'chunk_id'}
    ok, error = _checker().check_entity_data({**PERSON_ENTITY, 'properties': props})
    assert error == "Entity data missing required 'chunk_id' field"


def test_entity_chunk_id_empty_is_rejected():
    props = {**PERSON_ENTITY['properties'], 'chunk_id': '  '}
    ok, error = _checker().check_entity_data({**PERSON_ENTITY, 'properties': props})
    assert error == "Entity 'chunk_id' cannot be empty"


def test_entity_extra_property_is_rejected_by_field_count():
    props = {**PERSON_ENTITY['properties'], 'nickname': 'x'}
    ok, error = _checker().check_entity_data({**PERSON_ENTITY, 'properties': props})
    assert 'Property fields mismatch' in error and 'nickname' in error


def test_entity_none_property_is_rejected():
    props = {**PERSON_ENTITY['properties'], 'age': ''}
    ok, error = _checker().check_entity_data({**PERSON_ENTITY, 'properties': props})
    # 非主键允许空字符串；None 才拒绝 —— 用 INTEGER 主键外字段验证 None 分支
    assert error is None
    props = {**PERSON_ENTITY['properties'], 'name': ''}
    ok, error = _checker().check_entity_data({**PERSON_ENTITY, 'properties': props})
    assert "Primary key property 'name' cannot be empty" in error


def test_edge_missing_type_and_bad_ids():
    checker = _checker()
    ok, error = checker.check_edge_data({'edge_id': 'KNOWS_1'})
    assert error == "Edge data missing 'edge_type' field"
    ok, error = checker.check_edge_data({**KNOWS_EDGE, 'edge_type': 'HATES'})
    assert "Edge type 'HATES' is not defined in schema" in error
    ok, error = checker.check_edge_data({**KNOWS_EDGE, 'edge_id': 'X_1'})
    assert "must start with 'KNOWS_'" in error
    ok, error = checker.check_edge_data({k: v for k, v in KNOWS_EDGE.items() if k != 'edge_id'})
    assert error == "Edge data missing required 'edge_id' field"


def test_edge_bad_id_and_none_property():
    checker = _checker()
    ok, error = checker.check_edge_data({**KNOWS_EDGE, 'edge_id': None})
    assert error == "Edge 'edge_id' cannot be empty"
    props = {**KNOWS_EDGE['properties'], 'weight': None}
    ok, error = checker.check_edge_data({**KNOWS_EDGE, 'properties': props})
    assert error == "Property 'weight' cannot be None"


def test_edge_missing_source_and_target():
    checker = _checker()
    ok, error = checker.check_edge_data({k: v for k, v in KNOWS_EDGE.items() if k != 'source_id'})
    assert error == "Edge data missing required 'source_id' field"
    ok, error = checker.check_edge_data({k: v for k, v in KNOWS_EDGE.items() if k != 'target_id'})
    assert error == "Edge data missing required 'target_id' field"
    ok, error = checker.check_edge_data({**KNOWS_EDGE, 'source_id': ''})
    assert error == "Edge 'source_id' cannot be empty"


def test_edge_missing_properties_field():
    data = {k: v for k, v in KNOWS_EDGE.items() if k != 'properties'}
    ok, error = _checker().check_edge_data(data)
    assert error == "Edge data missing 'properties' field"


def test_edge_property_mismatch_and_undefined():
    checker = _checker()
    props = {'since': '2020'}
    ok, error = checker.check_edge_data({**KNOWS_EDGE, 'properties': props})
    assert 'Missing properties: weight' in error
    props = {**KNOWS_EDGE['properties'], 'weak': None}
    ok, error = checker.check_edge_data({**KNOWS_EDGE, 'properties': props})
    assert 'Property fields mismatch' in error and 'weak' in error


# ---------------------------------------------------------------------------
# 属性修复：缺省填充与类型转换
# ---------------------------------------------------------------------------

def test_default_value_for_type_matrix():
    checker = _checker()
    assert checker._default_value_for_type('') == ''
    assert checker._default_value_for_type(None) == ''
    assert checker._default_value_for_type('string') == ''
    assert checker._default_value_for_type('BYTE') == 0
    assert checker._default_value_for_type('SHORT') == 0
    assert checker._default_value_for_type('INTEGER') == 0
    assert checker._default_value_for_type('LONG') == 0
    assert checker._default_value_for_type('FLOAT') == 0.0
    assert checker._default_value_for_type('DOUBLE') == 0.0
    assert checker._default_value_for_type('BOOLEAN') is False
    assert checker._default_value_for_type('DATE') is None
    assert checker._default_value_for_type('DATETIME') is None
    assert checker._default_value_for_type('EMBEDDEDLIST') == []
    assert checker._default_value_for_type('EMBEDDEDSET') == []
    assert checker._default_value_for_type('LINKLIST') == []
    assert checker._default_value_for_type('LINKSET') == []
    assert checker._default_value_for_type('EMBEDDEDMAP') == {}
    assert checker._default_value_for_type('LINKMAP') == {}
    assert checker._default_value_for_type('EMBEDDED') == {}
    assert checker._default_value_for_type('BINARY') == ''
    assert checker._default_value_for_type('LINK') == ''
    assert checker._default_value_for_type('WHATEVER') == ''


def test_default_value_is_non_string():
    checker = _checker()
    assert checker._default_value_is_non_string('integer') is True
    assert checker._default_value_is_non_string('BOOLEAN') is True
    assert checker._default_value_is_non_string('STRING') is False
    assert checker._default_value_is_non_string('') is False
    assert checker._default_value_is_non_string(None) is False


def test_is_value_match_type():
    checker = _checker()
    assert checker._is_value_match_type(None, 'STRING') is True
    assert checker._is_value_match_type('x', '') is True
    assert checker._is_value_match_type('x', 'STRING') is True
    assert checker._is_value_match_type(1, 'INTEGER') is True
    assert checker._is_value_match_type(True, 'INTEGER') is False
    assert checker._is_value_match_type(1.5, 'DOUBLE') is True
    assert checker._is_value_match_type(True, 'BOOLEAN') is True
    assert checker._is_value_match_type(1, 'BOOLEAN') is False
    assert checker._is_value_match_type(object(), 'MYSTERY') is True


def test_try_convert_to_int():
    checker = _checker()
    assert checker._try_convert_to_int(True) == (1, False)
    assert checker._try_convert_to_int(7) == (7, False)
    assert checker._try_convert_to_int(7.9) == (7, False)
    assert checker._try_convert_to_int(' 8 ') == (8, False)
    assert checker._try_convert_to_int('   ') == (None, True)
    assert checker._try_convert_to_int('abc') == (None, True)
    assert checker._try_convert_to_int(object()) == (None, True)


def test_try_convert_to_float():
    checker = _checker()
    assert checker._try_convert_to_float(False) == (0.0, False)
    assert checker._try_convert_to_float(2) == (2.0, False)
    assert checker._try_convert_to_float('2.5') == (2.5, False)
    assert checker._try_convert_to_float(' ') == (None, True)
    assert checker._try_convert_to_float('x') == (None, True)
    assert checker._try_convert_to_float(object()) == (None, True)


def test_try_convert_to_bool_truthy_and_falsy():
    checker = _checker()
    for raw in ('true', '是', '1', 'yes', 'y', 't', 'TRUE '):
        assert checker._try_convert_to_bool(raw) == (True, False), raw
    for raw in ('false', '否', '0', 'no', 'n', 'f'):
        assert checker._try_convert_to_bool(raw) == (False, False), raw
    assert checker._try_convert_to_bool(0) == (False, False)
    assert checker._try_convert_to_bool(2.5) == (True, False)
    assert checker._try_convert_to_bool(True) == (True, False)
    assert checker._try_convert_to_bool('maybe') == (None, True)
    assert checker._try_convert_to_bool(object()) == (None, True)


def test_try_convert_to_date_formats():
    checker = _checker()
    assert checker._try_convert_to_date(None) == (None, False)
    assert checker._try_convert_to_date('  ') == (None, False)
    assert checker._try_convert_to_date('None') == (None, False)
    cases = {
        '2024-01-02': '2024-01-02T00:00:00',
        '2024/01/02': '2024-01-02T00:00:00',
        '2024-01-02 03:04:05': '2024-01-02T03:04:05',
        '2024/01/02 03:04:05': '2024-01-02T03:04:05',
        '2024-01-02 03:04': '2024-01-02T03:04:00',
        '2024/01/02 03:04': '2024-01-02T03:04:00',
        '2024年01月02日': '2024-01-02T00:00:00',
        '2024-01-02T03:04:05': '2024-01-02T03:04:05',
    }
    for raw, expected in cases.items():
        assert checker._try_convert_to_date(raw) == (expected, False), raw
    parsed = datetime(2024, 1, 2)
    assert checker._try_convert_to_date(parsed) == ('2024-01-02T00:00:00', False)
    # 所有意备用格式都失败：返回 (None, False)，由默认值路径兜底
    assert checker._try_convert_to_date('not-a-date') == (None, False)


def test_try_convert_value_to_type_dispatch():
    checker = _checker()
    assert checker._try_convert_value_to_type(None, 'STRING') == (None, False)
    assert checker._try_convert_value_to_type('', 'STRING') == ('', False)
    assert checker._try_convert_value_to_type('x', '') == ('x', False)
    assert checker._try_convert_value_to_type('2024-01-02', 'DATE') == ('2024-01-02T00:00:00', False)
    assert checker._try_convert_value_to_type('nope', 'DATETIME') == (None, False)
    assert checker._try_convert_value_to_type(5, 'INTEGER') == (5, False)
    assert checker._try_convert_value_to_type('6', 'LONG') == (6, False)
    assert checker._try_convert_value_to_type('6.5', 'FLOAT') == (6.5, False)
    assert checker._try_convert_value_to_type('是', 'BOOLEAN') == (True, False)
    # 未知类型不强制转换：值与类型不匹配时原样返回
    assert checker._try_convert_value_to_type(object(), 'MYSTERY') is not None
    assert checker._try_convert_value_to_type(123, 'STRING') == (123, False)


def test_fix_property_value_primary_empty_is_error():
    checker = _checker()
    prop_def = {'name': 'name', 'type': 'STRING', 'is_primary': True}
    value, error = checker.validate_and_fix_property_value('name', None, prop_def)
    assert value is None and 'is primary key and cannot be empty' in error
    bad_primary = {'name': 'age', 'type': 'INTEGER', 'is_primary': True}
    value, error = checker.validate_and_fix_property_value('age', 'oops', bad_primary, is_entity=False)
    assert value is None and 'cannot be converted' in error
    # 非主键转换失败 → 填 schema 默认值而不是报错
    value, error = checker.validate_and_fix_property_value('age', 'oops', {'name': 'age', 'type': 'INTEGER'},
                                                           is_entity=False)
    assert (value, error) == (0, None)


def test_fix_property_value_fills_schema_default(caplog):
    checker = _checker()
    with caplog.at_level(logging.WARNING):
        value, error = checker.validate_and_fix_property_value('age', None, {'name': 'age', 'type': 'INTEGER'})
        assert (value, error) == (0, None)
        value, error = checker.validate_and_fix_property_value('weight', '', {'name': 'weight', 'type': 'DOUBLE'})
        assert (value, error) == (0.0, None)
    assert 'converting to schema default' in caplog.text


def test_fix_property_value_converts_and_warns(caplog):
    checker = _checker()
    with caplog.at_level(logging.WARNING):
        value, error = checker.validate_and_fix_property_value('age', '31', {'name': 'age', 'type': 'INTEGER'})
    assert (value, error) == (31, None)
    assert 'converted to' in caplog.text


def test_fix_property_value_identity_needs_no_warning(caplog):
    checker = _checker()
    with caplog.at_level(logging.WARNING):
        value, error = checker.validate_and_fix_property_value('name', 'alice', {'name': 'name', 'type': 'STRING'})
    assert (value, error) == ('alice', None)
    assert 'converted to' not in caplog.text


def test_fix_entity_properties_fills_missing_and_skips_extra(caplog):
    checker = _checker()
    with caplog.at_level(logging.WARNING):
        fixed, error = checker.validate_and_fix_entity_properties(
            {'chunk_id': 'c-1', 'name': 'alice', 'nickname': 'x'}, SCHEMA['entities'][0])
    assert error is None
    assert fixed == {'chunk_id': 'c-1', 'name': 'alice', 'age': 0}
    assert "missing property 'age'" in caplog.text


def test_fix_entity_properties_missing_primary_is_error():
    checker = _checker()
    fixed, error = checker.validate_and_fix_entity_properties({'chunk_id': 'c-1', 'age': 1},
                                                              SCHEMA['entities'][0])
    assert fixed == {}
    assert "missing primary key property 'name'" in error


def test_fix_entity_properties_short_circuits_on_bad_value():
    checker = _checker()
    fixed, error = checker.validate_and_fix_entity_properties({'name': None}, SCHEMA['entities'][0])
    assert fixed == {} and error


def test_fix_edge_properties_fills_defaults(caplog):
    checker = _checker()
    with caplog.at_level(logging.WARNING):
        fixed, error = checker.validate_and_fix_edge_properties({'since': '2020'}, SCHEMA['edges'][0])
    assert error is None
    assert fixed == {'since': '2020', 'weight': 0.0}
    assert "edge missing property 'weight'" in caplog.text


def test_fix_edge_properties_skips_unknown_and_reports_bad_primary():
    checker = _checker()
    # 未定义的属性被跳过；缺失的按 schema 默认值补齐（边修复不做字段数校验）
    fixed, error = checker.validate_and_fix_edge_properties(
        {'since': '2020', 'weak': 1}, SCHEMA['edges'][0])
    assert error is None
    assert fixed == {'since': '2020', 'weight': 0.0}
    # 主键取值非法 → 返回错误并放弃整组属性
    fixed, error = checker.validate_and_fix_edge_properties({'since': None}, SCHEMA['edges'][0])
    assert fixed == {}
    assert 'is primary key and cannot be empty' in error
