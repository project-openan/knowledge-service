"""算子服务层（``operator_service``）的读路径与状态翻转测试。

不连库：``operator_store`` 的查询函数全部用假的替换。这一层要钉的是
**VO 组装契约**（null / 空列表 / "null" 字符串的区别）与「照直觉写就会错」的
状态翻转语义，而不是 SQL。

跑法（服务目录下）::

    python -m pytest tests/test_operator_service_catalog.py -q
"""

from datetime import datetime
from pathlib import Path

import pytest

from shared.errors.api import KbApiError, KbServerError
from operators.repository import operator_store
from operators.service import operator_service, system_operator


OPERATOR_ROW = {
    'id': 1,
    'visible_range': 'public',
    'version': '1.0.0',
    'module': 'retriever',          # 环节名：列表里会被改写成 rag_operator
    'name': '甲',
    'name_en': 'A',
    'description': '描述',
    'description_en': 'desc',
    'is_published': True,
    'system': None,
    'created_at': datetime(2026, 10, 5, 4, 49, 42),
    'created_by': 'admin',
    'updated_at': datetime(2026, 10, 6, 8, 0, 0),
    'updated_by': 'admin',
}


def _row(**overrides):
    payload = dict(OPERATOR_ROW)
    payload.update(overrides)
    return payload


@pytest.fixture()
def empty_store(monkeypatch):
    """查询全部落空：列表为空、参数/属性查不到。"""
    monkeypatch.setattr(operator_store, 'search_operators', lambda *a, **k: [])
    monkeypatch.setattr(operator_store, 'count_operators', lambda *a, **k: 0)
    monkeypatch.setattr(operator_store, 'select_by_id', lambda operator_id: None)
    monkeypatch.setattr(operator_store, 'select_by_creator', lambda operator_id, emp: None)
    monkeypatch.setattr(operator_store, 'select_by_org_id', lambda operator_id, org: None)
    monkeypatch.setattr(operator_store, 'select_by_name', lambda name, org_id=None: [])
    monkeypatch.setattr(operator_store, 'select_ids_by_format', lambda fmt: [])
    monkeypatch.setattr(operator_store, 'select_published_by_condition',
                        lambda ids, keyword, module, org, emp: [])
    monkeypatch.setattr(operator_store, 'select_by_module', lambda module, org_id=None: [])
    monkeypatch.setattr(operator_store, 'list_params_by_operator_ids', lambda ids: {})
    monkeypatch.setattr(operator_store, 'list_props_by_operator_ids', lambda ids: {})
    monkeypatch.setattr(operator_store, 'list_params_by_operator_id', lambda operator_id: [])
    monkeypatch.setattr(operator_store, 'list_props_by_operator_id', lambda operator_id: {})


# ----------------------------------------------------------------------
# VO 装配
# ----------------------------------------------------------------------


def test_param_vo_keeps_fixed_key_order_and_parses_json_maps():
    vo = operator_service._param_vo({
        'arg_name': 'top_k', 'arg_type': 'int', 'default_value': '8',
        'description': '取数', 'placeholder': '{"zh": "填数字"}', 'tips': '{"zh": "提示"}',
    })

    # 键序固定：placeholder 在 tips 之前（前端按声明序渲染）
    assert list(vo.keys()) == ['argName', 'argType', 'defaultValue', 'description',
                               'placeholder', 'tips']
    assert vo['placeholder'] == {'zh': '填数字'}
    assert vo['tips'] == {'zh': '提示'}


def test_parse_json_map_survives_garbage(monkeypatch, caplog):
    """tips/placeholder 解析失败**只告警、字段留空** —— 与 convertDefaultValues（要抛）不同。"""
    assert operator_service._parse_json_map(None) is None
    assert operator_service._parse_json_map('') is None
    assert operator_service._parse_json_map('{"ok": 1}') == {'ok': 1}

    caplog.set_level('WARNING')
    assert operator_service._parse_json_map('{oops') is None
    assert 'failed to parse operator param json' in caplog.text


def test_operator_vo_null_args_vs_empty_args_are_different(empty_store):
    """``args``：库里没有参数行 → ``null``；有但为空 → ``[]``。两者在 JSON 里不同。"""
    vo_null = operator_service._operator_vo(_row(), None, rewrite_module=True)
    vo_empty = operator_service._operator_vo(_row(), [], rewrite_module=True)

    assert vo_null['args'] is None
    assert vo_empty['args'] == []
    # module 改写：环节名 → rag_operator
    assert vo_null['module'] == 'rag_operator'
    assert vo_null['createdDate'] == '2026-10-05 04:49:42'
    assert vo_null['prop'] is None


def test_operator_vo_with_prop_reads_store(empty_store):
    """``GET /operator/{id}`` 才带 prop；空表给 **null** 不给 ``{}``。"""
    vo = operator_service._operator_vo(_row(), [], rewrite_module=False, with_prop=True)

    assert vo['prop'] is None
    # 详情路径**不改写** module：吐库里的原值
    assert vo['module'] == 'retriever'


def test_operator_vo_system_flag_maps_to_0_1_null():
    assert operator_service._operator_vo(_row(system=True), [], rewrite_module=False)['system'] == 1
    assert operator_service._operator_vo(_row(system=False), [], rewrite_module=False)['system'] == 0
    assert operator_service._operator_vo(_row(system=None), [], rewrite_module=False)['system'] is None


def test_vos_for_rows_missing_param_group_yields_null_args(empty_store):
    """批量装配：params map 里没有这个 id → ``args`` 是 null（``map.get`` 语义）。"""
    monkeypatch_rows = [_row(id=7)]
    import operators.service.operator_service as svc

    vos = svc._vos_for_rows(monkeypatch_rows, rewrite_module=True)
    assert vos[0]['args'] is None


# ----------------------------------------------------------------------
# 分页列表
# ----------------------------------------------------------------------


def test_list_operators_requires_page_params():
    """currentPage / pageSize 缺一个就是 0001（服务器错误），不能兜底默认值。"""
    with pytest.raises(KbServerError):
        operator_service.list_operators({'pageSize': 20}, 'admin', None)
    with pytest.raises(KbServerError):
        operator_service.list_operators({'currentPage': 1}, 'admin', None)


def test_list_operators_empty_total_returns_empty_page(monkeypatch):
    monkeypatch.setattr(operator_store, 'count_operators', lambda *a, **k: 0)
    touched = []

    def _fail_search(*a, **k):
        touched.append('search')
        return []

    monkeypatch.setattr(operator_store, 'search_operators', _fail_search)

    page = operator_service.list_operators({'currentPage': 2, 'pageSize': 10}, 'admin', 'org-1')

    assert page == {'items': [], 'total': 0, 'page': 2, 'pageSize': 10}
    # total=0 直接短路：连查询都不发
    assert touched == []


def test_list_operators_format_filter_and_vo_assembly(monkeypatch):
    seen = {}

    def _count(operator_ids, visible_range, keyword, module, org_id, emp_no):
        seen.update(ids=operator_ids, visible=visible_range, keyword=keyword,
                    module=module, org=org_id, emp=emp_no)
        return 1

    rows = [_row(id=3)]
    monkeypatch.setattr(operator_store, 'select_ids_by_format', lambda fmt: [3] if fmt == 'md' else [])
    monkeypatch.setattr(operator_store, 'count_operators', _count)
    monkeypatch.setattr(operator_store, 'search_operators',
                        lambda *a, **k: [dict(r) for r in rows])
    monkeypatch.setattr(operator_store, 'list_params_by_operator_ids',
                        lambda ids: {3: [{'arg_name': 'k', 'arg_type': 'int',
                                          'default_value': '8', 'description': 'd'}]})

    page = operator_service.list_operators(
        {'currentPage': 1, 'pageSize': 20, 'keyword': '甲', 'module': 'rag_operator',
         'visibleRange': None, 'format': 'md'}, 'admin', 'org-9')

    assert seen == {'ids': [3], 'visible': None, 'keyword': '甲', 'module': 'rag_operator',
                    'org': 'org-9', 'emp': 'admin'}
    vo = page['items'][0]
    assert vo['module'] == 'rag_operator'
    # 分页列表吐的是库里的**原始字符串** defaultValue（出口转换只在 support 等三处）
    assert vo['args'][0]['defaultValue'] == '8'


def test_list_operators_without_format_skips_format_lookup(monkeypatch):
    def _boom(fmt):
        raise AssertionError('format 为空时不应查 operator_prop')

    monkeypatch.setattr(operator_store, 'select_ids_by_format', _boom)
    monkeypatch.setattr(operator_store, 'count_operators', lambda *a, **k: 0)

    # format 键存在但为空串：同样不查
    assert operator_service.list_operators(
        {'currentPage': 1, 'pageSize': 5, 'format': ''}, 'admin', None)['total'] == 0


def test_list_by_module_rewrites_module(monkeypatch):
    monkeypatch.setattr(operator_store, 'search_operators',
                        lambda *a, **k: [_row(id=3, module='retriever')])
    monkeypatch.setattr(operator_store, 'list_params_by_operator_ids', lambda ids: {})

    vos = operator_service.list_by_module('retriever', 'admin', 'org-1')

    assert [vo['module'] for vo in vos] == ['rag_operator']


def test_list_system_operators_returns_registry_vos():
    """``GET /operator/system`` 来自内置注册表（不在库里），id 是负数。"""
    vos = operator_service.list_system_operators()

    assert [vo['id'] for vo in vos] == [-1, -2]
    assert all(vo['system'] is None for vo in vos)


# ----------------------------------------------------------------------
# 画布：rag_workflow/supported
# ----------------------------------------------------------------------


def test_rag_workflow_supported_empty_module_is_empty(monkeypatch):
    monkeypatch.setattr(operator_store, 'select_by_module', lambda module, org_id=None: [])
    assert operator_service.rag_workflow_supported('', 'org-1') == []


def test_rag_workflow_supported_missing_prop_becomes_string_null(monkeypatch):
    """prop 缺失时 ``position``/``operator`` 是**字符串 "null"**，不是 Python 的 None。"""
    monkeypatch.setattr(operator_store, 'select_by_module',
                        lambda module, org_id=None: [_row(id=3, module='retriever')])
    monkeypatch.setattr(operator_store, 'list_params_by_operator_ids',
                        lambda ids: {3: [{'arg_name': 'k', 'arg_type': 'int',
                                          'default_value': '8', 'description': 'd'}]})
    monkeypatch.setattr(operator_store, 'list_props_by_operator_ids', lambda ids: {})

    result = operator_service.rag_workflow_supported('retriever', 'org-1')

    assert result == [{'id': 3, 'position': 'null', 'operator': 'null',
                       'operatorName': '甲', 'defaultArgs': {'k': 8}}]


def test_rag_workflow_supported_converts_defaults_by_arg_type(monkeypatch):
    monkeypatch.setattr(operator_store, 'select_by_module',
                        lambda module, org_id=None: [_row(id=3, module='retriever')])
    monkeypatch.setattr(operator_store, 'list_params_by_operator_ids', lambda ids: {
        3: [{'arg_name': 'a', 'arg_type': 'bool', 'default_value': 'true', 'description': ''},
            {'arg_name': 'b', 'arg_type': 'int', 'default_value': None, 'description': ''}]})
    monkeypatch.setattr(operator_store, 'list_props_by_operator_ids',
                        lambda ids: {3: {'position': 'p1', 'operator': 'CustomOp'}})

    result = operator_service.rag_workflow_supported('retriever', None)

    assert result[0]['position'] == 'p1'
    assert result[0]['defaultArgs'] == {'a': True, 'b': None}


# ----------------------------------------------------------------------
# 单条查询与状态翻转
# ----------------------------------------------------------------------


def test_get_operator_not_found_is_0005(empty_store):
    with pytest.raises(KbApiError) as excinfo:
        operator_service.get_operator(404)
    assert excinfo.value.key == 'RetCode.operator.notfound'


def test_get_operator_returns_raw_module_and_props(monkeypatch):
    monkeypatch.setattr(operator_store, 'select_by_id', lambda operator_id: _row(id=1))
    monkeypatch.setattr(operator_store, 'list_params_by_operator_id', lambda operator_id: [])
    monkeypatch.setattr(operator_store, 'list_props_by_operator_id',
                        lambda operator_id: {'position': 'p1'})

    vo = operator_service.get_operator(1)

    assert vo['module'] == 'retriever'          # 详情不改写
    assert vo['prop'] == {'position': 'p1'}


def test_flip_publish_ladder(monkeypatch):
    """没查到 → 未找到；已是目标状态 → 「重复发布」；否则写库。"""
    calls = []
    monkeypatch.setattr(operator_store, 'select_by_creator',
                        lambda operator_id, emp: _row(id=1, is_published=True))
    monkeypatch.setattr(operator_store, 'set_publish_status',
                        lambda operator_id, status, emp: calls.append((operator_id, status)))

    with pytest.raises(KbApiError) as repeat:
        operator_service.flip_publish(1, 'admin', operator_service.PUBLISH)
    assert repeat.value.key == 'RetCode.operator.publish.repeat'

    operator_service.flip_publish(1, 'admin', operator_service.UN_PUBLISH)
    assert calls == [(1, False)]


def test_flip_publish_not_found(monkeypatch):
    monkeypatch.setattr(operator_store, 'select_by_creator', lambda operator_id, emp: None)
    with pytest.raises(KbApiError) as excinfo:
        operator_service.flip_publish(1, 'admin', operator_service.PUBLISH)
    assert excinfo.value.key == 'RetCode.operator.notfound'


def test_flip_public_ladder(monkeypatch):
    calls = []
    monkeypatch.setattr(operator_store, 'select_by_creator',
                        lambda operator_id, emp: _row(id=1, visible_range='private'))
    monkeypatch.setattr(operator_store, 'set_public_status',
                        lambda operator_id, target, emp: calls.append(target))

    with pytest.raises(KbApiError) as repeat:
        operator_service.flip_public(1, 'admin', 'private')
    assert repeat.value.key == 'RetCode.operator.publish.repeat'

    operator_service.flip_public(1, 'admin', operator_service.VISIBLE_PUBLIC)
    assert calls == ['public']


def test_flip_public_not_found(monkeypatch):
    monkeypatch.setattr(operator_store, 'select_by_creator', lambda operator_id, emp: None)
    with pytest.raises(KbApiError):
        operator_service.flip_public(1, 'admin', 'public')


def test_mark_system_delegates_without_owner_check(monkeypatch):
    """``POST /operator/system/{id}``：没有创建者校验，直接更新。"""
    calls = []
    monkeypatch.setattr(operator_store, 'update_system',
                        lambda operator_id, emp: calls.append((operator_id, emp)))

    operator_service.mark_system(1, 'admin')

    assert calls == [(1, 'admin')]


# ----------------------------------------------------------------------
# 删除（物理删除 + PVC 清理）
# ----------------------------------------------------------------------


def test_delete_operator_requires_row(monkeypatch, empty_store):
    with pytest.raises(KbApiError) as excinfo:
        operator_service.delete_operator(404, 'org-1')
    assert excinfo.value.key == 'RetCode.operator.notfound'


def test_delete_operator_removes_pvc_files_then_rows(monkeypatch, tmp_path):
    python_file = tmp_path / 'operator' / 'abc'
    zip_file = tmp_path / 'operator_zip' / 'def'
    python_file.parent.mkdir(parents=True)
    zip_file.parent.mkdir(parents=True)
    python_file.write_bytes(b'p')
    zip_file.write_bytes(b'z')

    monkeypatch.setattr(operator_store, 'select_by_org_id',
                        lambda operator_id, org: _row(id=1, operator_path=str(python_file),
                                                      operator_zip_path=str(zip_file)))
    deleted = []
    monkeypatch.setattr(operator_store, 'delete_operator',
                        lambda operator_id: deleted.append(operator_id))

    operator_service.delete_operator(1, 'org-1')

    assert not python_file.exists() and not zip_file.exists()
    assert deleted == [1]


def test_delete_pvc_file_survives_missing_and_directories(tmp_path, caplog):
    missing = tmp_path / 'nope'
    directory = tmp_path / 'adir'
    directory.mkdir()

    # 空值 / 空白串不落盘操作
    operator_service._delete_pvc_file(None, 1, 'operator_path')
    operator_service._delete_pvc_file('   ', 1, 'operator_path')
    # 文件已不在盘上（历史遗留）→ 静默
    operator_service._delete_pvc_file(str(missing), 1, 'operator_path')
    # 目录删不掉（OSError）→ 只告警
    caplog.set_level('WARNING')
    operator_service._delete_pvc_file(str(directory), 1, 'operator_path')
    assert 'failed to delete operator file' in caplog.text


# ----------------------------------------------------------------------
# support
# ----------------------------------------------------------------------


def test_support_requires_module():
    """``module`` 缺失在入口显式检查 → 0004（服务端错误码族）。"""
    with pytest.raises(KbApiError) as excinfo:
        operator_service.support({'formats': ['md']}, 'admin', 'org-1')
    assert excinfo.value.code == '0004'
    assert excinfo.value.key == 'RetCode.illegalArgument'


def test_support_without_formats_returns_null_bo():
    """``formats`` 为空 → **bo 是 null**（不是空 map）。"""
    assert operator_service.support({'module': 'text_split', 'formats': []},
                                    'admin', 'org-1') is None


def test_support_appends_system_operators_and_converts_defaults(monkeypatch):
    """每个 format 下 = 「库里已发布算子」后接「内置系统算子」，且 defaultValue 被转换。"""
    monkeypatch.setattr(operator_store, 'select_ids_by_format', lambda fmt: [3])
    monkeypatch.setattr(operator_store, 'select_published_by_condition',
                        lambda ids, keyword, module, org, emp: [
                            _row(id=3, module='text_split')])
    monkeypatch.setattr(operator_store, 'list_params_by_operator_ids', lambda ids: {
        3: [{'arg_name': 'n', 'arg_type': 'int', 'default_value': '512',
             'description': 'd'}]})

    result = operator_service.support(
        {'module': 'text_split', 'formats': ['md'], 'keyword': None}, 'admin', 'org-1')

    assert set(result.keys()) == {'md'}
    vos = result['md']
    assert [vo['id'] for vo in vos] == [3, -1, -2]       # 库里算子在前，系统算子在后
    # 库里算子的 defaultValue 出口被转换成 int
    assert vos[0]['args'][0]['defaultValue'] == 512
    # 系统算子那段同样跑转换：int 的 512 toString 再 parse = 原值
    system_args = [vo for vo in vos if vo['id'] == -1][0]['args']
    assert all(param['argType'] != 'int' or isinstance(param['defaultValue'], int)
               for param in system_args)


def test_support_keeps_null_args_for_system_operator_without_args(monkeypatch):
    """系统算子没有 defaultArgs → ``args`` 是 null，转换循环要能跳过。"""
    monkeypatch.setattr(operator_store, 'select_ids_by_format', lambda fmt: [])
    monkeypatch.setattr(operator_store, 'select_published_by_condition',
                        lambda ids, keyword, module, org, emp: [])

    result = operator_service.support(
        {'module': 'text_split', 'formats': ['xlsx']}, 'admin', None)

    # 系统算子 -2（摘要切分）没有参数行 → args 是**空列表**，出口转换的 ``or []`` 兜住
    summary = [vo for vo in result['xlsx'] if vo['id'] == -2][0]
    assert summary['args'] == []


def test_support_format_matched_by_nothing_yields_empty_segment(monkeypatch):
    """格式谁都匹配不上 → 该 format 下是**空列表**（不是 null）。"""
    monkeypatch.setattr(operator_store, 'select_ids_by_format', lambda fmt: [])
    monkeypatch.setattr(operator_store, 'select_published_by_condition',
                        lambda ids, keyword, module, org, emp: [])

    result = operator_service.support(
        {'module': 'text_split', 'formats': ['zzz']}, 'admin', None)

    assert result == {'zzz': []}


# ----------------------------------------------------------------------
# 导出
# ----------------------------------------------------------------------


def test_export_operator_by_name_not_found(empty_store):
    with pytest.raises(KbApiError) as excinfo:
        operator_service.export_operator_by_name('不存在', 'p1', 'org-1')
    assert excinfo.value.key == 'RetCode.operator.notfound'


def test_export_operator_by_name_position_missing_is_server_error(monkeypatch):
    """命中但缺 ``position`` → 源实现是 NPE → 0001（显式抛服务器错误）。"""
    monkeypatch.setattr(operator_store, 'select_by_name', lambda name, org_id=None: [_row(id=1)])
    monkeypatch.setattr(operator_store, 'list_props_by_operator_id', lambda operator_id: {})

    with pytest.raises(KbServerError):
        operator_service.export_operator_by_name('甲', None, 'org-1')


def test_export_operator_by_name_position_mismatch_is_not_found(monkeypatch):
    monkeypatch.setattr(operator_store, 'select_by_name', lambda name, org_id=None: [_row(id=1)])
    monkeypatch.setattr(operator_store, 'list_props_by_operator_id',
                        lambda operator_id: {'position': 'p1'})

    with pytest.raises(KbApiError):
        operator_service.export_operator_by_name('甲', 'other', 'org-1')


def test_export_operator_by_name_happy_path(monkeypatch, tmp_path):
    zip_file = tmp_path / 'pkg.zip'
    zip_file.write_bytes(b'PKZIP')
    monkeypatch.setattr(operator_store, 'select_by_name',
                        lambda name, org_id=None: [_row(id=1, operator_zip_path=str(zip_file))])
    monkeypatch.setattr(operator_store, 'list_props_by_operator_id',
                        lambda operator_id: {'position': 'p1'})

    content, filename = operator_service.export_operator_by_name('甲', 'p1', 'org-1')

    assert content == b'PKZIP'
    # 文件名里的 module 取**库里的原值**（不改写）
    assert filename.startswith('1-retriever-') and filename.endswith('.zip')


def test_export_operator_not_found(empty_store):
    with pytest.raises(KbApiError) as excinfo:
        operator_service.export_operator(404, 'org-1')
    assert excinfo.value.key == 'RetCode.operator.notfound'


def test_stream_stored_zip_without_path_is_server_error(monkeypatch):
    """``operator_zip_path`` 为 NULL → 0001（这一支不动）。"""
    monkeypatch.setattr(operator_store, 'select_by_org_id',
                        lambda operator_id, org: _row(id=1, operator_zip_path=None))

    with pytest.raises(KbServerError):
        operator_service.export_operator(1, 'org-1')


def test_stream_stored_zip_missing_file_is_0005(monkeypatch, caplog):
    """库里路径在、盘上文件缺失 → 0005「文件(夹)不存在」（重试无用，不能回 0001）。"""
    monkeypatch.setattr(operator_store, 'select_by_org_id',
                        lambda operator_id, org: _row(id=1,
                                                      operator_zip_path='/nonexistent/pkg.zip'))
    caplog.set_level('ERROR')

    with pytest.raises(KbApiError) as excinfo:
        operator_service.export_operator(1, 'org-1')

    assert excinfo.value.key == 'RetCode.file.not.exist'
    assert 'operator zip unreadable' in caplog.text


# ----------------------------------------------------------------------
# 类型清单与小工具
# ----------------------------------------------------------------------


def test_operator_types_order_is_contract():
    types = operator_service.operator_types()

    assert [t['value'] for t in types] == [
        'file_parse', 'text_split', 'graph_extract', 'rag_operator']
    assert types[0] == {'label_en': 'File parse operator', 'label_zh': '文本解析算子',
                        'value': 'file_parse'}


def test_decimal2_strips_trailing_zeros():
    """``DecimalFormat("#.##")``：最多两位小数、无尾随零。"""
    assert operator_service._decimal2(2.0) == '2'
    assert operator_service._decimal2(1.5) == '1.5'
    assert operator_service._decimal2(0.25) == '0.25'


def test_readable_size_units():
    assert operator_service._readable_size(1) == '1 Bytes'
    assert operator_service._readable_size(1 << 20) == '1 MB'
    assert operator_service._readable_size(3 * (1 << 30)) == '3 GB'


def test_format_datetime_none_stays_none():
    assert operator_service._format_datetime(None) is None


# ----------------------------------------------------------------------
# 公开读接口（供其他域调用）
# ----------------------------------------------------------------------


def test_list_params_by_operator_ids_passthrough(monkeypatch):
    """其他域读算子声明参数的公开口：透传 store，不再加工。"""
    params = {1: [{'arg_name': 'k', 'arg_type': 'int', 'default_value': '8'}]}
    monkeypatch.setattr(operator_store, 'list_params_by_operator_ids', lambda ids: params)

    assert operator_service.list_params_by_operator_ids([1]) is params


def test_get_operator_row_returns_raw_row(monkeypatch):
    row = {'id': 1, 'module': 'retriever'}
    monkeypatch.setattr(operator_store, 'select_by_id', lambda operator_id: row)

    assert operator_service.get_operator_row(1) is row


def test_operator_python_path_from_row_or_none(monkeypatch):
    """执行路径在行上；行不存在（或路径列为空）→ None。"""
    monkeypatch.setattr(operator_store, 'select_by_id',
                        lambda operator_id: {'id': 1, 'operator_path': '/pvc/operator/a'})
    assert operator_service.operator_python_path(1) == '/pvc/operator/a'

    monkeypatch.setattr(operator_store, 'select_by_id', lambda operator_id: None)
    assert operator_service.operator_python_path(404) is None


def test_convert_default_value_rejects_invalid_json():
    """``json`` 解析失败 → 0004 + 那句英文原话（原文放在 key 位，不走 i18n）。"""
    with pytest.raises(KbApiError) as excinfo:
        operator_service.convert_default_value('json', '{oops')
    assert excinfo.value.code == '0004'
    # 那句原话就是 key：任何语言都渲染成同一句英文
    assert excinfo.value.key == 'Invalid json default for arg json: {oops'
    assert excinfo.value.render('zh') == excinfo.value.key


# ----------------------------------------------------------------------
# 系统算子注册表：异常与缺参
# ----------------------------------------------------------------------


def test_system_registry_read_failure_returns_empty(monkeypatch, caplog):
    """注册表读不到 → 空表 + 日志，不抛（系统算子是增强功能，不能拖垮接口）。

    ⚠️ ``caplog.set_level('WARNING')`` 而不是 ERROR：``engine.logutil`` 被 import
    后会把 root logger 的 ``exception`` 改写成 WARNING 级别输出（全局副作用），
    按 ERROR 过滤会漏掉这条记录；按 WARNING 收两边都拿得到。
    """
    monkeypatch.setattr(system_operator, 'REGISTRY_FILE', Path('/nonexistent/registry.json'))
    caplog.set_level('WARNING')

    assert system_operator.fetch_system_operators() == []
    assert 'failed to load system operator registry' in caplog.text


def test_system_operator_vo_with_null_args_and_names():
    """DTO 缺 ``defaultArgs`` → ``args`` 是 null；display_name 缺 → 两名都是 null。"""
    vo = system_operator.to_operator_vo({'id': -9})

    assert vo['args'] is None
    assert vo['name'] is None and vo['nameEn'] is None
    assert vo['description'] is None and vo['descriptionEn'] is None
    assert vo['prop'] == {'support_format': None}
