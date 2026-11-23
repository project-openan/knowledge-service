"""``knowledge_base.task``：wrapper / queue 门面 / runtime / executor / chain。

不连库：``connection``、引擎、``pg_queue``、handler 链全部用桩。

跑法（服务目录下）::

    python -m pytest tests/test_kb_task_facade.py -q
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from infrastructure.tasks import TaskRejectedError
from knowledge_base.task import chain as task_chain
from knowledge_base.task import executor as file_runner
from knowledge_base.task import operator_runtime
from knowledge_base.task import queue as task_queue
from knowledge_base.task import runtime as task_runtime
from knowledge_base.task import wrapper
from knowledge_base.task.wrapper import FileTask
from knowledge_base.task.queue import FileTaskQueue, _FileImportStore


# ----------------------------------------------------------------------
# wrapper.FileTask
# ----------------------------------------------------------------------


def test_file_task_defaults_and_lifecycle():
    task = FileTask(task_id='t1', file_handle={'fileId': 'f' * 40})

    assert len(FileTask.new_task_id()) == 32
    assert task.related_identifier_id == 'f' * 32               # 超长截断
    assert task.can_retry() is True
    assert task.status == 'PENDING'

    task.mark_as_retry()
    assert task.status == 'RETRY' and task.retry_count == 1     # 先自增再重投

    task.mark_as_running()
    assert task.status == 'RUNNING' and task.start_time is not None

    task.mark_as_completed()
    assert task.status == 'COMPLETED' and task.end_time is not None

    failed = FileTask(task_id='t2')
    failed.mark_as_failed('boom')
    assert failed.status == 'FAILED' and failed.error_message == 'boom'


def test_file_task_related_identifier_without_handle():
    assert FileTask(task_id='t').related_identifier_id is None
    assert FileTask(task_id='t', file_handle={}).related_identifier_id is None


def test_file_task_can_retry_boundary():
    task = FileTask(task_id='t', retry_count=3, max_retry_count=3)
    assert task.can_retry() is False


def test_failure_message_renders_null_for_messageless_exception():
    task = FileTask(task_id='t', retry_count=2)

    assert task.failure_message(RuntimeError()) == (
        'Task failed after 2 retries. Error: null')
    assert task.failure_message(RuntimeError('boom')) == (
        'Task failed after 2 retries. Error: boom')


@pytest.mark.parametrize('raw, expected', [
    ('PENDING', 'PENDING'), ('RUNNING', 'RUNNING'), ('RETRY', 'RETRY'),
    ('COMPLETED', 'COMPLETED'), ('FAILED', 'FAILED'),
    ('whatever', 'PENDING'), ('', 'PENDING'), (None, 'PENDING'), (5, 'PENDING'),
])
def test_parse_status_falls_back_to_pending(raw, expected):
    assert wrapper.parse_status(raw) == expected


# ----------------------------------------------------------------------
# queue 门面的小工具
# ----------------------------------------------------------------------


def test_to_millis_truncates_microseconds():
    value = datetime(2024, 1, 1, 12, 30, 59, 123456)

    assert task_queue._to_millis(value) == value.replace(microsecond=123000)
    assert task_queue._to_millis(None) is None


def test_format_failure_message_variants():
    requeue = task_queue.REQUEUE_FAILED_MESSAGE
    assert task_queue._format_failure_message(requeue, 3) == requeue   # 原样透传
    assert task_queue._format_failure_message('boom', 3) == (
        'Task failed after 3 retries. Error: boom')
    assert task_queue._format_failure_message(None, 1) == (
        'Task failed after 1 retries. Error: null')


class _FakeCursor:
    def __init__(self, rows=None, fail=False):
        self.rows = rows or []
        self.fail = fail
        self.description = (('id',), ('payload',), ('attempt',), ('max_attempts',),
                            ('error_message',), ('created_at',), ('start_time',),
                            ('finish_time',), ('updated_at',))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        if self.fail:
            raise RuntimeError('db down')

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class _FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self._cursor


class _FakeEngine:
    def __init__(self):
        self.lanes = []
        self.kinds = []
        self.submitted = []
        self.reject = None
        self.shutdown_flag = False
        self.stats_map = {}

    def register_lane(self, name, **kwargs):
        self.lanes.append((name, kwargs))
        return name

    def register_kind(self, kind, runner, store):
        self.kinds.append((kind, runner, store))

    def submit(self, kind, payload, task_id=None):
        if self.reject is not None:
            raise self.reject
        self.submitted.append((kind, payload, task_id))
        return task_id

    def stats(self):
        return self.stats_map

    @property
    def is_shutdown(self):
        return self.shutdown_flag

    def shutdown(self):
        self.shutdown_flag = True


def _make_queue(engine=None, mode='memory'):
    engine = engine or _FakeEngine()
    return FileTaskQueue(engine=engine, queue_mode=mode), engine


def test_queue_registers_lane_and_kind_with_hooks():
    queue, engine = _make_queue()

    assert engine.lanes[0][0] == 'file_import'
    assert engine.lanes[0][1]['mode'] == 'memory'
    kind, runner, store = engine.kinds[0]
    assert kind.name == 'file_import' and kind.max_attempts == 4
    assert runner is file_runner.run_file_task
    assert isinstance(store, _FileImportStore)


def test_submit_task_creates_task_and_payload_for_memory_mode():
    queue, engine = _make_queue()

    task_id = queue.submit_task({'fileId': 'f1', 'kbaseId': 'kb1'})

    assert len(task_id) == 32
    kind, payload, submitted_id = engine.submitted[0]
    assert kind == 'file_import' and submitted_id == task_id
    assert payload['task'].file_handle == {'fileId': 'f1', 'kbaseId': 'kb1'}
    assert queue.get_task(task_id).related_identifier_id == 'f1'


def test_submit_task_db_mode_payload_carries_file_handle():
    queue, engine = _make_queue(mode='db')

    task_id = queue.submit_task({'fileId': 'f1' * 20, 'kbaseId': 'kb1'})

    _kind, payload, _tid = engine.submitted[0]
    assert payload['fileHandle']['fileId'] == 'f1' * 20
    assert payload['fileId'] == ('f1' * 20)[:32]
    assert queue._tasks[task_id].file_handle['fileId'] == 'f1' * 20


def test_submit_task_rejected_when_full():
    engine = _FakeEngine()
    engine.reject = TaskRejectedError('full')
    queue, _ = _make_queue(engine)

    with pytest.raises(RuntimeError, match='queue is full'):
        queue.submit_task({'fileId': 'f1'})
    assert queue._tasks == {}


def test_submit_task_rejected_after_engine_shutdown():
    engine = _FakeEngine()
    engine.reject = TaskRejectedError('down')
    engine.shutdown_flag = True
    queue, _ = _make_queue(engine)

    with pytest.raises(RuntimeError, match='shutdown'):
        queue.submit_task({'fileId': 'f1'})


def test_submit_task_after_queue_shutdown():
    queue, engine = _make_queue()

    queue.shutdown()

    assert queue.is_shutdown is True
    assert engine.shutdown_flag is True
    with pytest.raises(RuntimeError, match='shutdown'):
        queue.submit_task({'fileId': 'f1'})


def test_statistics_memory_mode_counts_statuses(monkeypatch):
    queue, engine = _make_queue()
    engine.stats_map = {'file_import': type('S', (), {'queued': 3})()}
    for status in ('PENDING', 'RUNNING', 'FAILED', 'RETRY'):
        queue._tasks[status] = FileTask(task_id=status, status=status)

    def _boom():
        raise RuntimeError('db down')

    monkeypatch.setattr(task_queue, 'connection', _boom)

    stats = queue.statistics()

    assert stats == {'pendingCount': 1, 'runningCount': 1, 'completedCount': 0,
                     'failedCount': 1, 'retryCount': 1, 'queueSize': 3,
                     'queueCapacity': 2000, 'shutdown': False}


def test_statistics_db_mode_reads_pg_queue(monkeypatch):
    queue, _ = _make_queue(mode='db')
    monkeypatch.setattr(task_queue.pg_queue, 'count_by_lane',
                        lambda lane: {'PENDING': 2, 'RETRY': 1, 'RUNNING': 3})

    stats = queue.statistics()

    assert stats == {'pendingCount': 2, 'runningCount': 3, 'completedCount': 0,
                     'failedCount': 0, 'retryCount': 1, 'queueSize': 3,
                     'queueCapacity': 2000, 'shutdown': False}


def test_statistics_db_mode_survives_pg_errors(monkeypatch):
    queue, _ = _make_queue(mode='db')

    def boom(lane):
        raise RuntimeError('db down')

    monkeypatch.setattr(task_queue.pg_queue, 'count_by_lane', boom)

    stats = queue.statistics()
    assert stats['pendingCount'] == 0 and stats['queueSize'] == 0


def test_failed_tasks_memory_mode():
    queue, _ = _make_queue()
    queue._tasks['a'] = FileTask(task_id='a', status='FAILED')
    queue._tasks['b'] = FileTask(task_id='b', status='PENDING')

    failed = queue.failed_tasks()

    assert [task.task_id for task in failed] == ['a']


def test_cancel_file_task_updates_directory_row(monkeypatch):
    captured = {}

    class _Dir:
        @staticmethod
        def connection():
            class _C:
                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

                def cursor(self):
                    return self

            return _C()

        @staticmethod
        def update_file_status(cursor, file_id, status, reason=None):
            captured['args'] = (file_id, status, reason)

    import knowledge_base.repository.directory as directory_store
    monkeypatch.setattr(directory_store, 'connection', _Dir.connection)
    monkeypatch.setattr(directory_store, 'update_file_status', _Dir.update_file_status)

    task_queue._cancel_file_task({'payload': {'fileId': 'f1'}})
    assert captured['args'] == ('f1', 2, 'Task cancelled')

    task_queue._cancel_file_task({'payload': {'fileHandle': {'fileId': 'f2'}}})
    assert captured['args'] == ('f2', 2, 'Task cancelled')

    captured.clear()
    task_queue._cancel_file_task({'payload': {}})
    task_queue._cancel_file_task({})
    assert captured == {}                                       # 无 fileId → 不动


def test_retry_file_task_claims_directory_row(monkeypatch):
    claimed = []

    import knowledge_base.repository.directory as directory_store

    class _C:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return self

    monkeypatch.setattr(directory_store, 'connection', lambda: _C())
    monkeypatch.setattr(directory_store, 'claim_file_for_retry',
                        lambda cursor, file_id: claimed.append(file_id))

    task_queue._retry_file_task({'payload': {'fileId': 'f1'}})

    assert claimed == ['f1']


def test_sync_task_projects_engine_record(monkeypatch):
    from infrastructure.tasks import TaskRecord

    queue, _ = _make_queue()
    monkeypatch.setattr(queue, '_persist_task_status', lambda task: None)

    base = dict(task_id='t1', kind='file_import', attempt=1)
    completed = TaskRecord(status='COMPLETED', start_time=None, end_time=None,
                           error_message=None, payload={}, **base)
    task = FileTask(task_id='t1')
    queue._sync_task(task, completed)
    assert task.status == 'COMPLETED' and 't1' not in queue._tasks

    failed = TaskRecord(status='FAILED', start_time=None, end_time=None,
                        error_message='boom', payload={}, **base)
    task = FileTask(task_id='t1')
    queue._sync_task(task, failed)
    assert task.status == 'FAILED'
    assert task.error_message == 'Task failed after 0 retries. Error: boom'
    assert queue._tasks['t1'] is task

    cancelled = TaskRecord(status='CANCELLED', start_time=None, end_time=None,
                           error_message=None, payload={}, **base)
    task = FileTask(task_id='t1')
    queue._sync_task(task, cancelled)
    assert task.status == 'CANCELLED'
    assert task.error_message == 'Task cancelled'

    requeued = TaskRecord(status='FAILED', start_time=None, end_time=None,
                          error_message=task_queue.REQUEUE_FAILED_MESSAGE,
                          payload={}, **base)
    task = FileTask(task_id='t1')
    queue._sync_task(task, requeued)
    assert task.error_message == task_queue.REQUEUE_FAILED_MESSAGE


def test_file_import_store_task_for(monkeypatch):
    queue, _ = _make_queue()
    store = _FileImportStore(queue)

    task = FileTask(task_id='t1', file_handle={'fileId': 'f1'})
    record = type('R', (), {'payload': {'task': task}, 'task_id': 't1'})()
    assert store._task_for(record) is task

    record = type('R', (), {'payload': {}, 'task_id': 't9'})()
    queue._tasks['t9'] = task
    assert store._task_for(record) is task

    queue._tasks.clear()
    rebuilt = store._task_for(type('R', (), {
        'payload': {'fileHandle': {'fileId': 'f2'}}, 'task_id': 't10'})())
    assert rebuilt.file_handle == {'fileId': 'f2'}

    empty = store._task_for(type('R', (), {'payload': {}, 'task_id': 't11'})())
    assert empty.file_handle == {}


def test_file_import_store_on_reject_discards(monkeypatch):
    from infrastructure.tasks import TaskRecord

    queue, _ = _make_queue()
    monkeypatch.setattr(queue, '_delete_task', lambda task_id: None)
    queue._tasks['t1'] = FileTask(task_id='t1')

    _FileImportStore(queue).on_reject(TaskRecord(task_id='t1', kind='file_import',
                                                 payload={}, attempt=1))

    assert 't1' not in queue._tasks


def test_persist_helpers_survive_db_errors(monkeypatch):
    queue, _ = _make_queue()

    def boom():
        raise RuntimeError('db down')

    monkeypatch.setattr(task_queue, 'connection', boom)
    task = FileTask(task_id='t1', file_handle={'fileId': 'f1', 'kbaseId': 'kb1'})

    queue._persist_task(task)                                   # 不抛
    queue._persist_task_status(task)
    queue._delete_task('t1')
    assert queue._count_completed_tasks() == 0
    assert queue._load_failed_tasks_from_db() == []


def test_load_task_from_db_maps_row(monkeypatch):
    queue, _ = _make_queue()
    created = datetime(2024, 5, 1, 8, 0, 0, 123456)
    row = ('t1', 'FAILED', {'fileHandle': {'fileId': 'f1'}}, 3, 4, 'boom',
           created, None, None, created)
    cursor = _FakeCursor(rows=[row])
    monkeypatch.setattr(task_queue, 'connection', lambda: _FakeConn(cursor))

    task = queue._load_task_from_db('t1')

    # 内存模式：恢复出来的任务不重试，max_retry_count=0
    assert task.task_id == 't1' and task.status == 'FAILED'
    assert task.file_handle == {'fileId': 'f1'}
    assert task.retry_count == 0 and task.max_retry_count == 0
    assert task.create_time == created.replace(microsecond=123000)
    assert task.end_time == created.replace(microsecond=123000)   # 终态取 updated_at（截毫秒）


def test_load_task_from_db_db_mode_maps_attempt_and_message(monkeypatch):
    queue, _ = _make_queue(mode='db')
    row = ('t1', 'FAILED', {'fileHandle': {'fileId': 'f1'}}, 3, 4, 'boom',
           datetime(2024, 5, 1), None, None, datetime(2024, 5, 1))
    monkeypatch.setattr(task_queue, 'connection',
                        lambda: _FakeConn(_FakeCursor(rows=[row])))

    task = queue._load_task_from_db('t1')

    assert task.retry_count == 2 and task.max_retry_count == 3
    assert task.error_message == 'Task failed after 2 retries. Error: boom'



def test_load_task_from_db_recovers_only_file_id(monkeypatch):
    queue, _ = _make_queue()
    row = ('t1', 'COMPLETED', {'fileId': 'f1'}, 1, 1, None,
           datetime(2024, 5, 1), None, None, datetime(2024, 5, 1, 9))
    monkeypatch.setattr(task_queue, 'connection',
                        lambda: _FakeConn(_FakeCursor(rows=[row])))

    task = queue._load_task_from_db('t1')

    assert task.file_handle == {'fileId': 'f1'}                 # fileName 恢复不出来
    assert task.max_retry_count == 0                            # 恢复出来的任务不重试
    assert task.end_time == datetime(2024, 5, 1, 9)


def test_load_failed_tasks_from_db(monkeypatch):
    queue, _ = _make_queue()
    row = ('t1', {'fileId': 'f1'}, 2, 4, 'boom',
           datetime(2024, 5, 1), None, None, datetime(2024, 5, 1, 9))
    monkeypatch.setattr(task_queue, 'connection',
                        lambda: _FakeConn(_FakeCursor(rows=[row])))

    failed = queue._load_failed_tasks_from_db()

    assert len(failed) == 1
    assert failed[0].retry_count == 1
    assert failed[0].error_message == 'Task failed after 1 retries. Error: boom'


# ----------------------------------------------------------------------
# runtime 单例
# ----------------------------------------------------------------------


def test_runtime_start_get_queue_and_shutdown(monkeypatch):
    created = []

    class _StubQueue:
        def __init__(self, **kwargs):
            created.append(kwargs)
            self.shutdown_called = False

        def start(self):
            pass

        def shutdown(self):
            self.shutdown_called = True

    monkeypatch.setattr(task_runtime, 'FileTaskQueue', _StubQueue)
    monkeypatch.setattr(task_runtime, '_queue', None)
    monkeypatch.setenv('RKB_TASK_QUEUE_DB', '0')

    queue = task_runtime.start()
    assert task_runtime.get_queue() is queue                    # 幂等
    assert created == [{'queue_mode': 'memory'}]

    task_runtime.shutdown()
    task_runtime.shutdown()                                     # 重复调用安全
    assert queue.shutdown_called is True
    assert task_runtime._queue is None


def test_runtime_start_uses_db_mode_when_enabled(monkeypatch):
    created = []

    class _StubQueue:
        def __init__(self, **kwargs):
            created.append(kwargs)

        def start(self):
            created.append('started')

        def shutdown(self):
            pass

    monkeypatch.setattr(task_runtime, 'FileTaskQueue', _StubQueue)
    monkeypatch.setattr(task_runtime, '_queue', None)
    monkeypatch.setenv('RKB_TASK_QUEUE_DB', '1')

    task_runtime.start()

    assert created == [{'queue_mode': 'db'}, 'started']
    task_runtime.shutdown()


def test_default_queue_uses_runtime(monkeypatch):
    from knowledge_base.service import file_service

    stub = object()
    monkeypatch.setattr(task_runtime, '_queue', stub)
    assert file_service._default_queue() is stub


# ----------------------------------------------------------------------
# executor 与 chain
# ----------------------------------------------------------------------


class _StubHandler:
    def __init__(self, name, fail=False):
        self.name = name
        self.fail = fail
        self.handled = []
        self.rolled_back = []

    def handle(self, file_handle):
        self.handled.append(file_handle.get('fileId'))
        if self.fail:
            raise RuntimeError(f'{self.name} failed')

    def rollback(self, file_handle):
        self.rolled_back.append(file_handle.get('fileId'))


def test_chain_executes_in_order():
    first, second = _StubHandler('a'), _StubHandler('b')
    chain = task_chain.FileHandlerChain()
    chain.add_handler(first).add_handler(second)

    chain.execute({'fileId': 'f1'})

    assert first.handled == ['f1'] and second.handled == ['f1']


def test_chain_rolls_back_from_failed_handler_inclusive():
    first = _StubHandler('a')
    second = _StubHandler('b', fail=True)
    third = _StubHandler('c')
    chain = task_chain.FileHandlerChain()
    chain.add_handler(first).add_handler(second).add_handler(third)

    with pytest.raises(RuntimeError):
        chain.execute({'fileId': 'f1'})

    assert second.rolled_back == ['f1']                         # 含失败者自己
    assert first.rolled_back == ['f1']
    assert third.handled == [] and third.rolled_back == []      # 后面的不执行


def test_chain_rollback_errors_do_not_mask_original(monkeypatch):
    first = _StubHandler('a')

    class _BrokenRollback(_StubHandler):
        def rollback(self, file_handle):
            raise RuntimeError('rollback failed')

    second = _BrokenRollback('b', fail=True)
    chain = task_chain.FileHandlerChain()
    chain.add_handler(first).add_handler(second)

    with pytest.raises(RuntimeError, match='b failed'):
        chain.execute({'fileId': 'f1'})


def test_chain_checks_cancellation_before_each_handler(monkeypatch):
    calls = []

    def raise_second_time():
        calls.append(1)
        if len(calls) > 1:
            from infrastructure.tasks.cancellation import TaskCancelled
            raise TaskCancelled('cancelled')

    monkeypatch.setattr(task_chain.cancellation, 'raise_if_cancelled', raise_second_time)

    first, second = _StubHandler('a'), _StubHandler('b')
    chain = task_chain.FileHandlerChain()
    chain.add_handler(first).add_handler(second)

    with pytest.raises(Exception):
        chain.execute({'fileId': 'f1'})

    assert second.handled == []


def test_retry_delay_only_for_busy_large_file_gate():
    from shared.errors.api import KbApiError

    assert file_runner.retry_delay(KbApiError('RetCode.file.size.more')) == 5.0
    assert file_runner.retry_delay(KbApiError('RetCode.operator.split.error')) == 0.0
    assert file_runner.retry_delay(RuntimeError('x')) == 0.0


def test_process_file_empty_handle_is_noop(monkeypatch):
    executed = []

    class _Chain:
        def add_handler(self, handler):
            return self

        def execute(self, handle):
            executed.append(handle)

    monkeypatch.setattr(file_runner, 'FileHandlerChain', _Chain)

    file_runner.process_file(None)
    file_runner.process_file({})

    assert executed == []


def test_process_file_success_marks_status_one(monkeypatch):
    import knowledge_base.repository.directory as directory_store
    from knowledge_base.task import handlers as handlers_module

    calls = []

    class _C:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return self

    monkeypatch.setattr(directory_store, 'connection', lambda: _C())
    monkeypatch.setattr(directory_store, 'update_file_status',
                        lambda cursor, file_id, status, reason=None:
                        calls.append((file_id, status)))

    class _OkHandler:
        def handle(self, file_handle):
            calls.append(('handled', file_handle['fileId']))

        def rollback(self, file_handle):
            pass

    monkeypatch.setattr(file_runner, 'FileParseHandler', lambda: _OkHandler())
    monkeypatch.setattr(file_runner, 'FileSplitHandler', lambda: _OkHandler())
    monkeypatch.setattr(file_runner, 'FileEmbeddingHandler', lambda: _OkHandler())
    cleaned = []
    monkeypatch.setattr(file_runner.storage, 'cleanup_task_files',
                        lambda handle: cleaned.append(handle))

    handle = {'fileId': 'f1'}
    file_runner.process_file(handle)

    assert ('handled', 'f1') in calls and ('f1', 1) in calls
    assert cleaned == [handle]


def test_process_file_failure_skips_status_one_but_cleans(monkeypatch):
    import knowledge_base.repository.directory as directory_store

    calls = []

    class _C:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def cursor(self):
            return self

    monkeypatch.setattr(directory_store, 'connection', lambda: _C())
    monkeypatch.setattr(directory_store, 'update_file_status',
                        lambda cursor, file_id, status, reason=None:
                        calls.append((file_id, status)))

    class _BadHandler:
        def handle(self, file_handle):
            raise RuntimeError('split failed')

        def rollback(self, file_handle):
            pass

    monkeypatch.setattr(file_runner, 'FileParseHandler', lambda: _BadHandler())
    monkeypatch.setattr(file_runner, 'FileSplitHandler', lambda: _BadHandler())
    monkeypatch.setattr(file_runner, 'FileEmbeddingHandler', lambda: _BadHandler())
    monkeypatch.setattr(file_runner.storage, 'cleanup_task_files', lambda handle: None)

    with pytest.raises(RuntimeError):
        file_runner.process_file({'fileId': 'f1'})

    assert calls == []                                          # 失败不写 1


def test_run_file_task_requires_handle(monkeypatch):
    executed = []
    monkeypatch.setattr(file_runner, 'process_file', lambda handle: executed.append(handle))

    record = type('R', (), {'payload': {'task': type('T', (), {
        'file_handle': {'fileId': 'f1'}})()}})()
    monkeypatch.setattr(file_runner.kbase_store, 'set_kbase_status_modified',
                        lambda kbase_id: None)

    file_runner.run_file_task(record, None)
    assert executed == [{'fileId': 'f1'}]

    db_record = type('R', (), {'payload': {'fileHandle': {'fileId': 'f2'}}})()
    file_runner.run_file_task(db_record, None)
    assert executed[-1] == {'fileId': 'f2'}

    with pytest.raises(RuntimeError, match='no handle'):
        file_runner.run_file_task(type('R', (), {'payload': {}})(), None)


# ----------------------------------------------------------------------
# operator_runtime 错误通道
# ----------------------------------------------------------------------


def test_envelope_of_sensitive_message_exception():
    from parsing.exception import SensitiveMsgException

    error = SensitiveMsgException('SENSITIVE_ERROR_CODE', {},
                                  {'zh_CN': '命中敏感词'})
    code, message = operator_runtime._envelope_of(error)

    assert code == 'SENSITIVE_ERROR_CODE'
    assert message == '命中敏感词'                              # 语言固定 zh_CN


def test_envelope_of_code_bo_message_exception():
    class _Err(Exception):
        code = 'E1'
        bo = {}
        message = '正文为空'

    assert operator_runtime._envelope_of(_Err()) == ('E1', '正文为空')


def test_envelope_of_plain_exception_uses_first_arg():
    assert operator_runtime._envelope_of(ValueError('plain')) == ('0001', 'plain')
    assert operator_runtime._envelope_of(ValueError()) == ('0001', '')


def test_invoke_maps_known_messages(monkeypatch):
    def boom():
        raise ValueError('RetCode.file.size.more')

    monkeypatch.setattr(operator_runtime, '_runtime',
                        lambda: (_ for _ in ()).throw(ZeroDivisionError))

    with pytest.raises(Exception) as caught:
        operator_runtime._invoke(boom, fallback_key='RetCode.operator.split.error')

    from shared.errors.api import KbApiError
    assert isinstance(caught.value, KbApiError)
    assert caught.value.key == 'RetCode.file.size.more'
    assert caught.value.code == '0001'


def test_invoke_uses_fallback_for_unknown_messages(monkeypatch):
    def boom():
        raise ValueError('whatever')

    with pytest.raises(Exception) as caught:
        operator_runtime._invoke(boom, fallback_key='RetCode.operator.split.error')

    assert caught.value.key == 'RetCode.operator.split.error'


def test_invoke_passes_kb_api_error_through():
    from shared.errors.api import KbApiError

    def boom():
        raise KbApiError('kbase.not.exist')

    with pytest.raises(KbApiError):
        operator_runtime._invoke(boom, fallback_key='RetCode.file.parse.error')


def test_file_parse_and_text_split_delegate_to_runtime(monkeypatch):
    seen = {}

    class _Runtime:
        @staticmethod
        def file_parse(payload):
            seen['parse'] = payload
            return '/tmp/clean.md'

        @staticmethod
        def text_split(payload):
            seen['split'] = payload
            return {'results': [], 'chunks': []}

        @staticmethod
        def graph_extract(payload, lang):
            seen['graph'] = (payload, lang)
            return {'code': '0'}

    monkeypatch.setattr(operator_runtime, '_runtime', lambda: _Runtime())

    assert operator_runtime.file_parse(1, [], '/p.py', 'md', None, '/tmp/a.md') == \
        '/tmp/clean.md'
    assert seen['parse']['operatorId'] == 1 and seen['parse']['fileFormat'] == 'md'

    result = operator_runtime.text_split(-1, [], None, 'md', '/tmp/c.md', 'a.md', 10, 'kb')
    assert result == {'results': [], 'chunks': []}
    assert seen['split']['splitPreview'] is None                # 上传链不设预览
    assert seen['split']['kbaseId'] == 'kb'

    operator_runtime.graph_extract(1, [], None, 'md', 'kb1', '/tmp/a.md', None, {})
    assert seen['graph'][1] == 'zh_CN'                          # 语言写死


# ----------------------------------------------------------------------
# file_task_service 的纯函数
# ----------------------------------------------------------------------


def test_iso_local_datetime_shapes():
    from knowledge_base.service.file_task_service import iso_local_datetime

    assert iso_local_datetime(None) is None
    assert iso_local_datetime(datetime(2024, 5, 1, 8, 0, 0)) == '2024-05-01T08:00:00'
    assert iso_local_datetime(datetime(2024, 5, 1, 8, 0, 0, 324000)) == \
        '2024-05-01T08:00:00.324'
    # 尾随零按需最少位数
    assert iso_local_datetime(datetime(2024, 5, 1, 8, 0, 0, 500000)) == \
        '2024-05-01T08:00:00.5'


def test_build_task_info_full_fields_and_duration():
    from knowledge_base.service.file_task_service import build_task_info

    task = FileTask(task_id='t1', file_handle={'fileId': 'f1', 'fileName': 'a.md'},
                    status='RETRY', retry_count=1, max_retry_count=3)
    task.start_time = datetime(2024, 5, 1, 8, 0, 0)
    task.end_time = task.start_time + timedelta(milliseconds=1500)

    info = build_task_info(task)

    assert info['taskId'] == 't1' and info['fileId'] == 'f1'
    assert info['fileName'] == 'a.md'
    assert info['statusDescription'] == '重试中'
    assert info['durationMillis'] == 1500
    assert info['durationSeconds'] == 1.5

    no_duration = build_task_info(FileTask(task_id='t2'))
    assert 'durationMillis' not in no_duration                 # 键不出现


def test_error_text_and_is_terminal():
    from knowledge_base.service.file_task_service import error_text, is_terminal

    assert error_text(RuntimeError('boom')) == 'boom'
    assert error_text(RuntimeError()) is None
    assert is_terminal(FileTask(task_id='t', status='COMPLETED')) is True
    assert is_terminal(FileTask(task_id='t', status='RETRY')) is False
