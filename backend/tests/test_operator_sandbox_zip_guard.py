"""算子沙箱外围的防护测试。

三块内容：

1. :mod:`operators.sandbox.zip_security` —— zip bomb 检测（条目数 / 解压总量 /
   单文件压缩比，全部可被环境变量覆盖）；
2. :mod:`ingestion.service.operator.dangerous_function_visitor` —— 导入期 AST
   黑名单的**逃逸写法**补测（``getattr`` 动态取属性、``__builtins__`` 下标、
   ``shell=True``、pickle 反序列化、flask debug、敏感文件读）；
3. ``operators.text_split.main`` —— 内置切分算子入口的参数形态。

zip 的上限是**防御纵深**（真正的隔离在部署层），用例要在不构造超大文件的前提下
把每个阈值分支走一遍 —— 全靠传小阈值。

跑法（服务目录下）::

    python -m pytest tests/test_operator_sandbox_zip_guard.py -q
"""

import zipfile

import pytest

from ingestion.service.operator.dangerous_function_visitor import (
    DangerousCodeVisitor,
    format_security_error,
    scan_file_with_ast,
)
from operators.sandbox import zip_security


# ----------------------------------------------------------------------
# zip bomb 检测
# ----------------------------------------------------------------------


def _write_zip(path, files) -> None:
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, payload in files.items():
            archive.writestr(name, payload)


def test_normal_zip_passes(tmp_path):
    path = tmp_path / 'pkg.zip'
    _write_zip(path, {'a.txt': 'hello', 'b.txt': 'world'})

    assert zip_security.check_zip_bomb(path) == (False, None)


def test_directory_entries_are_not_counted(tmp_path):
    """目录条目（以 / 结尾）不计入条目数与总大小。"""
    path = tmp_path / 'dirs.zip'
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr(zipfile.ZipInfo('dir/'), b'')
        archive.writestr(zipfile.ZipInfo('nested/dir/'), b'')

    assert zip_security.check_zip_bomb(path, max_file_count=0) == (False, None)


def test_file_count_limit(tmp_path):
    path = tmp_path / 'many.zip'
    _write_zip(path, {f'f{i}.txt': 'x' for i in range(3)})

    is_bomb, reason = zip_security.check_zip_bomb(path, max_file_count=2)

    assert is_bomb is True
    assert 'File count 3 exceeds limit 2' in reason


def test_total_uncompressed_size_limit(tmp_path):
    path = tmp_path / 'big.zip'
    _write_zip(path, {'a.txt': '12345', 'b.txt': '67890'})

    is_bomb, reason = zip_security.check_zip_bomb(path, max_total_size=8)

    assert is_bomb is True
    assert 'Total uncompressed size' in reason


def test_single_file_compression_ratio_limit(tmp_path):
    """高压缩比（全零内容）超限 → zip bomb。"""
    path = tmp_path / 'dense.zip'
    _write_zip(path, {'zeros.txt': '0' * 4096})

    is_bomb, reason = zip_security.check_zip_bomb(path, max_compress_ratio=10)

    assert is_bomb is True
    assert 'Compression ratio' in reason


def test_invalid_zip_is_reported_as_bomb(tmp_path):
    path = tmp_path / 'bad.zip'
    path.write_bytes(b'PK\x03\x04garbage')

    is_bomb, reason = zip_security.check_zip_bomb(path)

    assert is_bomb is True
    assert reason.startswith('Invalid zip file')


def test_unreadable_zip_path_is_reported_as_bomb(tmp_path):
    """路径指向目录等读不了的形态 → 通用异常分支，也按 bomb 处理。"""
    directory = tmp_path / 'not-a-zip'
    directory.mkdir()

    is_bomb, reason = zip_security.check_zip_bomb(directory)

    assert is_bomb is True
    assert reason.startswith('Error checking zip file')


def test_env_overrides_drive_defaults(monkeypatch, tmp_path):
    """环境变量控制默认阈值；非法值**回落默认**（不抛）。"""
    path = tmp_path / 'pkg.zip'
    _write_zip(path, {'a.txt': 'x' * 100, 'b.txt': 'x'})

    # MAX_FILE_NUM=1：第二个文件就超限
    monkeypatch.setenv('MAX_FILE_NUM', '1')
    assert zip_security.check_zip_bomb(path)[0] is True

    # 非法值回落默认（100000）：3 个文件远不超限
    monkeypatch.setenv('MAX_FILE_NUM', 'not-a-number')
    monkeypatch.setenv('MAX_TOTAL_UNCOMP_GB', 'also-bad')
    monkeypatch.setenv('MAX_SINGLE_COMP_RATIO', '')
    assert zip_security.check_zip_bomb(path) == (False, None)


def test_env_total_size_uses_gb_units(monkeypatch, tmp_path):
    path = tmp_path / 'pkg.zip'
    _write_zip(path, {'a.txt': 'x' * 4096})

    monkeypatch.setenv('MAX_TOTAL_UNCOMP_GB', '0')
    is_bomb, reason = zip_security.check_zip_bomb(path)

    assert is_bomb is True
    assert reason is not None


def test_defaults_module_constants():
    """文档里写的默认值：30000 条 / 10GB / 1000:1（docstring 与常量不能漂移）。"""
    assert zip_security.DEFAULT_MAX_FILE_COUNT == 100000
    assert zip_security.DEFAULT_MAX_TOTAL_SIZE_GB == 10
    assert zip_security.DEFAULT_MAX_COMPRESS_RATIO == 1000


# ----------------------------------------------------------------------
# 危险函数 visitor：逃逸写法补测
# ----------------------------------------------------------------------


def _scan(source: str, tmp_path):
    script = tmp_path / 'operator.py'
    script.write_text(source, encoding='utf-8')
    return scan_file_with_ast(str(script))


@pytest.mark.parametrize('source, expected_type', [
    ('import subprocess\nsubprocess.run("ls", shell=True)\n', 'subprocess_shell_injection'),
    ('import pickle\npickle.loads(b"")\n', 'insecure_deserialization'),
    ('import socket\nsocket.create_connection(("h", 80))\n', 'dangerous_module_call'),
    ('import os\nos.chdir("/tmp")\n', 'dangerous_module_call'),
    ('import os\nos.spawnlp("x")\n', 'dangerous_module_call'),      # 通配 spawn*
    ('import os\nos.execlp("sh", "sh")\n', 'dangerous_module_call'),  # 通配 execl*
    ('import tempfile\ntempfile.mktemp()\n', 'dangerous_module_call'),
    ('import urllib.request\nurllib.request.urlopen("http://x")\n', 'dangerous_module_call'),
    ('import requests\nrequests.get("http://x")\n', 'dangerous_module_call'),
    ('import httpx\nhttpx.get("http://x")\n', 'dangerous_module_call'),
    ('eval("1+1")\n', 'dangerous_builtin'),
    ('exec("pass")\n', 'dangerous_builtin'),
    # getattr 动态取属性：只认**真实模块名**做根（别名场景由 check_attribute_call 覆盖）
    ("import os\ngetattr(os, 'system')('id')\n", 'dangerous_module_call'),
    ("__builtins__['eval']('1+1')\n", 'dangerous_builtin'),
])
def test_escape_hatches_are_flagged(source, expected_type, tmp_path):
    issues = _scan(source, tmp_path)

    assert expected_type in {issue['type'] for issue in issues}, issues


@pytest.mark.parametrize('source', [
    'open("/etc/passwd")\n',
    'open("/home/u/project/.env")\n',
    'open("keys/id_rsa")\n',
])
def test_sensitive_file_open_is_flagged(source, tmp_path):
    issues = _scan(source, tmp_path)

    assert 'dangerous_file_access' in {issue['type'] for issue in issues}


def test_reading_sensitive_file_via_attribute_is_flagged(tmp_path):
    issues = _scan('open("/etc/shadow").read()\n', tmp_path)

    access = [i for i in issues if i['type'] == 'dangerous_file_access']
    assert access and 'Reading sensitive file' in access[0]['message']


def test_benign_paths_are_not_flagged(tmp_path):
    """普通文件、非字符串字面量路径、正常业务代码都放行。"""
    issues = _scan(
        'path = get_path()\n'
        'open(path)\n'
        'with open("data.txt", encoding="utf-8") as handle:\n'
        '    text = handle.read()\n'
        'def run(text, **kwargs):\n'
        '    return [{"content": text}]\n',
        tmp_path)

    assert issues == []


def test_flask_debug_mode_is_flagged(tmp_path):
    issues = _scan('class App:\n    def run(self, debug=False):\n        pass\n'
                   'app = App()\napp.run(debug=True)\n', tmp_path)

    assert 'flask_debug_enabled' in {issue['type'] for issue in issues}


def test_syntax_error_is_reported_not_raised(tmp_path):
    issues = _scan('def oops(:\n', tmp_path)

    assert issues[0]['type'] == 'syntax_error'
    assert issues[0]['line'] == 1


def test_unreadable_file_reports_the_exception_type(tmp_path):
    """str() 为空的异常（如 MemoryError）也要留得下可定位的信息。"""
    missing = tmp_path / 'missing.py'

    issues = scan_file_with_ast(str(missing))

    assert issues[0]['type'] == 'file_read_error'
    assert issues[0]['message'].startswith('FileNotFoundError')


def test_visitor_records_line_and_column():
    visitor = DangerousCodeVisitor()
    import ast

    tree = ast.parse('eval("1")\n')
    visitor.visit(tree)

    issue = visitor.issues[0]
    assert issue['type'] == 'dangerous_builtin'
    assert issue['line'] == 1
    assert issue['col'] == 0


def test_format_security_error_renders_each_issue():
    text = format_security_error([
        {'type': 'dangerous_builtin', 'message': 'Use of eval', 'line': 3, 'col': 4},
        {'col': 0},                                     # 缺字段的条目也要能渲染
    ])

    assert text.startswith('Code security check failed.')
    assert '[dangerous_builtin] line 3, column 4: Use of eval' in text
    # 缺字段逐项回落：line 用 unknown，col 有值就显示值
    assert '[unknown] line unknown, column 0' in text


# ----------------------------------------------------------------------
# 内置文本切分算子入口
# ----------------------------------------------------------------------


def test_text_split_entries_delegate_with_expected_args(monkeypatch):
    """-1 带参数（is_chunk_split=True），-2 无参数（False）；其余形态不变。"""
    from operators.text_split import main as text_split_main

    calls = {}

    def _fake(input_path, chunk_size, chunk_overlap, is_chunk_split):
        calls.update(size=chunk_size, overlap=chunk_overlap, split=is_chunk_split)
        return [{'content': 'chunk'}]

    monkeypatch.setattr(text_split_main, 'file_split_common', _fake)

    assert text_split_main.file_split_with_chunk('/tmp/a.md', 512, 64) == [{'content': 'chunk'}]
    assert calls == {'size': 512, 'overlap': 64, 'split': True}

    calls.clear()
    assert text_split_main.file_split('/tmp/a.md') == [{'content': 'chunk'}]
    assert calls == {'size': 0, 'overlap': 0, 'split': False}
