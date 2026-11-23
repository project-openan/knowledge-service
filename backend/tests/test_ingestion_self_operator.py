"""自定义算子沙箱（``ingestion.utility.self_operator``）的测试。

两部分：

* **纯单元**：超时解析、结果序列化、参数/返回类型校验、``target_function``
  的各失败分支（用假 conn 收集回传消息，不真起进程）；
* **端到端**（forkserver，不依赖 Docker）：成功往返、错误回传、超时、
  受控参数过滤 —— 与 ``src/ingestion/tests/test_sandbox.py`` 同一模式，
  但落在 pytest 套件里。

跑法::

    python -m pytest tests/test_ingestion_self_operator.py -q
"""

import builtins
import os
import resource
import subprocess
import sys
import tempfile
import time

import pytest

from ingestion.utility import sandbox_runtime, self_operator
from ingestion.utility.self_operator import (
    OperatorResultSerializationError,
    OperatorResultTooLargeError,
    ParameterValidationError,
    SandboxTimeoutError,
    _json_default,
    _memory_limit_bytes,
    _resolve_timeout,
    _result_max_bytes,
    _serialize_result,
    _try_disable_network,
    _unwrap_sandbox_error,
    _env_int,
    _current_vmsize_bytes,
    check_operator_code,
    execute_function_in_sandbox,
    extract_params,
    extract_params_type,
    load_module_from_file,
    set_resource_limits,
    target_function,
    validate_parameters,
    validate_return_type,
)


def src_root():
    """import 根（``src/``）：self_operator.py 上溯三层。"""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(self_operator.__file__))))


def _write_script(dirpath, filename, source):
    path = os.path.join(dirpath, filename)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(source)
    return path


class FakeConn:
    """收集 ``conn.send`` 的消息；可选让 send / close 抛错。"""

    def __init__(self, send_error=None, close_error=None):
        self.messages = []
        self.send_error = send_error
        self.close_error = close_error
        self.closed = False

    def send(self, message):
        if self.send_error is not None:
            raise self.send_error
        self.messages.append(message)

    def close(self):
        if self.close_error is not None:
            raise self.close_error
        self.closed = True


@pytest.fixture()
def quiet_sandbox(monkeypatch):
    """直接调用 ``target_function`` 时屏蔽三个进程级副作用。

    ``target_function`` 是子进程入口：环境收敛、导入根、RLIMIT_AS 都只该发生在
    沙箱子进程里，单元测试里全部换成 no-op。
    """
    monkeypatch.setattr(sandbox_runtime, 'sanitize_environment', lambda: [])
    monkeypatch.setattr(sandbox_runtime, 'ensure_import_root', lambda: None)
    monkeypatch.setattr(self_operator, 'set_resource_limits', lambda *a, **kw: None)
    monkeypatch.setattr(self_operator, '_try_disable_network', lambda: False)


# ---------------------------------------------------------------------------
# 可配置项与超时解析
# ---------------------------------------------------------------------------

@pytest.mark.parametrize('raw, default, expected', [
    (None, 7, 7),
    ('', 7, 7),
    ('12', 7, 12),
    ('not-a-number', 7, 7),
    (object(), 7, 7),
])
def test_env_int(monkeypatch, raw, default, expected):
    if raw is None:
        monkeypatch.delenv('X_KNOB', raising=False)
    else:
        monkeypatch.setenv('X_KNOB', raw if isinstance(raw, str) else str(raw))
    assert _env_int('X_KNOB', default) == expected


def test_memory_and_result_limits_from_env(monkeypatch):
    monkeypatch.setenv('OPERATOR_MEMORY_LIMIT_MB', '256')
    assert _memory_limit_bytes() == 256 * 1024 * 1024
    monkeypatch.setenv('OPERATOR_RESULT_MAX_BYTES', '128')
    assert _result_max_bytes() == 128


def test_resolve_timeout_fallback_for_unknown_function(monkeypatch):
    monkeypatch.delenv('OPERATOR_TIMEOUT_SECONDS', raising=False)
    monkeypatch.delenv('OPERATOR_UNKNOWN_FN_TIMEOUT_SECONDS', raising=False)
    assert _resolve_timeout('unknown_fn', None) == 600
    monkeypatch.setenv('OPERATOR_UNKNOWN_FN_TIMEOUT_SECONDS', '77')
    assert _resolve_timeout('unknown_fn', None) == 77


def test_resolve_timeout_ignores_non_positive_env(monkeypatch):
    monkeypatch.setenv('OPERATOR_FILE_SPLIT_TIMEOUT_SECONDS', '0')
    monkeypatch.delenv('OPERATOR_TIMEOUT_SECONDS', raising=False)
    assert _resolve_timeout('file_split', None) == 300


# ---------------------------------------------------------------------------
# 基线 VmSize / RLIMIT
# ---------------------------------------------------------------------------

def test_current_vmsize_bytes_is_positive():
    assert _current_vmsize_bytes() > 0


def test_current_vmsize_bytes_returns_zero_on_read_error(monkeypatch):
    def boom(*args, **kwargs):
        raise OSError('no procfs')

    monkeypatch.setattr(builtins, 'open', boom)
    assert _current_vmsize_bytes() == 0


def test_current_vmsize_bytes_tolerates_malformed_status(monkeypatch):
    class FakeFile:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def __iter__(self):
            return iter(['VmSize: not-a-number kb\n'])

    monkeypatch.setattr(builtins, 'open', lambda *a, **kw: FakeFile())
    assert _current_vmsize_bytes() == 0


def _set_limit_in_child(memory_limit_mb):
    """在 fork 子进程里设 RLIMIT_AS 并回读：硬限不可恢复，不能在主进程设。"""
    import multiprocessing
    ctx = multiprocessing.get_context('fork')
    parent_conn, child_conn = ctx.Pipe()

    def child():
        baseline = _current_vmsize_bytes()
        try:
            set_resource_limits(memory_limit_mb)
            soft, hard = resource.getrlimit(resource.RLIMIT_AS)
            child_conn.send(('ok', baseline, soft, hard))
        except Exception as e:  # noqa: BLE001
            child_conn.send(('error', str(e), 0, 0))

    proc = ctx.Process(target=child)
    proc.start()
    outcome, baseline, soft, hard = parent_conn.recv()
    proc.join(timeout=10)
    assert outcome == 'ok', (baseline, soft, hard)
    return baseline, soft, hard


def test_set_resource_limits_uses_baseline_plus_quota():
    baseline, soft, hard = _set_limit_in_child(64)
    assert soft == hard
    assert baseline + 64 * 1024 * 1024 - 1024 * 1024 <= soft <= baseline + 64 * 1024 * 1024 + 1024 * 1024


def test_set_resource_limits_reads_quota_from_env(monkeypatch):
    monkeypatch.setenv('OPERATOR_MEMORY_LIMIT_MB', '32')
    baseline, soft, _hard = _set_limit_in_child(None)
    assert baseline + 32 * 1024 * 1024 - 1024 * 1024 <= soft


# ---------------------------------------------------------------------------
# 禁网（尽力而为）
# ---------------------------------------------------------------------------

def test_try_disable_network_degrades_gracefully():
    # 无特权环境下 unshare 返回非 0 → False；有特权则 True。两者都算通过。
    assert _try_disable_network() in (True, False)


def test_try_disable_network_swallows_ctypes_failure(monkeypatch):
    import ctypes

    def boom(*args, **kwargs):
        raise RuntimeError('no libc')

    monkeypatch.setattr(ctypes, 'CDLL', boom)
    assert _try_disable_network() is False


def test_try_disable_network_true_when_unshare_succeeds(monkeypatch):
    import ctypes

    class FakeLibc:
        def unshare(self, _flag):
            return 0

    monkeypatch.setattr(ctypes, 'CDLL', lambda *a, **kw: FakeLibc())
    assert _try_disable_network() is True


# ---------------------------------------------------------------------------
# 结果序列化
# ---------------------------------------------------------------------------

def test_json_default_rejects_custom_objects():
    with pytest.raises(TypeError) as caught:
        _json_default(object())
    assert 'JSON-serializable' in str(caught.value)


def test_serialize_result_roundtrip():
    data = _serialize_result({'k': '值', 'n': [1, 2]})
    assert b'\xe5' in data  # ensure_ascii=False → 中文原样编码
    import json
    assert json.loads(data.decode('utf-8')) == {'k': '值', 'n': [1, 2]}


def test_serialize_result_rejects_custom_objects():
    with pytest.raises(OperatorResultSerializationError):
        _serialize_result(object())


def test_serialize_result_enforces_size_limit(monkeypatch):
    monkeypatch.setenv('OPERATOR_RESULT_MAX_BYTES', '16')
    with pytest.raises(OperatorResultTooLargeError) as caught:
        _serialize_result('x' * 64)
    assert 'exceeds limit' in str(caught.value)


# ---------------------------------------------------------------------------
# target_function：子进程入口的各分支（假 conn，不起进程）
# ---------------------------------------------------------------------------

def _run_target(script_path, function_name, conn=None, params=None):
    conn = conn or FakeConn()
    target_function(conn, script_path, function_name, params or {})
    return conn


def test_target_success_delivers_result_file(quiet_sandbox, tmp_path):
    script = _write_script(tmp_path, 'ok.py', "def file_split(file_path):\n    return {'ok': 1}\n")
    conn = _run_target(script, 'file_split', params={'file_path': 'f'})
    status, path = conn.messages[0]
    assert status == 'success'
    with open(path, 'rb') as f:
        import json
        assert json.load(f) == {'ok': 1}
    os.remove(path)


def test_target_missing_script(quiet_sandbox, tmp_path):
    conn = _run_target(str(tmp_path / 'nope.py'), 'file_split')
    status, message = conn.messages[0]
    assert status == 'error'
    assert message.startswith('FileNotFoundError')


def test_target_missing_function(quiet_sandbox, tmp_path):
    script = _write_script(tmp_path, 'nofn.py', "x = 1\n")
    status, message = _run_target(script, 'file_split').messages[0]
    assert status == 'error'
    assert "Function 'file_split' not found" in message


def test_target_non_callable_attribute(quiet_sandbox, tmp_path):
    script = _write_script(tmp_path, 'notcallable.py', "file_split = 42\n")
    status, message = _run_target(script, 'file_split').messages[0]
    assert status == 'error'
    assert 'not callable' in message


def test_target_operator_exception_is_reported(quiet_sandbox, tmp_path):
    script = _write_script(tmp_path, 'boom.py',
                           "def file_split(file_path):\n    raise ValueError('kaboom')\n")
    status, message = _run_target(script, 'file_split', params={'file_path': 'f'}).messages[0]
    assert status == 'error'
    assert message == 'ValueError: kaboom'


def test_target_security_rejects_dangerous_code(quiet_sandbox, tmp_path):
    script = _write_script(tmp_path, 'evil.py', "import os\nos.system('id')\n")
    status, message = _run_target(script, 'file_split').messages[0]
    assert status == 'error'
    assert 'security check failed' in message.lower()


def test_target_send_failure_is_logged(quiet_sandbox, tmp_path, caplog):
    script = _write_script(tmp_path, 'boom.py',
                           "def file_split(file_path):\n    raise ValueError('kaboom')\n")
    conn = FakeConn(send_error=RuntimeError('broken pipe'))
    _run_target(script, 'file_split', conn=conn, params={'file_path': 'f'})
    # logging.exception(e) 的 getMessage() 是 str(e)
    assert any(rec.getMessage() == 'kaboom' for rec in caplog.records)


def test_target_close_failure_is_logged(quiet_sandbox, tmp_path, caplog):
    script = _write_script(tmp_path, 'ok.py', "def file_split(file_path):\n    return 1\n")
    conn = FakeConn(close_error=RuntimeError('close failed'))
    _run_target(script, 'file_split', conn=conn, params={'file_path': 'f'})
    assert any(rec.getMessage() == 'failed to close sandbox connection' for rec in caplog.records)


# ---------------------------------------------------------------------------
# 端到端（forkserver，无 Docker）
# ---------------------------------------------------------------------------

def test_sandbox_roundtrip(tmp_path):
    script = _write_script(tmp_path, 'ok.py',
                           "def file_split(file_path, **kwargs):\n"
                           "    return [{'content': '你好', 'metadata': {'k': 1}}]\n")
    assert execute_function_in_sandbox(script, 'file_split', file_path='f') == \
        [{'content': '你好', 'metadata': {'k': 1}}]


def test_sandbox_filters_controlled_context_args(tmp_path):
    script = _write_script(
        tmp_path, 'args.py',
        "def file_split(**kwargs):\n    return {'received': sorted(kwargs)}\n")
    result = execute_function_in_sandbox(script, 'file_split', emp_no='1', kbase_id='2',
                                         format='md', max_word=8)
    assert result == {'received': ['max_word']}


def test_sandbox_error_is_wrapped_with_type(tmp_path):
    script = _write_script(tmp_path, 'boom.py',
                           "def file_split(file_path):\n    raise ValueError('kaboom')\n")
    with pytest.raises(RuntimeError) as caught:
        execute_function_in_sandbox(script, 'file_split', file_path='f')
    assert 'Sandbox function failed' in str(caught.value)
    assert 'ValueError: kaboom' in str(caught.value)


def test_sandbox_unwraps_message_key_errors(tmp_path):
    script = _write_script(
        tmp_path, 'keyerr.py',
        "class ParseEmptyError(Exception):\n"
        "    def __init__(self):\n"
        "        super().__init__('RetCode.operator.split.empty | diag')\n"
        "def file_split(file_path):\n    raise ParseEmptyError()\n")
    with pytest.raises(RuntimeError) as caught:
        execute_function_in_sandbox(script, 'file_split', file_path='f')
    # message 即文案键的异常：丢掉类型前缀，键原样带回
    assert 'Sandbox function failed: RetCode.operator.split.empty | diag' in str(caught.value)
    assert 'ParseEmptyError' not in str(caught.value)


def test_sandbox_timeout_raises_dedicated_error(tmp_path):
    script = _write_script(tmp_path, 'loop.py',
                           "def file_split(file_path):\n    while True:\n        pass\n")
    with pytest.raises(SandboxTimeoutError):
        execute_function_in_sandbox(script, 'file_split', timeout=2, file_path='f')


def test_sandbox_missing_script_fails_fast(tmp_path):
    # 父进程的 AST 扫描先跑：读不到文件以 file_read_error 报出
    with pytest.raises(Exception) as caught:
        execute_function_in_sandbox(str(tmp_path / 'nope.py'), 'file_split')
    assert 'FileNotFoundError' in str(caught.value)


def test_sandbox_rejects_dangerous_script_without_spawning(tmp_path):
    script = _write_script(tmp_path, 'evil.py', "import os\nos.system('id')\n")
    with pytest.raises(Exception) as caught:
        execute_function_in_sandbox(script, 'file_split', file_path='f')
    assert 'security check failed' in str(caught.value).lower()


def test_sandbox_result_file_is_cleaned_up(tmp_path):
    script = _write_script(tmp_path, 'ok.py', "def file_split(file_path):\n    return 'x'\n")
    before = set(os.listdir(tempfile.gettempdir()))
    execute_function_in_sandbox(script, 'file_split', file_path='f')
    after = set(os.listdir(tempfile.gettempdir()))
    # 不留下新的 .json 结果文件（finally 里已删除）
    assert not [name for name in after - before if name.endswith('.json')]


def test_unwrap_sandbox_error_variants():
    # 内层 message 以 RetCode./Recode. 开头 → 丢掉类型前缀，其余原样带回
    assert _unwrap_sandbox_error('ValueError: RetCode.operator.split.empty') == \
        'RetCode.operator.split.empty'
    assert _unwrap_sandbox_error('ValueError: RetCode.operator.split.empty (diag)') == \
        'RetCode.operator.split.empty (diag)'
    assert _unwrap_sandbox_error('TypeError: Recode.x detail') == 'Recode.x detail'
    # 普通异常原样带回
    assert _unwrap_sandbox_error('ValueError: kaboom') == 'ValueError: kaboom'
    assert _unwrap_sandbox_error('no separator here') == 'no separator here'
    assert _unwrap_sandbox_error('RetCode.starts-but-no-colon-sep') == \
        'RetCode.starts-but-no-colon-sep'


# ---------------------------------------------------------------------------
# 模块加载与代码结构检查
# ---------------------------------------------------------------------------

def test_load_module_from_file_registers_in_sys_modules(tmp_path):
    script = _write_script(tmp_path, 'mymod_probe.py', "VALUE = 7\ndef file_split():\n    return VALUE\n")
    module = load_module_from_file(script)
    assert module.VALUE == 7
    assert module.file_split() == 7
    import sys
    assert sys.modules['mymod_probe'] is module


def _typed_operator_script(tmp_path):
    return _write_script(
        tmp_path, 'typed.py',
        "def file_parse(file_path: str) -> str:\n    return file_path\n")


def test_check_operator_code_accepts_valid_operator(tmp_path):
    script = _typed_operator_script(tmp_path)
    check_operator_code(script, 'file_parse', {'file_path': 'str'})


def test_check_operator_code_rejects_unsupported_param_type(tmp_path):
    script = _typed_operator_script(tmp_path)
    with pytest.raises(Exception) as caught:
        check_operator_code(script, 'file_parse', {'file_path': 'float'})
    assert 'not support' in str(caught.value)


def test_check_operator_code_rejects_missing_function(tmp_path):
    script = _write_script(tmp_path, 'nofn.py', "x = 1\n")
    with pytest.raises(Exception) as caught:
        check_operator_code(script, 'file_parse', {})
    assert 'not found' in str(caught.value)


def test_check_operator_code_wraps_parameter_validation_error(tmp_path):
    script = _write_script(
        tmp_path, 'wrongtype.py',
        "def file_parse(file_path: int) -> str:\n    return str(file_path)\n")
    with pytest.raises(Exception) as caught:
        check_operator_code(script, 'file_parse', {'file_path': 'str'})
    assert 'Parameter validation error' in str(caught.value)


def test_check_operator_code_requires_str_return_for_file_parse(tmp_path):
    script = _write_script(
        tmp_path, 'badreturn.py',
        "def file_parse(file_path: str) -> int:\n    return 1\n")
    with pytest.raises(Exception) as caught:
        check_operator_code(script, 'file_parse', {'file_path': 'str'})
    assert "should return 'str'" in str(caught.value)


# ---------------------------------------------------------------------------
# 参数/返回注解校验
# ---------------------------------------------------------------------------

def _func_of(source):
    namespace = {}
    exec(source, namespace)
    return namespace['f']


def test_validate_parameters_ok_and_missing():
    func = _func_of("def f(a: str, b=1):\n    pass\n")
    validate_parameters(func, 'a', str)
    with pytest.raises(ParameterValidationError) as caught:
        validate_parameters(func, 'missing', str)
    assert "Parameter 'missing' not found in function 'f'" in str(caught.value)


def test_validate_parameters_annotation_mismatch_and_empty():
    func = _func_of("def f(a: str, b):\n    pass\n")
    with pytest.raises(ParameterValidationError) as caught:
        validate_parameters(func, 'a', int)
    assert "should be of type 'int', but got 'str'" in str(caught.value)
    with pytest.raises(ParameterValidationError) as caught:
        validate_parameters(func, 'b', int)
    assert "but got 'None'" in str(caught.value)


def test_validate_return_type_variants():
    ok = _func_of("def f() -> str:\n    return ''\n")
    validate_return_type(ok, str)
    bad = _func_of("def f() -> int:\n    return 1\n")
    with pytest.raises(ParameterValidationError) as caught:
        validate_return_type(bad, str)
    assert "Function 'f' should return 'str', but got 'int'" in str(caught.value)
    empty = _func_of("def f():\n    return 1\n")
    with pytest.raises(ParameterValidationError) as caught:
        validate_return_type(empty, str)
    assert "but got 'None'" in str(caught.value)


# ---------------------------------------------------------------------------
# 算子参数列表解析
# ---------------------------------------------------------------------------

def test_extract_params_none_and_list():
    assert extract_params(None) == {}
    # 没有 argName 的项会落成 None 键（现状如此，这里钉住行为）
    assert extract_params([
        {'argName': 'a', 'defaultValue': '1'},
        {'argName': 'b', 'defaultValue': None},
        {},
    ]) == {'a': '1', 'b': None, None: None}


def test_extract_params_type_none_and_list():
    assert extract_params_type(None) == {}
    assert extract_params_type([
        {'argName': 'a', 'argType': 'String'},
        {'other': True},
    ]) == {'a': 'String', None: None}


# ---------------------------------------------------------------------------
# forkserver 上下文装配（sandbox_runtime 的公开行为在这里一并钉住）
# ---------------------------------------------------------------------------

def test_sandbox_context_is_forkserver_with_guarded_preload():
    from ingestion.utility.sandbox_runtime import PRELOAD_MODULES
    ctx = sandbox_runtime.sandbox_context()
    assert ctx.get_start_method() == 'forkserver'
    assert '__main__' not in PRELOAD_MODULES
    assert 'ingestion.utility.self_operator' in PRELOAD_MODULES


def test_sandbox_child_does_not_reimport_entry(tmp_path):
    """沙箱子进程不重跑入口模块、不复制常驻后台线程。"""
    script = _write_script(
        tmp_path, 'probe.py',
        "import sys, threading\n"
        "def file_split(file_path):\n"
        "    main_mod = sys.modules.get('__main__')\n"
        "    return {'main_file': str(getattr(main_mod, '__file__', '') or ''),\n"
        "            'threads': [t.name for t in threading.enumerate()]}\n")
    result = execute_function_in_sandbox(script, 'file_split', file_path='f')
    assert 'main.py' not in result['main_file']
    assert result['threads'] == ['MainThread']


def test_sandbox_child_env_is_sanitized(tmp_path):
    """知识库数据侧凭据不进算子进程（独立进程跑：forkserver 服务进程的 env 是
    首次使用时定格的，进程内 setenv 传不到已运行的服务进程）。"""
    script = _write_script(
        tmp_path, 'envprobe.py',
        "import os\n"
        "def file_split(file_path):\n    return {'keys': sorted(os.environ)}\n")
    code = (
        "import os, sys\n"
        "sys.path.insert(0, %r)\n"
        "os.environ['RKB_DB_PASSWORD'] = 'should-not-leak'\n"
        "os.environ['RKB_ES_PASSWORD'] = 'should-not-leak'\n"
        "os.environ['MODEL_GATEWAY_URL'] = 'http://gateway.invalid'\n"
        "os.environ['OPERATOR_TEST_PROBE'] = 'keep-me'\n"
        "from ingestion.utility.self_operator import execute_function_in_sandbox\n"
        "keys = execute_function_in_sandbox(%r, 'file_split', file_path='f')['keys']\n"
        "assert 'RKB_DB_PASSWORD' not in keys, '数据侧凭据泄漏进算子进程'\n"
        "assert 'RKB_ES_PASSWORD' not in keys, 'ES 凭据泄漏进算子进程'\n"
        # 模型端点配置是**刻意保留**的（抽图算子出站要调模型网关），见 _KEEP_ENV_PREFIXES
        "assert 'MODEL_GATEWAY_URL' in keys, '模型端点配置被误删'\n"
        "assert 'OPERATOR_TEST_PROBE' in keys, '算子自身旋钮被误删'\n"
    ) % (src_root(), str(script))
    proc = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True,
                          env={**os.environ, 'LOG_DIR': os.environ.get('LOG_DIR', '/tmp/ks-logs')})
    assert proc.returncode == 0, proc.stderr.strip() or proc.stdout.strip()


def test_sandbox_child_memory_headroom(tmp_path):
    """子进程的 RLIMIT_AS 至少是基线 + 200MB（配额没被绝对上限顶掉）。"""
    script = _write_script(
        tmp_path, 'mem.py',
        "import resource\n"
        "def file_split(file_path):\n"
        "    soft, hard = resource.getrlimit(resource.RLIMIT_AS)\n"
        "    return {'soft': soft, 'hard': hard}\n")
    result = execute_function_in_sandbox(script, 'file_split', file_path='f')
    assert result['soft'] == result['hard']
    assert result['soft'] > 200 * 1024 * 1024


def test_sandbox_result_file_removal_failure_is_tolerated(tmp_path, monkeypatch):
    script = _write_script(tmp_path, 'ok.py', "def file_split(file_path):\n    return 'x'\n")
    import logging as _logging

    def boom(path, *args, **kwargs):
        raise OSError('device busy')

    real_remove = os.remove
    monkeypatch.setattr(os, 'remove', boom)
    result = execute_function_in_sandbox(script, 'file_split', file_path='f')
    monkeypatch.setattr(os, 'remove', real_remove)
    assert result == 'x'


def test_sandbox_timeout_budget_is_bounded(tmp_path):
    """显式小超时立即生效，进程被收尾（不留僵尸）。"""
    script = _write_script(tmp_path, 'loop.py', "def file_split(file_path):\n    while True:\n        pass\n")
    start = time.monotonic()
    with pytest.raises(SandboxTimeoutError):
        execute_function_in_sandbox(script, 'file_split', timeout=1, file_path='f')
    assert time.monotonic() - start < 30
