"""系统算子执行路径（``ingestion.utility.operator_zip_action``）的测试。

* **单元**：JSONable 转换、结果交付、三级收尾、``sandbox_worker`` 的各失败分支
  （假 Queue 收集交付物，不真起进程）；
* **端到端**（forkserver，无 Docker）：成功往返、``.err`` / ``.sen_err`` / 超时 /
  崩溃检测 —— 与 ``src/ingestion/tests/test_sandbox.py`` 的 B 路用例同型。
"""

import json
import os

import pytest
from parsing.exception import SensitiveMsgException

from ingestion.utility import operator_zip_action, sandbox_runtime, self_operator
from ingestion.utility.operator_zip_action import (
    _LCDocument,
    _deliver,
    _from_jsonable,
    _terminate,
    _to_jsonable,
    execute_operator_module,
    sandbox_worker,
)


def _write_script(dirpath, filename, source):
    path = os.path.join(dirpath, filename)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(source)
    return path


class FakeQueue:
    def __init__(self, error=None):
        self.items = []
        self.error = error

    def put(self, item):
        if self.error is not None:
            raise self.error
        self.items.append(item)


@pytest.fixture()
def quiet_worker(monkeypatch):
    """直接调用 ``sandbox_worker`` 时屏蔽三个进程级副作用。"""
    monkeypatch.setattr(sandbox_runtime, 'sanitize_environment', lambda: [])
    monkeypatch.setattr(sandbox_runtime, 'ensure_import_root', lambda: None)
    monkeypatch.setattr(operator_zip_action, 'set_resource_limits', lambda *a, **kw: None)


# ---------------------------------------------------------------------------
# JSONable 转换
# ---------------------------------------------------------------------------

def test_to_jsonable_scalars_and_containers():
    assert _to_jsonable(None) is None
    assert _to_jsonable('x') == 'x'
    assert _to_jsonable(1) == 1
    assert _to_jsonable(1.5) == 1.5
    assert _to_jsonable(True) is True
    assert _to_jsonable({'a': (1, 2)}) == {'a': [1, 2]}
    assert _to_jsonable([{'b': 2}]) == [{'b': 2}]


def test_to_jsonable_document_object():
    doc = _LCDocument('content', {'source': 's'}, 'id-1')
    assert _to_jsonable(doc) == {'page_content': 'content', 'metadata': {'source': 's'},
                                 'id': 'id-1'}


def test_to_jsonable_rejects_other_objects():
    with pytest.raises(TypeError) as caught:
        _to_jsonable({1, 2})
    assert 'JSON-serializable' in str(caught.value)


def test_from_jsonable_restores_documents():
    payload = [{'page_content': 'c', 'metadata': {'k': 1}, 'id': 'i'},
               {'plain': 1}, 5, 'x']
    result = _from_jsonable(payload)
    assert isinstance(result[0], _LCDocument)
    assert result[0].page_content == 'c' and result[0].id == 'i'
    assert result[1] == {'plain': 1}
    assert result[2] == 5 and result[3] == 'x'


# ---------------------------------------------------------------------------
# 交付与收尾
# ---------------------------------------------------------------------------

def test_deliver_puts_payload():
    queue = FakeQueue()
    _deliver(queue, 'payload', None)
    assert queue.items == ['payload']


def test_deliver_reraises_on_put_failure(caplog):
    queue = FakeQueue(error=RuntimeError("can't start new thread"))
    with pytest.raises(RuntimeError, match="can't start new thread"):
        _deliver(queue, '/tmp/x.json', RuntimeError('original'))
    # 交付失败要留日志：内存配额耗尽不能伪装成「算子执行失败」
    assert any('failed to deliver' in rec.getMessage() for rec in caplog.records)


class FakeProcess:
    def __init__(self, alive=True, killable=True):
        self.alive = alive
        self.calls = []
        self.killable = killable

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.alive = False
        self.calls.append('terminate')

    def kill(self):
        self.alive = False
        self.calls.append('kill')

    def join(self, timeout=None):
        self.calls.append(('join', timeout))


def test_terminate_noop_for_none():
    _terminate(None)


def test_terminate_finished_process_only_joins():
    proc = FakeProcess(alive=False)
    _terminate(proc)
    assert proc.calls == [('join', 5)]


def test_terminate_kills_stubborn_process():
    class Stubborn(FakeProcess):
        def __init__(self):
            super().__init__(alive=True)
            self.joins = 0

        def is_alive(self):
            return self.joins < 2  # 第一次 join 后仍「活着」

        def join(self, timeout=None):
            self.joins += 1
            self.calls.append(('join', timeout))

    proc = Stubborn()
    _terminate(proc)
    assert proc.calls == ['terminate', ('join', 5), 'kill', ('join', 2)]


def test_terminate_without_kill_capability():
    class NoKill(FakeProcess):
        kill = None  # 与旧版 multiprocessing 对齐：没有 kill 能力

    proc = NoKill(alive=True)
    del NoKill.kill
    _terminate(proc)
    assert proc.calls == ['terminate', ('join', 5)]


# ---------------------------------------------------------------------------
# sandbox_worker：子进程入口的各分支
# ---------------------------------------------------------------------------

def test_worker_success_writes_json_result(quiet_worker, tmp_path):
    module = _write_script(
        tmp_path, 'ok.py',
        "def file_split(file_path):\n"
        "    return [{'page_content': '文本', 'metadata': {'s': 1}}]\n")
    queue = FakeQueue()
    sandbox_worker(queue, module, 'file_split', str(tmp_path), file_path='f')
    assert queue.items and queue.items[0].endswith('.json')
    with open(queue.items[0], encoding='utf-8') as f:
        assert json.load(f) == [{'page_content': '文本', 'metadata': {'s': 1}}]


def test_worker_missing_function_writes_err(quiet_worker, tmp_path):
    module = _write_script(tmp_path, 'nofn.py', "x = 1\n")
    queue = FakeQueue()
    sandbox_worker(queue, module, 'file_split', str(tmp_path))
    assert queue.items[0].endswith('.err')
    with open(queue.items[0], encoding='utf-8') as f:
        assert "Function 'file_split' not found" in f.read()


def test_worker_exception_message_written_verbatim(quiet_worker, tmp_path):
    module = _write_script(
        tmp_path, 'boom.py',
        "def file_split(file_path):\n    raise RuntimeError('切分失败')\n")
    queue = FakeQueue()
    sandbox_worker(queue, module, 'file_split', str(tmp_path), file_path='f')
    with open(queue.items[0], encoding='utf-8') as f:
        assert f.read() == '切分失败'


def test_worker_exception_with_message_attr_writes_key_only(quiet_worker, tmp_path):
    """带 ``.message`` 的异常（message 即文案键）只写键，str() 的细节不进信封。"""
    module = _write_script(
        tmp_path, 'keyerr.py',
        "class ParseEmptyError(Exception):\n"
        "    def __init__(self):\n"
        "        super().__init__('RetCode.operator.split.empty + diag')\n"
        "        self.message = 'RetCode.operator.split.empty'\n"
        "def file_split(file_path):\n    raise ParseEmptyError()\n")
    queue = FakeQueue()
    sandbox_worker(queue, module, 'file_split', str(tmp_path), file_path='f')
    with open(queue.items[0], encoding='utf-8') as f:
        assert f.read() == 'RetCode.operator.split.empty'


def test_worker_sensitive_msg_exception_writes_sen_err(quiet_worker, tmp_path):
    module = _write_script(
        tmp_path, 'sen.py',
        "from parsing.exception import SensitiveMsgException\n"
        "def file_split(file_path):\n"
        "    raise SensitiveMsgException('0004', None, {'zh_CN': '坏', 'en_US': 'bad'})\n")
    queue = FakeQueue()
    sandbox_worker(queue, module, 'file_split', str(tmp_path), file_path='f')
    assert queue.items[0].endswith('.sen_err')
    with open(queue.items[0], encoding='utf-8') as f:
        payload = json.load(f)
    assert payload['code'] == '0004'
    assert payload['message_dict'] == {'zh_CN': '坏', 'en_US': 'bad'}


def test_worker_security_scan_blocks_dangerous_module(quiet_worker, tmp_path):
    module = _write_script(tmp_path, 'evil.py', "import os\nos.system('id')\n")
    queue = FakeQueue()
    sandbox_worker(queue, module, 'file_split', str(tmp_path))
    with open(queue.items[0], encoding='utf-8') as f:
        assert 'security check failed' in f.read().lower()


def test_worker_deliver_failure_propagates(quiet_worker, tmp_path):
    module = _write_script(tmp_path, 'ok.py', "def file_split(file_path):\n    return 1\n")
    queue = FakeQueue(error=RuntimeError("can't start new thread"))
    with pytest.raises(RuntimeError, match="can't start new thread"):
        sandbox_worker(queue, module, 'file_split', str(tmp_path), file_path='f')


# ---------------------------------------------------------------------------
# execute_operator_module：端到端（forkserver）
# ---------------------------------------------------------------------------

def test_execute_operator_roundtrip_restores_documents(tmp_path):
    module = _write_script(
        tmp_path, 'ok.py',
        "def file_split_with_chunk(file_path):\n"
        "    return [{'page_content': 'chunk', 'metadata': {'source': 'f.md'}, 'id': 1}]\n")
    docs = execute_operator_module(module, 'file_split_with_chunk', file_path='f')
    assert isinstance(docs[0], _LCDocument)
    assert docs[0].metadata == {'source': 'f.md'}


def test_execute_operator_error_file_becomes_runtime_error(tmp_path):
    module = _write_script(
        tmp_path, 'boom.py',
        "def file_split(file_path):\n    raise RuntimeError('RetCode.operator.split.empty')\n")
    with pytest.raises(RuntimeError, match='RetCode.operator.split.empty'):
        execute_operator_module(module, 'file_split', file_path='f')


def test_execute_operator_sensitive_error_is_restored(tmp_path):
    module = _write_script(
        tmp_path, 'sen.py',
        "from parsing.exception import SensitiveMsgException\n"
        "def file_split(file_path):\n"
        "    raise SensitiveMsgException('0004', {'kb': 1}, {'zh_CN': '敏感词', 'en_US': 'x'})\n")
    with pytest.raises(SensitiveMsgException) as caught:
        execute_operator_module(module, 'file_split', file_path='f')
    assert caught.value.code == '0004'
    assert caught.value.get_i18n_message('zh_CN') == '敏感词'


def test_execute_operator_timeout_is_bounded(tmp_path, monkeypatch):
    module = _write_script(
        tmp_path, 'hang.py', "def file_split(file_path):\n    while True:\n        pass\n")
    monkeypatch.setenv('OPERATOR_TIMEOUT_SECONDS', '2')
    with pytest.raises(self_operator.SandboxTimeoutError, match='timed out'):
        execute_operator_module(module, 'file_split', file_path='f')


def test_execute_operator_detects_crash_without_result(tmp_path):
    module = _write_script(
        tmp_path, 'crash.py',
        "import os\n"
        "def file_split(file_path):\n    os._exit(7)\n")
    with pytest.raises(RuntimeError, match='exitcode=7'):
        execute_operator_module(module, 'file_split', file_path='f')


def test_execute_operator_parent_scans_code_first(tmp_path):
    module = _write_script(tmp_path, 'evil.py', "import os\nos.system('id')\n")
    with pytest.raises(Exception) as caught:
        execute_operator_module(module, 'file_split', file_path='f')
    assert 'security check failed' in str(caught.value).lower()


def test_execute_operator_warns_when_child_lingers_after_result(tmp_path):
    """子进程交付结果后没退干净：只告警收尾，不推翻已拿到的结果。"""
    module = _write_script(
        tmp_path, 'linger.py',
        "import threading, time\n"
        "def file_split(file_path):\n"
        "    threading.Thread(target=lambda: time.sleep(30)).start()\n"
        "    return [{'page_content': 'x', 'metadata': {}}]\n")
    docs = execute_operator_module(module, 'file_split', file_path='f')
    assert isinstance(docs[0], _LCDocument)


def test_execute_operator_tolerates_queue_close_failure(tmp_path, monkeypatch):
    """queue 收尾失败被吞掉（收尾尽力而为）。

    只在**父进程侧**的队列实例上覆写 ``close``（子进程经 pickling 拿到的是干净副本，
    不受实例属性影响）。
    """
    module = _write_script(tmp_path, 'ok.py', "def file_split(file_path):\n    return []\n")
    real_ctx = sandbox_runtime.sandbox_context()

    class ShimCtx:
        Process = staticmethod(real_ctx.Process)

        @staticmethod
        def Queue():
            queue = real_ctx.Queue()

            def broken_close():
                raise RuntimeError('already closed')

            queue.close = broken_close
            return queue

    monkeypatch.setattr(sandbox_runtime, 'sandbox_context', lambda: ShimCtx())
    result = execute_operator_module(module, 'file_split', file_path='f')
    assert result == []


def test_execute_operator_temp_dir_is_cleaned(tmp_path):
    module = _write_script(tmp_path, 'ok.py', "def file_split(file_path):\n    return []\n")
    before = {name for name in os.listdir('/tmp') if name.startswith('op_')}
    execute_operator_module(module, 'file_split', file_path='f')
    leftovers = {name for name in os.listdir('/tmp') if name.startswith('op_')} - before
    assert leftovers == set()
