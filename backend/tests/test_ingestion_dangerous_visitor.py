"""``dangerous_function_visitor`` 的 AST 安全扫描测试。

既有 ``tests/test_operator_code_security.py`` 钉了常见逃逸写法；本文件补齐其余分支：
scope 信息构建（import 别名 / from-import / 动态模块别名 / ctypes 句柄别名 /
危险属性别名）、`getattr` / `__builtins__` 下标绕过、敏感文件读取、以及
`format_security_error` / `validate_code_security` 的出口行为。
"""

import ast

import pytest

from ingestion.service.operator import dangerous_function_visitor as dfv
from ingestion.service.operator.dangerous_function_visitor import (
    DangerousCodeVisitor,
    _build_scope_info,
    _collect_scope_stmts,
    _is_dangerous_full_attr,
    _resolve_attr_to_full,
    format_security_error,
    scan_file_with_ast,
    validate_code_security,
)


def _scan(source: str, name='operator.py', tmp_path=None):
    path = tmp_path / name
    path.write_text(source, encoding='utf-8')
    return scan_file_with_ast(str(path))


def _types(issues):
    return {issue['type'] for issue in issues}


# ---------------------------------------------------------------------------
# 基础调用形态
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('source, issue_type', [
    ("eval('1+1')", 'dangerous_builtin'),
    ("exec('x=1')", 'dangerous_builtin'),
    ("compile('1','','eval')", 'dangerous_builtin'),
    ("input('n=')", 'dangerous_builtin'),
    ("__import__('os')", 'dangerous_builtin'),
    ("open('/etc/passwd').read()", 'dangerous_file_access'),
    ("open('/etc/shadow', 'rb')", 'dangerous_file_access'),
    ("with open('./app/.env') as f: f.read()", 'dangerous_file_access'),
    ("open('/home/u/.ssh/id_rsa')", 'dangerous_file_access'),
    ("open('/etc/SUDOERS')", 'dangerous_file_access'),
    ("import os\nos.system('id')", 'dangerous_module_call'),
    ("import os\nos.popen('id')", 'dangerous_module_call'),
    ("import os\nos.spawnl(0, 'x')", 'dangerous_module_call'),
    ("import os\nos.execl('/bin/sh', 'sh')", 'dangerous_module_call'),
    ("import subprocess\nsubprocess.run('x', shell=True)", 'subprocess_shell_injection'),
    ("import subprocess\nsubprocess.Popen(['x'], shell=True)", 'subprocess_shell_injection'),
    ("import pickle\npickle.load(open('d', 'rb'))", 'insecure_deserialization'),
    ("import pickle\npickle.loads(b'')", 'insecure_deserialization'),
    ("import requests\nrequests.get('http://x')", 'dangerous_module_call'),
    ("import httpx\nhttpx.post('http://x')", 'dangerous_module_call'),
    ("import socket\nsocket.create_connection(('h', 80))", 'dangerous_module_call'),
    ("import urllib.request\nurllib.request.urlopen('http://x')", 'dangerous_module_call'),
    ("from urllib.request import urlopen\nurlopen('http://x')", 'dangerous_module_call'),
    ("from os import system\nsystem('id')", 'dangerous_module_call'),
    ("from subprocess import check_output\ncheck_output(['x'])", 'dangerous_module_call'),
    ("import subprocess as sp\nsp.Popen(['x'])", 'dangerous_module_call'),
    ("import importlib\nimportlib.import_module('os')", 'dangerous_module_call'),
    ("import ctypes\nctypes.CDLL('libc.so.6')", 'dangerous_module_call'),
    ("import tempfile\ntempfile.mktemp()", 'dangerous_module_call'),
    ("import xml.sax\nxml.sax.make_parser()", 'dangerous_module_call'),
    ("import ftplib\nftplib.FTP('h')", 'dangerous_module_call'),
    ("import paramiko\nparamiko.SSHClient()", 'dangerous_module_call'),
    ("import http.server\nhttp.server.HTTPServer(('', 80), None)", 'dangerous_module_call'),
    ("import shelve\nshelve.open('d')", 'dangerous_module_call'),
])
def test_dangerous_patterns_are_flagged(source, issue_type, tmp_path):
    issues = _scan(source, tmp_path=tmp_path)
    assert issue_type in _types(issues), issues


@pytest.mark.parametrize('source', [
    "def run(text):\n    return text.strip()\n",
    "open(user_path).read()",
    "import os\nos.getcwd()",
    "open('notes.md')",
    "import json\njson.dumps({})",
])
def test_benign_patterns_pass(source, tmp_path):
    assert _scan(source, tmp_path=tmp_path) == []


def test_benign_operator_with_functions_and_async(tmp_path):
    source = (
        "import json\n"
        "def file_split(file_path):\n"
        "    return [{'content': json.dumps({'k': 1})}]\n"
        "async def afile(file_path):\n"
        "    return file_path\n"
    )
    assert _scan(source, tmp_path=tmp_path) == []


def test_open_read_of_sensitive_file_via_attribute(tmp_path):
    issues = _scan("open('/etc/passwd').read()", tmp_path=tmp_path)
    assert 'dangerous_file_access' in _types(issues)
    assert 'Reading sensitive file' in issues[0]['message']


def test_nested_function_scope_keeps_from_import_detection(tmp_path):
    source = (
        "from os import system\n"
        "def file_parse(file_path):\n"
        "    system('id')\n"
        "    return 'x'\n"
    )
    issues = _scan(source, tmp_path=tmp_path)
    assert 'dangerous_module_call' in _types(issues)


def test_import_inside_control_flow_is_still_collected(tmp_path):
    source = (
        "def file_parse(file_path):\n"
        "    if file_path:\n"
        "        import os\n"
        "        for _ in range(1):\n"
        "            os.system('id')\n"
        "    try:\n"
        "        import subprocess\n"
        "        subprocess.run('x')\n"
        "    except ImportError:\n"
        "        pass\n"
        "    else:\n"
        "        pass\n"
        "    finally:\n"
        "        pass\n"
        "    return 'x'\n"
    )
    issues = _scan(source, tmp_path=tmp_path)
    kinds = _types(issues)
    assert 'dangerous_module_call' in kinds


def test_syntax_error_is_reported(tmp_path):
    issues = _scan("def broken(:\n    pass\n", tmp_path=tmp_path)
    assert issues[0]['type'] == 'syntax_error'
    assert issues[0]['line'] == 1


def test_read_error_includes_exception_type(tmp_path, monkeypatch):
    path = tmp_path / 'operator.py'
    path.write_text('x = 1\n', encoding='utf-8')

    import builtins
    real_open = builtins.open

    def fake_open(file, *args, **kwargs):
        if str(file) == str(path):
            raise MemoryError()
        return real_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, 'open', fake_open)
    issues = scan_file_with_ast(str(path))
    assert issues == [{'type': 'file_read_error', 'message': 'MemoryError: '}]


# ---------------------------------------------------------------------------
# 绕过写法：getattr / __builtins__ 下标 / 别名
# ---------------------------------------------------------------------------

def test_getattr_module_bypass(tmp_path):
    source = "import os\ngetattr(os, 'system')('id')\n"
    issues = _scan(source, tmp_path=tmp_path)
    assert 'dangerous_module_call' in _types(issues)
    assert any('getattr' in issue['message'] for issue in issues)


def test_getattr_with_wildcard_pattern(tmp_path):
    source = "import os\ngetattr(os, 'execlp')('/bin/sh', 'sh')\n"
    assert 'dangerous_module_call' in _types(_scan(source, tmp_path=tmp_path))


def test_getattr_of_safe_attr_passes(tmp_path):
    source = "import os\ngetattr(os, 'getcwd')()\n"
    assert _scan(source, tmp_path=tmp_path) == []


def test_getattr_non_constant_attr_passes(tmp_path):
    source = "import os\nname = 'system' + str(1)\ngetattr(os, name)('id')\n"
    assert _scan(source, tmp_path=tmp_path) == []


def test_getattr_call_of_non_getattr_function(tmp_path):
    # func 是 Call 但内层不是 getattr/__getattribute__：直接放过
    source = "print('x')('y')\n"
    assert _scan(source, tmp_path=tmp_path) == []


def test_getattr_with_single_argument(tmp_path):
    source = "import os\ngetattr(os)('id')\n"
    assert _scan(source, tmp_path=tmp_path) == []


def test_dynamic_import_alias_via_from_imported_builtin(tmp_path):
    source = "from builtins import __import__ as builtin_import\nmod = builtin_import('os')\nmod.system('id')\n"
    assert 'dangerous_module_call' in _types(_scan(source, tmp_path=tmp_path))


def test_dynamic_import_alias_non_string_arg_is_ignored(tmp_path):
    # 首参不是字符串常量 → 取不到模块名
    source = "mod = do_build(1)\nmod.system('x')\n"
    assert _scan(source, tmp_path=tmp_path) == []


def test_dynamic_import_alias_without_args_is_ignored(tmp_path):
    # 调用没有实参 → 取不到模块名 → 不建立动态别名，mod 也不在危险清单里
    source = "mod = do_build()\nmod.system('x')\n"
    assert _scan(source, tmp_path=tmp_path) == []


def test_dynamic_non_call_value_is_not_alias(tmp_path):
    source = "import importlib\nmod = 42\n"
    assert _scan(source, tmp_path=tmp_path) == []


def test_builtins_subscript_bypass(tmp_path):
    for name in ('__builtins__', 'builtins'):
        source = f"{name}['eval']('1+1')\n"
        issues = _scan(source, tmp_path=tmp_path)
        assert 'dangerous_builtin' in _types(issues), source


def test_builtins_subscript_safe_key_passes(tmp_path):
    assert _scan("__builtins__['len']([1])\n", tmp_path=tmp_path) == []


def test_dangerous_attribute_alias(tmp_path):
    source = "import os\nhandler = os.system\nhandler('id')\n"
    issues = _scan(source, tmp_path=tmp_path)
    assert 'dangerous_module_call' in _types(issues)
    assert any('alias' in issue['message'] for issue in issues)


def test_dynamic_import_alias_is_tracked(tmp_path):
    source = (
        "import importlib\n"
        "mod = importlib.import_module('os')\n"
        "mod.system('id')\n"
    )
    assert 'dangerous_module_call' in _types(_scan(source, tmp_path=tmp_path))


def test_dynamic_builtin_import_alias_is_tracked(tmp_path):
    source = "mod = __import__('subprocess')\nmod.run('x', shell=True)\n"
    assert 'subprocess_shell_injection' in _types(_scan(source, tmp_path=tmp_path))


def test_ctypes_library_handle_alias(tmp_path):
    source = (
        "import ctypes\n"
        "libc = ctypes.CDLL('libc.so.6')\n"
        "libc.system('id')\n"
    )
    issues = _scan(source, tmp_path=tmp_path)
    assert any('ctypes library handle' in issue['message'] for issue in issues)


def test_flask_debug_true(tmp_path):
    source = "app = object()\napp.run(debug=True)\n"
    issues = _scan(source, tmp_path=tmp_path)
    assert 'flask_debug_enabled' in _types(issues)


def test_run_without_debug_passes(tmp_path):
    assert _scan("app = object()\napp.run()\n", tmp_path=tmp_path) == []


# ---------------------------------------------------------------------------
# 辅助函数的直接单测
# ---------------------------------------------------------------------------

def _visitor():
    return DangerousCodeVisitor(scope_info={})


def test_get_constant_str_variants():
    visitor = _visitor()
    assert visitor._get_constant_str(None) == ''
    const = ast.parse("'abc'", mode='eval').body
    assert visitor._get_constant_str(const) == 'abc'
    number = ast.parse("42", mode='eval').body
    assert visitor._get_constant_str(number) == ''
    legacy = ast.Str(s='old')
    assert visitor._get_constant_str(legacy) == 'old'


def test_has_keyword_arg_value_shapes():
    visitor = _visitor()

    def _call(source):
        tree = ast.parse(source)
        return tree.body[0].value

    assert visitor.has_keyword_arg(_call("f(debug=True)"), 'debug', True) is True
    assert visitor.has_keyword_arg(_call("f(other=True)"), 'debug', True) is False
    assert visitor.has_keyword_arg(_call("f(debug=False)"), 'debug', True) is False
    # 布尔相等的历史坑：Constant(1) == True，扫描器按「真」处理
    assert visitor.has_keyword_arg(_call("f(debug=1)"), 'debug', True) is True
    assert visitor.has_keyword_arg(_call("f(debug=0)"), 'debug', True) is False
    name_call = ast.Call(
        func=ast.Name(id='f'),
        args=[],
        keywords=[ast.keyword(arg='debug', value=ast.Name(id='True'))],
    )
    assert visitor.has_keyword_arg(name_call, 'debug', True) is True
    name_false = ast.Call(
        func=ast.Name(id='f'),
        args=[],
        keywords=[ast.keyword(arg='debug', value=ast.Name(id='False'))],
    )
    assert visitor.has_keyword_arg(name_false, 'debug', True) is False


def test_add_issue_records_location():
    visitor = _visitor()
    node = ast.parse("f()", mode='eval').body
    visitor.add_issue('t', 'msg', node)
    assert visitor.issues == [{'type': 't', 'message': 'msg', 'line': 1, 'col': 0}]


def test_is_dangerous_full_attr():
    assert _is_dangerous_full_attr('os.system') is True
    assert _is_dangerous_full_attr('os.spawnl') is True
    assert _is_dangerous_full_attr('subprocess.run') is True
    assert _is_dangerous_full_attr('os.getcwd') is False
    assert _is_dangerous_full_attr('system') is False


def _attr(source):
    """解析表达式，返回其中的 Attribute 节点。"""
    node = ast.parse(source, mode='eval').body
    if not isinstance(node, ast.Attribute):
        node = node.value
    assert isinstance(node, ast.Attribute)
    return node


def test_resolve_attr_to_full_with_import_maps():
    imports = {'os': 'os', 'sp': 'subprocess'}
    from_imports = {'path': 'os.path'}
    node = _attr('os.system')
    assert _resolve_attr_to_full(node, imports, from_imports) == 'os.system'
    node = _attr('sp.Popen')
    assert _resolve_attr_to_full(node, imports, from_imports) == 'subprocess.Popen'
    node = _attr('path.join')
    assert _resolve_attr_to_full(node, imports, from_imports) == 'os.path.join'
    node = _attr('unknown.thing')
    assert _resolve_attr_to_full(node, imports, from_imports) == ''


def test_resolve_attr_to_full_edge_shapes():
    node = _attr('make().run')  # 根不是 Name（函数调用结果）
    assert _resolve_attr_to_full(node, {}, {}) == ''
    node = _attr('os.system')
    assert _resolve_attr_to_full(node, {}, {}, {}) == ''


def test_resolve_attr_to_full_dynamic_alias():
    imports = {'importlib': 'importlib'}
    node = _attr('mod.system')
    assert _resolve_attr_to_full(node, imports, {}, {'mod': 'os'}) == 'os.system'


def test_collect_scope_stmts_walks_nested_blocks():
    tree = ast.parse(
        "if True:\n"
        "    import os\n"
        "    x = os.system\n"
        "else:\n"
        "    import socket\n"
        "while False:\n"
        "    import json\n"
        "with open('f') as fh:\n"
        "    import sys\n"
        "for _ in range(1):\n"
        "    import time\n"
        "try:\n"
        "    import subprocess\n"
        "except ImportError:\n"
        "    import socket\n"
        "else:\n"
        "    import random\n"
        "finally:\n"
        "    import math\n"
    )
    imports, import_froms, assigns = [], [], []
    _collect_scope_stmts(tree.body, imports, import_froms, assigns)
    names = {alias.name for node in imports for alias in node.names}
    assert {'os', 'socket', 'json', 'sys', 'time', 'subprocess', 'random', 'math'} <= names
    assert len(assigns) == 1


def test_build_scope_info_records_aliases():
    tree = ast.parse(
        "import subprocess as sp\n"
        "from os import system\n"
        "import importlib\n"
        "import ctypes\n"
        "runner = sp.run\n"
        "mod = importlib.import_module('socket')\n"
        "handle = ctypes.CDLL('libc.so.6')\n"
        "a = b = 1\n"
        "items[0] = sp.Popen\n"
    )
    scope_info = _build_scope_info(tree)
    module_scope = next(iter(scope_info.values()))
    assert module_scope['imports'] == {'sp': 'subprocess', 'importlib': 'importlib',
                                       'ctypes': 'ctypes'}
    assert module_scope['from_imports'] == {'system': 'os.system'}
    assert module_scope['dangerous_aliases'] == {'runner': 'subprocess.run'}
    assert module_scope['dynamic_module_aliases'] == {'mod': 'socket'}
    assert module_scope['dangerous_ctype_aliases'] == {'handle'}


def test_scope_info_inherited_into_function_body():
    tree = ast.parse(
        "import os\n"
        "def file_parse(file_path):\n"
        "    handler = os.system\n"
        "    return handler\n"
    )
    scope_info = _build_scope_info(tree)
    func_scope = scope_info[tree.body[1]]  # body[0] 是 import
    assert func_scope['imports'] == {'os': 'os'}
    assert func_scope['dangerous_aliases'] == {'handler': 'os.system'}


# ---------------------------------------------------------------------------
# 出口：format_security_error / validate_code_security
# ---------------------------------------------------------------------------

def test_format_security_error_renders_all_fields():
    text = format_security_error([
        {'type': 'dangerous_builtin', 'message': 'boom', 'line': 3, 'col': 4},
        {'message': 'no location'},
    ])
    assert text.startswith('Code security check failed.')
    assert '[dangerous_builtin] line 3, column 4: boom' in text
    assert '[unknown] line unknown, column unknown: no location' in text


def test_validate_code_security_raises_with_details(tmp_path):
    path = tmp_path / 'operator.py'
    path.write_text("import os\nos.system('id')\n", encoding='utf-8')
    with pytest.raises(Exception) as caught:
        validate_code_security(str(path))
    assert 'Code security check failed' in str(caught.value)


def test_validate_code_security_passes_clean_file(tmp_path):
    path = tmp_path / 'operator.py'
    path.write_text("def file_split(file_path):\n    return []\n", encoding='utf-8')
    validate_code_security(str(path))  # 不抛即通过
