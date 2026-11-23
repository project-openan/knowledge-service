"""算子导入／导出链（``operator_import`` + ``operator_service.import_operator``）。

覆盖的是「照直觉写就会错」的分支：

* zip 解包的 zip-slip / 坏包 / 目录条目 / 中文名解码；
* ``config.json`` 每一条校验分支（违规消息先渲染再排序）；
* 落盘次序：``.py`` 在名称校验**之前**就进了 PVC，失败要能回收；
* ``insert_operator`` 的三条 INSERT（param/prop 的批插 SQL 不带 created_by）。

不连库：``insert_operator`` 的连接用假的；``storage_root`` 指到临时目录；
代码检查器（``ingestion.runtime``）用桩替换，保证确定性。

跑法（服务目录下）::

    python -m pytest tests/test_operator_import_chain.py -q
"""

import io
import json
import zipfile
from datetime import datetime
from pathlib import Path

import pytest

from infrastructure.db import kb as kb_db
from operators.repository import operator_store
from operators.service import operator_import, operator_service
from shared.errors.api import KbApiError


# ----------------------------------------------------------------------
# 造包工具
# ----------------------------------------------------------------------


BASE_CONFIG = {
    'display_name': {'zh': '甲算子', 'en': 'JiaOperator'},
    'desc': {'zh': '描述', 'en': 'desc'},
    'is_published': 1,
    'visibleRange': 'private',
    'module': 'text_split',
    'version': '1.0.0',
    'supportedFormat': ['md'],
    'defaultArgs': [{'argName': 'n', 'argType': 'int', 'defaultValue': 512,
                     'description': '切片字数'}],
}


def _config(**overrides):
    payload = dict(BASE_CONFIG)
    payload.update(overrides)
    return payload


def _zip_bytes(files: dict, *, extra_dirs=()) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name in extra_dirs:
            archive.writestr(zipfile.ZipInfo(name + '/'), b'')
        for name, payload in files.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def _package(config=None) -> bytes:
    """一个最小可用算子包：config.json + main.py。"""
    return _zip_bytes({
        'config.json': json.dumps(config if config is not None else _config()),
        'main.py': 'def run(text):\n    return [{"content": text}]\n',
    })


class _FakeCursor:
    def __init__(self, returning):
        self.queries = []
        self._returning = returning

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        self.queries.append((sql, params))

    def fetchone(self):
        return self._returning


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self._cursor


@pytest.fixture()
def pvc_root(monkeypatch, tmp_path):
    """把 PVC 根指到临时目录（算子包永远写本地卷）。"""
    monkeypatch.setattr(operator_import, 'storage_root', lambda: tmp_path)
    return tmp_path


@pytest.fixture()
def fake_db(monkeypatch):
    cursor = _FakeCursor(returning=(42, datetime(2026, 10, 5, 4, 49, 42),
                                    datetime(2026, 10, 5, 4, 49, 42)))
    monkeypatch.setattr(kb_db, 'connection', lambda: _FakeConnection(cursor))
    return cursor


@pytest.fixture()
def accepted_checker(monkeypatch):
    """进程内代码检查用桩替换：不依赖 ``ingestion.runtime`` 的真实校验规则。"""
    calls = []

    def _ok(script_path, parameters):
        calls.append((str(script_path), parameters))

    monkeypatch.setattr('ingestion.runtime.code_check_text_split', _ok)
    return calls


@pytest.fixture(autouse=True)
def unique_name(monkeypatch):
    """名称查重默认放行（查重不带 org 过滤）。"""
    monkeypatch.setattr(operator_store, 'select_by_name', lambda name, org_id=None: [])


# ----------------------------------------------------------------------
# 完整导入链
# ----------------------------------------------------------------------


def test_import_operator_full_chain(pvc_root, fake_db, accepted_checker):
    content = _package()

    vo = operator_service.import_operator('op.zip', content, 'me', 'org-1', 'zh')

    # 返回的是「刚构造的 PO」装出的 VO：args 是 null（不是重新查库）
    assert vo['id'] == 42
    assert vo['args'] is None and vo['prop'] is None
    assert vo['name'] == '甲算子'
    assert vo['module'] == 'text_split'
    assert vo['isPublished'] == 1
    assert vo['createdDate'] == '2026-10-05 04:49:42'

    # PVC 上落了两个文件
    python_path = Path(fake_db.queries[0][1][7])
    zip_path = Path(fake_db.queries[0][1][6])
    assert python_path.is_file() and zip_path.read_bytes() == content
    assert python_path.parent.name == 'operator'
    assert zip_path.parent.name == 'operator_zip'

    # 三条 INSERT：主行 + 参数 + 属性
    main_sql, main_params = fake_db.queries[0]
    assert 'INSERT INTO operator (' in main_sql
    assert 'is_published' in main_sql
    assert main_params[4] == 'text_split'              # module
    assert main_params[9] is True                      # is_published
    assert main_params[11] == 'me'                     # created_by

    param_sql, param_params = fake_db.queries[1]
    assert 'INSERT INTO operator_param' in param_sql
    # defaultValue 存字符串化结果；tips/placeholder 缺省存 NULL
    assert param_params[3] == '512' and param_params[5] is None and param_params[6] is None

    prop_sql, prop_params = fake_db.queries[2]
    assert 'INSERT INTO operator_prop' in prop_sql
    assert prop_params[1] == 'support_format'
    assert prop_params[2] == '[md]', '列表字符串化是 [md]，不是 JSON'


def test_import_seeded_operator_uses_explicit_id_and_system(pvc_root, fake_db, accepted_checker):
    """``operator_id`` / ``system`` 只给内置算子播种：id 插在最前、system 追加在最后。"""
    vo = operator_service.import_operator(
        'op.zip', _package(), 'system', '', 'zh', operator_id=-6, system=True)

    assert vo['system'] == 1
    main_sql, main_params = fake_db.queries[0]
    columns = main_sql.split('INSERT INTO operator (')[1].split(')')[0].split(', ')
    assert columns[0] == 'id'
    assert columns[-1] == 'system'
    assert main_params[0] == -6 and main_params[-1] is True


def test_import_failure_propagates_and_rolls_back(pvc_root, fake_db, accepted_checker,
                                                  monkeypatch):
    """校验失败 → 0005 上抛，且回滚尝试清理两个 PVC 路径。

    ⚠️ 已知缺陷（回归哨兵）：``import_operator`` 把**相对路径**传给
    ``delete_pvc``，而落盘用的是绝对路径 —— 相对路径按 CWD 解析必然
    ``FileNotFoundError`` 被静默吞掉，所以 python 文件实际留在 PVC 上。
    这里按**当前行为**钉住：一旦有人把回滚改成删绝对路径（正确修复），
    本用例会失败提醒同步更新断言。
    """
    monkeypatch.setattr(operator_store, 'select_by_name',
                        lambda name, org_id=None: [{'id': 99}])    # 名称查重命中

    with pytest.raises(KbApiError) as excinfo:
        operator_service.import_operator('op.zip', _package(), 'me', 'org-1', 'zh')

    assert excinfo.value.key == 'RetCode.operator.name.duplicate'
    assert fake_db.queries == [], '失败路径不得入库'
    # 当前行为：python 文件留在 PVC（回滚删的是相对路径，见上）
    leftovers = [p for p in pvc_root.rglob('*') if p.is_file()]
    assert len(leftovers) == 1


def test_import_rejects_corrupt_zip(pvc_root):
    with pytest.raises(KbApiError) as excinfo:
        operator_service.import_operator('op.zip', b'not a zip', 'me', 'org-1', 'zh')
    assert excinfo.value.key == 'RetCode.zip.decompress.error'


def test_import_accepts_uppercase_extension(pvc_root, fake_db, accepted_checker):
    vo = operator_service.import_operator('OP.ZIP', _package(), 'me', 'org-1', 'zh')
    assert vo['id'] == 42


# ----------------------------------------------------------------------
# 解包：zip-slip、目录条目、坏条目、中文解码
# ----------------------------------------------------------------------


def test_extract_rejects_absolute_entry(tmp_path):
    content = _zip_bytes({'/etc/evil.txt': 'x'})
    with pytest.raises(KbApiError):
        operator_import._extract(content, tmp_path / 'out')


def test_extract_rejects_dot_entry(tmp_path):
    """条目名 ``.`` 解析后就是目标目录本身 → 拒绝（防把目标目录写爆）。"""
    content = _zip_bytes({'.': 'x'})
    with pytest.raises(KbApiError):
        operator_import._extract(content, tmp_path / 'out')


def test_extract_skips_directory_entries(tmp_path):
    """「无意义目录」条目跳过；目录下的真实文件照常解出。"""
    content = _zip_bytes({'main.py': 'p'}, extra_dirs=('sub',))
    target = tmp_path / 'out'
    operator_import._extract(content, target)

    assert (target / 'main.py').is_file()
    assert not (target / 'sub').exists()


def test_extract_bad_entry_content_raises(tmp_path, monkeypatch):
    """条目读不出来（CRC 坏 / 截断包）→ 0005，而不是半包落盘。"""
    def _boom(self, member):
        raise zipfile.BadZipFile('Bad CRC-32')

    monkeypatch.setattr(zipfile.ZipFile, 'read', _boom)

    with pytest.raises(KbApiError) as excinfo:
        operator_import._extract(_package(), tmp_path / 'out')
    assert excinfo.value.key == 'RetCode.zip.decompress.error'


def test_decode_name_prefers_gb18030_without_utf8_flag():
    """没置 UTF-8 标志位的条目按 cp437 解会成乱码，这里改按 gb18030 解。"""
    legacy_bytes = '文件.txt'.encode('gb18030').decode('cp437')   # cp437 可逆还原出 GBK 字节
    info = zipfile.ZipInfo(filename=legacy_bytes)                  # flag_bits 默认 0

    assert operator_import._decode_name(info) == '文件.txt'


def test_decode_name_respects_utf8_flag():
    info = zipfile.ZipInfo(filename='文件.txt')
    info.flag_bits |= 0x800

    assert operator_import._decode_name(info) == '文件.txt'


def test_decode_name_survives_undecodable_bytes():
    """cp437 编不回去的字节（本来就是 UTF-8 存的）→ 原样返回，不抛。"""
    info = zipfile.ZipInfo(filename='文件.txt')        # flag_bits=0：走 gb18030 分支

    assert operator_import._decode_name(info) == '文件.txt'


# ----------------------------------------------------------------------
# config.json 校验
# ----------------------------------------------------------------------


def _manifest(tmp_path, config, extra_files=None, lang='zh'):
    work = tmp_path / 'work'
    work.mkdir(parents=True, exist_ok=True)
    (work / 'config.json').write_text(
        config if isinstance(config, str) else json.dumps(config), encoding='utf-8')
    for name, payload in (extra_files or {'a.py': 'p'}).items():
        (work / name).write_text(payload, encoding='utf-8')
    return operator_import.build_manifest(work, lang)


@pytest.mark.parametrize('payload, key', [
    ({**BASE_CONFIG}, None),                                    # 基线：无违规
    ({k: v for k, v in BASE_CONFIG.items() if k != 'display_name'},
     'RetCode.operator.displayName.check.notblank'),
    ({**BASE_CONFIG, 'display_name': 'zh-str'},
     'RetCode.operator.displayname.zh.notblank'),
    ({k: v for k, v in BASE_CONFIG.items() if k != 'desc'},
     'RetCode.operator.desc.check.notblank'),
    ({**BASE_CONFIG, 'desc': ['not', 'a', 'dict']},
     'RetCode.operator.desc.zh.notblank'),
    ({**BASE_CONFIG, 'desc': {'zh': '', 'en': 'desc'}},
     'RetCode.operator.desc.zh.notblank'),
    ({**BASE_CONFIG, 'is_published': None},
     'RetCode.operator.published.check.notnull'),
    ({**BASE_CONFIG, 'is_published': 2}, 'isPublished must be either 0 or 1'),
    ({**BASE_CONFIG, 'visibleRange': ''},
     'RetCode.operator.visibleRange.check.notnull'),
    ({**BASE_CONFIG, 'module': ''}, 'RetCode.operator.module.check.notblank'),
    ({**BASE_CONFIG, 'version': ''}, 'RetCode.operator.versionUser.check.notblank'),
    ({**BASE_CONFIG, 'version': '1.0'}, 'RetCode.operator.versionUser.check.regex'),
    ({**BASE_CONFIG, 'version': '01.0.0'}, 'RetCode.operator.versionUser.check.regex'),
    ({**BASE_CONFIG, 'defaultArgs': None}, 'RetCode.operator.defaultArgs.check.not.blank'),
    ({**BASE_CONFIG, 'supportedFormat': []}, 'RetCode.operator.supportedFormat.check'),
    ({k: v for k, v in BASE_CONFIG.items() if k != 'supportedFormat'},
     'RetCode.operator.operator.check.notblank'),
])
def test_collect_violations_branches(payload, key):
    """每条违规分支：返回的是**已渲染**的消息（不含 RetCode. 前缀），
    所以断言用 ``render(key)`` 的产物比对（直接调 ``_collect_violations``，
    不经过 build_manifest 的 module 前置检查）。"""
    from shared.i18n.messages import render

    if key is None:
        assert operator_import._collect_violations(payload, 'en') == []
        return

    problems = operator_import._collect_violations(payload, 'en')

    assert render(key, 'en') in problems


def test_rag_operator_without_supported_format_needs_operator_and_package():
    """RAG 算子一支（没有 supportedFormat 键）要求 operator 与 package 两项。"""
    from shared.i18n.messages import render

    payload = {k: v for k, v in BASE_CONFIG.items() if k != 'supportedFormat'}
    payload['operator'] = 'CustomOp'          # package 仍缺

    problems = operator_import._collect_violations(payload, 'en')

    assert render('RetCode.operator.operator.check.notblank', 'en') not in problems
    assert render('RetCode.operator.position.check.notblank', 'en') in problems


def test_build_manifest_without_config_json(tmp_path):
    work = tmp_path / 'work'
    work.mkdir()
    (work / 'main.py').write_text('p', encoding='utf-8')

    with pytest.raises(KbApiError) as excinfo:
        operator_import.build_manifest(work, 'zh')
    assert excinfo.value.key == 'RetCode.operator.configjson.notfound'


def test_build_manifest_rejects_unknown_visible_range(tmp_path):
    """``visibleRange`` 有值但不在枚举里 → 单独一条校验（违规清单之外）。"""
    with pytest.raises(KbApiError) as excinfo:
        _manifest(tmp_path, _config(visibleRange='internal'))
    assert excinfo.value.key == 'RetCode.operator.arg.visibleRange.incorrect'


def test_check_params_rejects_duplicate_arg_names():
    params = [{'argName': 'n', 'argType': 'int', 'defaultValue': 1},
              {'argName': 'n', 'argType': 'int', 'defaultValue': 2}]

    with pytest.raises(KbApiError) as excinfo:
        operator_import._check_params(params)
    assert excinfo.value.key == 'RetCode.operator.arg.name.incorrect'


# ----------------------------------------------------------------------
# 名称 / 描述校验
# ----------------------------------------------------------------------


def test_validate_operator_name_normalizes_and_checks_duplicate(monkeypatch):
    manifest = {'name': '  甲算子  ', 'nameEn': 'Jia  Operator'}

    operator_import.validate_operator_name(manifest, 'org-1')

    # 中文名 trim；英文名去掉**所有**空格
    assert manifest['name'] == '甲算子'
    assert manifest['nameEn'] == 'JiaOperator'


@pytest.mark.parametrize('name, name_en, key', [
    ('', 'A', 'RetCode.operator.name.check.notblank'),
    ('甲算子', '', 'RetCode.operator.name.check.notblank'),
    ('甲-算子!', 'A', 'RetCode.operator.name.invalid.cn'),
    ('甲算子', 'Jia Operator!', 'RetCode.operator.name.invalid.en'),
    ('甲' * 51, 'A', 'RetCode.operator.name.invalid.cn'),
    ('甲算子', 'A' * 51, 'RetCode.operator.name.invalid.en'),
])
def test_validate_operator_name_rejections(name, name_en, key):
    with pytest.raises(KbApiError) as excinfo:
        operator_import.validate_operator_name({'name': name, 'nameEn': name_en}, 'org-1')
    assert excinfo.value.key == key


def test_validate_operator_name_rejects_duplicate(monkeypatch):
    monkeypatch.setattr(operator_store, 'select_by_name',
                        lambda name, org_id=None: [{'id': 1}])

    with pytest.raises(KbApiError) as excinfo:
        operator_import.validate_operator_name({'name': '甲算子', 'nameEn': 'A'}, 'org-1')
    assert excinfo.value.key == 'RetCode.operator.name.duplicate'


@pytest.mark.parametrize('desc, desc_en, key', [
    ('', 'd', 'RetCode.operator.description.check.notblank'),
    ('d', '', 'RetCode.operator.description.check.notblank'),
    ('d' * 5001, 'd', 'RetCode.operator.description.check'),
    ('d', 'd' * 5001, 'RetCode.operator.description.check'),
])
def test_validate_operator_description_rejections(desc, desc_en, key):
    with pytest.raises(KbApiError) as excinfo:
        operator_import.validate_operator_description(
            {'description': desc, 'descriptionEn': desc_en})
    assert excinfo.value.key == key


def test_validate_operator_description_happy():
    operator_import.validate_operator_description(
        {'description': '描述', 'descriptionEn': 'desc'})       # 不抛


# ----------------------------------------------------------------------
# 脚本校验
# ----------------------------------------------------------------------


def test_validate_script_missing_file_is_storage_error(tmp_path):
    with pytest.raises(KbApiError) as excinfo:
        operator_import.validate_script(tmp_path / 'gone.py', {'module': 'text_split'})
    assert excinfo.value.key == 'RetCode.operator.storage.insufficient'


def test_validate_script_skips_checker_for_unknown_module(tmp_path):
    """graph_extract 不在 ``CODE_CHECKERS`` 里 → 只做接口校验就返回。"""
    path = tmp_path / 'op.py'
    path.write_text('import json\n', encoding='utf-8')

    assert operator_import.validate_script(
        path, {'module': 'graph_extract', 'defaultArgs': []}) is None


def test_validate_script_passes_parameters_to_checker(tmp_path, monkeypatch):
    path = tmp_path / 'op.py'
    path.write_text('import json\n', encoding='utf-8')
    calls = {}

    def _checker(script_path, parameters):
        calls['path'] = script_path
        calls['parameters'] = parameters

    monkeypatch.setattr('ingestion.runtime.code_check_text_split', _checker)

    operator_import.validate_script(path, {
        'module': 'text_split',
        'defaultArgs': [{'argName': 'n', 'argType': 'int'}]})

    assert calls['path'] == str(path)
    assert calls['parameters'] == {'n': 'int'}


def test_validate_script_business_error_passes_through(tmp_path, monkeypatch):
    """检查器抛的业务异常**原样上抛**（不得包成 checkNotPass 掩盖文案）。"""
    path = tmp_path / 'op.py'
    path.write_text('import json\n', encoding='utf-8')
    original = KbApiError('RetCode.operator.parse.error')

    def _boom(script_path, parameters):
        raise original

    monkeypatch.setattr('ingestion.runtime.code_check_text_split', _boom)

    with pytest.raises(KbApiError) as excinfo:
        operator_import.validate_script(path, {'module': 'text_split', 'defaultArgs': []})
    assert excinfo.value is original


def test_validate_script_wraps_unexpected_checker_error(tmp_path, monkeypatch, caplog):
    """检查器的其他异常（语法错误等）统一归「校验不通过」。"""
    path = tmp_path / 'op.py'
    path.write_text('import json\n', encoding='utf-8')
    caplog.set_level('WARNING')

    def _boom(script_path, parameters):
        raise RuntimeError('signature mismatch')

    monkeypatch.setattr('ingestion.runtime.code_check_text_split', _boom)

    with pytest.raises(KbApiError) as excinfo:
        operator_import.validate_script(path, {'module': 'text_split', 'defaultArgs': []})
    assert excinfo.value.key == 'RetCode.operator.textsplit.code.checkNotPass'
    assert 'operator code-check not passed' in caplog.text


def test_imported_top_levels_tolerates_unreadable_scripts(tmp_path):
    """语法坏 / 读不了的脚本 → 空 import 集（接口校验放行，交给代码检查器报）。"""
    bad = tmp_path / 'bad.py'
    bad.write_text('def oops(:\n', encoding='utf-8')

    assert operator_import._imported_top_levels(bad) == set()
    assert operator_import._imported_top_levels(tmp_path / 'missing.py') == set()


# ----------------------------------------------------------------------
# PVC 落盘与入库的辅助函数
# ----------------------------------------------------------------------


def test_pvc_path_and_write_creates_parents(pvc_root):
    path = operator_import.write_pvc(b'x', 'operator/abc')

    assert path == pvc_root / 'operator' / 'abc'
    assert path.read_bytes() == b'x'
    assert operator_import.pvc_path('operator/abc') == pvc_root / 'operator' / 'abc'


def test_delete_pvc_is_tolerant(pvc_root, caplog):
    assert operator_import.delete_pvc(None) is None                 # 空值直接返回
    operator_import.delete_pvc(pvc_root / 'missing')                # 不存在 → 静默

    directory = pvc_root / 'adir'
    directory.mkdir()
    caplog.set_level('WARNING')
    operator_import.delete_pvc(directory)                           # 目录删不掉 → 告警
    assert 'failed to delete pvc file' in caplog.text


def test_json_or_null_serializes_only_non_empty():
    assert operator_import._json_or_null(None) is None
    assert operator_import._json_or_null({}) is None                # 空 Map 存 NULL
    assert operator_import._json_or_null({'zh': '提示'}) == '{"zh": "提示"}'


def test_prop_text_none_stays_none():
    assert operator_import._prop_text(None) is None


def test_new_relative_path_shape():
    path = operator_import.new_relative_path('operator')

    assert path.startswith('operator/')
    assert len(path.split('/', 1)[1]) == 32                         # UUID32，不带扩展名
    assert all(c in '0123456789abcdef' for c in path.split('/', 1)[1])
