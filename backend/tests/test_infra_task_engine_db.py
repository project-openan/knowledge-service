"""任务引擎 DB 队列模式：认领 → 执行 → 续租/重试/取消/失败 的完整进程内闭环。

``pg_queue`` 全部换成桩（见 ``FakePg``），引擎的 SQL 不落库；线程行为用事件等待。
"""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

import pytest

from infrastructure.tasks import cancellation, pg_queue, registry
from infrastructure.tasks.engine import TaskEngine, _error_text
from infrastructure.tasks.types import (
    REQUEUE_FAILED_MESSAGE,
    STATUS_CANCELLED,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_RETRY,
    STATUS_RUNNING,
    TaskKind,
    TaskRecord,
    TaskRejectedError,
)


class FakePg:
    """pg_queue 的桩：认领行按队列给出，其余函数记录调用并按脚本返回。"""

    def __init__(self):
        self.claim_rows = []
        self.claim_lock = threading.Lock()
        self.calls = {}
        self.scripts = {}          # 函数名 → 返回值队列（弹完用最后一位）

    def record(self, name, *args):
        self.calls.setdefault(name, []).append(args)

    def set(self, name, values):
        self.scripts[name] = list(values)

    def next(self, name, default):
        values = self.scripts.get(name)
        if not values:
            return default
        value = values.pop(0) if len(values) > 1 else values[0]
        if isinstance(value, BaseException):
            raise value
        return value

    # ---- 各桩函数（monkeypatch 到 pg_queue 模块上） ----

    def notify(self, lane):
        self.record('notify', lane)
        self.next('notify', None)

    def notify_cancel(self, task_id):
        self.record('notify_cancel', task_id)
        self.next('notify_cancel', None)

    def pending_count(self, lane):
        return self.next('pending_count', 0)

    def count_by_lane(self, lane):
        return self.next('count_by_lane', {})

    def claim(self, lane, task_types, worker_id, lease_seconds=60):
        self.record('claim', lane, tuple(task_types), worker_id, lease_seconds)
        with self.claim_lock:
            if self.claim_rows:
                return self.claim_rows.pop(0)
        return None

    def heartbeat(self, task_id, worker_id, lease_seconds=60):
        self.record('heartbeat', task_id, worker_id)
        return self.next('heartbeat', True)

    def complete(self, task_id, worker_id, progress=100):
        self.record('complete', task_id, worker_id)
        return self.next('complete', True)

    def release(self, task_id, worker_id):
        self.record('release', task_id, worker_id)
        return self.next('release', True)

    def reschedule(self, task_id, worker_id, attempt, delay, message):
        self.record('reschedule', task_id, attempt, delay, message)
        return self.next('reschedule', True)

    def fail(self, task_id, worker_id, message):
        self.record('fail', task_id, worker_id, message)
        return self.next('fail', True)

    def cancel_running(self, task_id, worker_id, reason='Cancelled by user'):
        self.record('cancel_running', task_id, worker_id, reason)
        return self.next('cancel_running', True)

    def cancel_requested_ids(self, task_ids):
        self.record('cancel_requested_ids', tuple(task_ids))
        return self.next('cancel_requested_ids', [])

    def reclaim_expired(self):
        self.record('reclaim_expired')
        return self.next('reclaim_expired', [])

    def listen_connection(self):
        self.record('listen_connection')
        raise self.next('listen_connection_error', None) or RuntimeError('no db')

    def task_status(self, task_id):
        return None


def _claimed_row(task_id='t1', task_type='work', lane='db_lane',
                 attempt=1, status='RUNNING'):
    return {
        'id': task_id, 'task_type': task_type, 'lane': lane, 'status': status,
        'attempt': attempt, 'payload': {'kbase_id': 'graph_kb3'}, 'extra': None,
        'created_at': None, 'start_time': None, 'finish_time': None,
        'error_message': None, 'available_at': None, 'locked_by': 'worker-1',
        'locked_until': None, 'heartbeat_at': None,
    }


class RecordingStore:
    def __init__(self):
        self.events = []
        self._lock = threading.Lock()

    def on_submit(self, record):
        with self._lock:
            self.events.append(('submit', record.status))

    def on_change(self, record):
        with self._lock:
            self.events.append(('change', record.status))

    def load(self, task_id):
        return None

    def statuses(self):
        with self._lock:
            return [event[1] for event in self.events]


@pytest.fixture(autouse=True)
def _cleanup_engines(monkeypatch):
    """兜底关停本用例创建的所有引擎：断言失败也不能留下非 daemon 的 worker 线程。"""
    engines = []
    original_init = TaskEngine.__init__

    def patched_init(self):
        original_init(self)
        engines.append(self)

    monkeypatch.setattr(TaskEngine, '__init__', patched_init)
    yield
    for engine in engines:
        try:
            engine.shutdown()
        except Exception:                              # noqa: BLE001
            pass


@pytest.fixture()
def fake_pg(monkeypatch):
    fake = FakePg()
    for name in ('notify', 'notify_cancel', 'pending_count', 'count_by_lane',
                 'claim', 'heartbeat', 'complete', 'release', 'reschedule',
                 'fail', 'cancel_running', 'cancel_requested_ids',
                 'reclaim_expired', 'listen_connection', 'task_status'):
        monkeypatch.setattr(pg_queue, name, getattr(fake, name))
    return fake


def wait_until(predicate, timeout=3.0, interval=0.005):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError('condition not met within %.1fs' % timeout)


def test_error_text_uses_null_for_empty_message():
    assert _error_text(RuntimeError('boom')) == 'boom'
    assert _error_text(RuntimeError()) == 'null'


def test_register_lane_and_kind_validation_errors():
    engine = TaskEngine()
    with pytest.raises(ValueError):
        engine.register_lane('x', mode='redis')
    engine.register_lane('lane', mode='memory')
    with pytest.raises(ValueError):
        engine.register_lane('lane', mode='memory')
    with pytest.raises(ValueError):
        engine.register_kind(TaskKind(name='k', lane='missing'),
                             lambda record, ctx: None)
    engine.register_kind(TaskKind(name='k', lane='lane'), lambda record, ctx: None)
    with pytest.raises(ValueError):
        engine.register_kind(TaskKind(name='k', lane='lane'), lambda record, ctx: None)
    with pytest.raises(ValueError):
        engine.register_kind(TaskKind(name='k2', lane='lane', queue_mode='db'),
                             lambda record, ctx: None)
    engine.shutdown()


def test_submit_db_mode_notifies_wakes_and_starts(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()
    engine.register_lane('db_lane', mode='db', capacity=5, poll_seconds=0.02)
    engine.register_kind(
        TaskKind(name='work', lane='db_lane', queue_mode='db',
                 persist_type='TEST_TASK', lease_seconds=90),
        lambda record, ctx: None, store)

    task_id = engine.submit('work', {'fileId': 'f1'}, task_id='fixed-id')

    assert task_id == 'fixed-id'
    assert store.statuses() == ['PENDING']
    assert fake_pg.calls['notify'] == [('db_lane',)]
    wait_until(lambda: bool(fake_pg.calls.get('claim')))
    engine.shutdown()


def test_submit_db_mode_after_shutdown_rejects_and_notifies_store(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()
    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         lambda record, ctx: None, store)
    engine.shutdown()

    with pytest.raises(TaskRejectedError):
        engine.submit('work')

    assert store.statuses() == ['PENDING']
    assert 'notify' not in fake_pg.calls


def test_submit_db_mode_capacity_check_runs_before_row_creation(fake_pg):
    engine = TaskEngine()
    engine.register_lane('db_lane', mode='db', capacity=2, poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         lambda record, ctx: None)
    fake_pg.set('pending_count', [2])
    with pytest.raises(TaskRejectedError):
        engine.submit('work')
    engine.shutdown()


def test_durable_claim_maps_row_to_record(fake_pg):
    engine = TaskEngine()
    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db',
                                  persist_type='TEST_TASK'),
                         lambda record, ctx: None)
    engine.start()
    wait_until(lambda: bool(fake_pg.calls.get('claim')))

    claim = engine._make_claim('db_lane')
    record = claim('worker-9')

    assert record is None                          # 没有可认领行
    fake_pg.claim_rows.append(_claimed_row())
    record = claim('worker-9')
    assert record.task_id == 't1'
    assert record.kind == 'work'                   # persist_type 反查 kind 名
    assert record.status == STATUS_RUNNING
    assert record.locked_by == 'worker-1'
    assert record.extra == {}
    engine.shutdown()


def test_durable_execution_completes_and_counts(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()
    done = threading.Event()

    def runner(record, ctx):
        assert record.status == STATUS_RUNNING
        assert ctx.is_cancelled() is False
        done.set()

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db',
                                  persist_type='TEST_TASK', retain_completed=True),
                         runner, store)
    fake_pg.claim_rows.append(_claimed_row(task_type='TEST_TASK'))

    engine.submit('work', create_row=False)
    assert done.wait(3.0)
    wait_until(lambda: store.statuses() and store.statuses()[-1] == STATUS_COMPLETED)
    assert fake_pg.calls['complete'][0][:2] == ('t1', 'worker-1')
    assert engine._counters['db_lane']['completed'] == 1
    engine.shutdown()


def test_durable_runner_owned_status_only_releases_lease(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()
    done = threading.Event()

    def runner(record, ctx):
        record.status = STATUS_COMPLETED           # 领域 runner 自己写终态
        done.set()

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db',
                                  status_owner='runner'),
                         runner, store)
    fake_pg.claim_rows.append(_claimed_row())
    engine.submit('work', create_row=False)

    assert done.wait(3.0)
    wait_until(lambda: 'release' in fake_pg.calls)
    assert 'complete' not in fake_pg.calls
    engine.shutdown()


def test_durable_failure_reschedules_then_fails(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()
    attempts = []

    def runner(record, ctx):
        attempts.append(record.attempt)
        raise RuntimeError('boom')

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db',
                                  max_attempts=2,
                                  retry_delay=lambda _error: 3.0),
                         runner, store)
    fake_pg.claim_rows.append(_claimed_row(attempt=1))
    fake_pg.claim_rows.append(_claimed_row(attempt=2))

    engine.submit('work', create_row=False)
    wait_until(lambda: store.statuses() and store.statuses()[-1] == STATUS_FAILED)

    assert attempts == [1, 2]
    assert fake_pg.calls['reschedule'][0][:4] == ('t1', 2, 3.0, 'boom')
    assert fake_pg.calls['fail'][0][2] == 'boom'
    engine.shutdown()


def test_durable_final_failure_with_empty_message_uses_null(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()

    def runner(record, ctx):
        raise RuntimeError()

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         runner, store)
    fake_pg.claim_rows.append(_claimed_row(attempt=1))
    engine.submit('work', create_row=False)

    wait_until(lambda: 'fail' in fake_pg.calls)
    assert fake_pg.calls['fail'][0][2] == 'null'
    engine.shutdown()


def test_durable_lease_lost_on_complete_and_fail_is_swallowed(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()
    first = threading.Event()

    def runner(record, ctx):
        if not first.is_set():
            first.set()
            return                              # 成功 → complete 返回 False
        raise RuntimeError('second')

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         runner, store)
    fake_pg.set('complete', [False])
    fake_pg.set('fail', [False])
    fake_pg.claim_rows.append(_claimed_row())
    fake_pg.claim_rows.append(_claimed_row())

    engine.submit('work', create_row=False)
    wait_until(lambda: len(fake_pg.calls.get('fail', [])) == 1)
    assert store.statuses() == []                    # 租约丢了，终态不落 store
    engine.shutdown()


def test_durable_runner_raising_with_runner_owner_releases_lease(fake_pg):
    """status_owner=runner 且 runner 抛错：引擎只释放租约，不覆盖领域状态。"""
    engine = TaskEngine()
    store = RecordingStore()
    ran = threading.Event()

    def runner(record, ctx):
        ran.set()
        raise RuntimeError('domain already wrote FAILED')

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db',
                                  status_owner='runner'),
                         runner, store)
    fake_pg.claim_rows.append(_claimed_row())
    engine.submit('work', create_row=False)

    assert ran.wait(3.0)
    wait_until(lambda: 'release' in fake_pg.calls)
    assert 'fail' not in fake_pg.calls and 'reschedule' not in fake_pg.calls
    engine.shutdown()


def test_durable_reschedule_losing_lease_skips_retry_state(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()

    def runner(record, ctx):
        raise RuntimeError('boom')

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db',
                                  max_attempts=2),
                         runner, store)
    fake_pg.set('reschedule', [False])
    fake_pg.claim_rows.append(_claimed_row())
    engine.submit('work', create_row=False)

    wait_until(lambda: fake_pg.calls.get('reschedule'))
    engine.shutdown()
    assert STATUS_RETRY not in store.statuses()


def test_durable_cancelled_by_runner_runs_cancel_hook_with_graph_prefix(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()
    hook_rows = []
    registry.register_cancel_hook('TEST_TASK',
                                  lambda row: hook_rows.append(row))
    started = threading.Event()

    def runner(record, ctx):
        started.set()
        assert ctx.is_cancelled() is False
        ctx.raise_if_cancelled()                  # 未取消时正常返回
        raise cancellation.TaskCancelled('user asked')

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db',
                                  persist_type='TEST_TASK'),
                         runner, store)
    try:
        fake_pg.claim_rows.append(_claimed_row(task_type='TEST_TASK'))
        # payload.kbase_id = graph_kb3
        engine.submit('work', create_row=False)

        assert started.wait(3.0)
        wait_until(lambda: 'cancel_running' in fake_pg.calls)
        wait_until(lambda: store.statuses() and store.statuses()[-1] == STATUS_CANCELLED)
        assert hook_rows and hook_rows[0]['kbase_id'] == 'kb3'   # graph_ 前缀剥掉
    finally:
        registry.unregister_cancel_hook('TEST_TASK')
        engine.shutdown()


def test_durable_cancel_losing_lease_and_hook_failure_are_swallowed(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()

    def broken_hook(row):
        raise RuntimeError('hook failed')

    registry.register_cancel_hook('TEST_TASK', broken_hook)
    ran = threading.Event()

    def runner(record, ctx):
        ran.set()
        raise cancellation.TaskCancelled()

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db',
                                  persist_type='TEST_TASK'),
                         runner, store)
    try:
        fake_pg.set('cancel_running', [False])
        fake_pg.claim_rows.append(_claimed_row(task_type='TEST_TASK'))
        engine.submit('work', create_row=False)
        assert ran.wait(3.0)
        wait_until(lambda: fake_pg.calls.get('cancel_running'))
        engine.shutdown()
        assert STATUS_CANCELLED not in store.statuses()
    finally:
        registry.unregister_cancel_hook('TEST_TASK')


def test_cancel_hook_extracts_kbase_id_from_dto_and_index_name():
    seen = []
    registry.register_cancel_hook('TEST_TASK', lambda row: seen.append(row['kbase_id']))
    try:
        kind = TaskKind(name='work', lane='lane', persist_type='TEST_TASK')
        record = TaskRecord(task_id='t9', kind='work',
                            payload={'dto': {'kbId': 'kb-7'}})
        TaskEngine._run_cancel_hook(kind, record)
        record2 = TaskRecord(task_id='t8', kind='work',
                             payload={'kbIndexName': 'graph_kb-8'})
        TaskEngine._run_cancel_hook(kind, record2)
        assert seen == ['kb-7', 'kb-8']
    finally:
        registry.unregister_cancel_hook('TEST_TASK')


def test_stats_db_mode_reads_pg_counts(fake_pg):
    engine = TaskEngine()
    engine.register_lane('db_lane', mode='db', capacity=3)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         lambda record, ctx: None)
    fake_pg.set('count_by_lane', [{'PENDING': 2, 'RETRY': 1, 'RUNNING': 1}])

    stats = engine.stats()['db_lane']

    assert stats.queued == 3 and stats.pending == 3
    assert stats.running == 1 and stats.retry == 1
    assert stats.delayed == 0

    fake_pg.set('count_by_lane', [RuntimeError('pg down')])
    stats = engine.stats()['db_lane']
    assert stats.queued == 0                        # 查库抖动按空计数兜底
    engine.shutdown()


def test_stats_memory_mode_counts_delayed_and_requeue(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()
    release = threading.Event()

    def runner(record, ctx):
        raise RuntimeError('retry me')

    engine.register_lane('mem', workers=1, capacity=1)
    engine.register_kind(TaskKind(name='work', lane='mem', max_attempts=2,
                                  retry_delay=lambda _error: 30.0),
                         runner, store)
    engine.submit('work')
    wait_until(lambda: engine.stats()['mem'].delayed == 1)

    stats = engine.stats()['mem']
    assert stats.pending == 1                      # queued 0 + delayed 1
    engine.shutdown()                              # 堆里的遗留任务 → FAILED
    assert store.statuses()[-1] == STATUS_FAILED


def test_requeue_delayed_paths(fake_pg):
    engine = TaskEngine()
    engine.register_lane('mem', workers=1, capacity=1)
    record = TaskRecord(task_id='x', kind='missing')

    engine._requeue_delayed('missing_lane', record)      # 车道不存在 → 直接判失败
    assert record.status == STATUS_FAILED
    assert record.error_message == 'Task engine is shutdown'

    engine.shutdown()
    record2 = TaskRecord(task_id='y', kind='missing')
    engine._requeue_delayed('mem', record2)              # 引擎已关停 → 同上
    assert record2.status == STATUS_FAILED


def test_handle_failure_full_lane_marks_requeue_failed(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()
    engine.register_lane('mem', workers=1, capacity=0)
    engine.register_kind(TaskKind(name='work', lane='mem', max_attempts=2),
                         lambda record, ctx: None, store)
    lane = engine._lanes['mem']
    lane.shutdown()                                       # 车道收了 → 重投必失败

    registration = engine._kinds['work']
    record = TaskRecord(task_id='z', kind='work', attempt=1)
    engine._handle_failure(registration, record, RuntimeError('boom'))

    assert record.status == STATUS_FAILED
    assert record.error_message == REQUEUE_FAILED_MESSAGE
    assert store.statuses()[-1] == STATUS_FAILED
    engine.shutdown()


def test_store_callback_failure_is_logged_not_raised(fake_pg):
    engine = TaskEngine()
    store = RecordingStore()

    def broken_on_submit(record):
        raise RuntimeError('sink down')

    store.on_submit = broken_on_submit
    done = threading.Event()
    engine.register_lane('mem', workers=1)
    engine.register_kind(TaskKind(name='work', lane='mem', retain_completed=True),
                         lambda record, ctx: done.set(), store)
    engine.submit('work')
    assert done.wait(3.0)
    engine.shutdown()


def test_heartbeat_loop_renews_leases_and_polls_cancels(fake_pg):
    engine = TaskEngine()
    cancel_event = threading.Event()
    with engine._lock:
        engine._in_flight['t1'] = ('worker-1', 30)
        engine._cancel_events['t1'] = cancel_event
    fake_pg.set('cancel_requested_ids', [['t1']])
    thread = threading.Thread(target=engine._heartbeat_loop, args=(0.01,),
                              name='hb-test', daemon=True)
    thread.start()

    wait_until(lambda: bool(fake_pg.calls.get('heartbeat')))
    assert fake_pg.calls['heartbeat'][0][:2] == ('t1', 'worker-1')
    wait_until(lambda: cancel_event.is_set())        # 心跳兜底轮询取消标记
    engine._heartbeat_stop.set()
    thread.join(2.0)


def test_poll_cancel_requests_swallows_query_errors(fake_pg):
    engine = TaskEngine()

    assert engine._poll_cancel_requests() is None    # 没有在跑任务 → 不查库

    with engine._lock:
        engine._in_flight['t1'] = ('worker-1', 30)

    def broken(task_ids):
        raise RuntimeError('pg down')

    fake_pg.cancel_requested_ids = broken
    assert engine._poll_cancel_requests() is None
    engine._request_cancel('t1')


def test_heartbeat_failure_is_logged(fake_pg, caplog):
    import logging
    engine = TaskEngine()
    with engine._lock:
        engine._in_flight['t1'] = ('worker-1', 30)
    fake_pg.set('heartbeat', [RuntimeError('pg down')])
    thread = threading.Thread(target=engine._heartbeat_loop, args=(0.01,),
                              daemon=True)
    thread.start()
    with caplog.at_level(logging.WARNING):
        wait_until(lambda: 'heartbeat failed' in caplog.text)
    engine._heartbeat_stop.set()
    thread.join(2.0)


def test_reclaim_loop_logs_reclaimed_rows(fake_pg):
    engine = TaskEngine()
    fake_pg.set('reclaim_expired', [[{'id': 't1'}]])
    thread = threading.Thread(target=engine._reclaim_loop, args=(0.01,),
                              daemon=True)
    thread.start()
    wait_until(lambda: bool(fake_pg.calls.get('reclaim_expired')))

    fake_pg.set('reclaim_expired', [RuntimeError('pg down')])
    wait_until(lambda: len(fake_pg.calls.get('reclaim_expired', [])) >= 2)
    engine._heartbeat_stop.set()
    thread.join(2.0)


def test_listen_loop_dispatches_notify_payloads(monkeypatch, fake_pg):
    from infrastructure.tasks import pg_queue as pg_module

    engine = TaskEngine()
    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_lane('other', mode='db', poll_seconds=0.02)

    cancel_note = SimpleNamespace(channel=pg_module.CANCEL_NOTIFY_CHANNEL,
                                  payload='task-1')
    wake_note = SimpleNamespace(channel=pg_module.NOTIFY_CHANNEL,
                                payload='db_lane')
    all_note = SimpleNamespace(channel=pg_module.NOTIFY_CHANNEL, payload=None)
    unknown_note = SimpleNamespace(channel=pg_module.NOTIFY_CHANNEL,
                                   payload='nobody')

    class FakeListenConn:
        def __init__(self):
            self.notifies = [cancel_note, wake_note, all_note, unknown_note]
            self.closed = False

        def poll(self):
            if not self.notifies:
                engine._listener_stop.set()       # 处理完就退出监听线程

        def close(self):
            self.closed = True

    conn = FakeListenConn()
    monkeypatch.setattr(pg_queue, 'listen_connection', lambda: conn)

    import select as select_module
    results = [([conn], [], []), ([], [], []), ([conn], [], [])]

    def fake_select(*args):
        return results.pop(0) if results else ([conn], [], [])

    monkeypatch.setattr(select_module, 'select', fake_select)

    thread = threading.Thread(target=engine._listen_loop, daemon=True)
    thread.start()
    thread.join(3.0)
    assert not thread.is_alive()
    assert conn.closed is True

    with engine._lock:
        assert engine._cancel_events.get('task-1') is None    # 没有对应事件也不炸
    assert engine._lanes['db_lane']._wake.is_set()            # 唤醒对应车道
    assert engine._lanes['other']._wake.is_set()              # payload=None 全唤醒
    engine.shutdown()


def test_listen_loop_swallows_close_errors(fake_pg, monkeypatch):
    """LISTEN 连接关闭失败只记日志，不让监听线程炸掉。"""
    engine = TaskEngine()

    class CloseFailConn:
        def __init__(self):
            self.notifies = []
            self.closed = False

        def poll(self):
            engine._listener_stop.set()

        def close(self):
            self.closed = True
            raise RuntimeError('socket already dead')

    conn = CloseFailConn()
    monkeypatch.setattr(pg_queue, 'listen_connection', lambda: conn)

    import select as select_module
    monkeypatch.setattr(select_module, 'select', lambda *args: ([conn], [], []))

    thread = threading.Thread(target=engine._listen_loop, daemon=True)
    thread.start()
    thread.join(3.0)
    assert not thread.is_alive()
    assert conn.closed is True
    engine.shutdown()


def test_listen_loop_reconnects_after_connection_error(fake_pg, monkeypatch):
    engine = TaskEngine()
    attempts = []

    def flaky_listen():
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError('conn refused')
        engine._listener_stop.set()               # 第二次直接退出
        raise RuntimeError('stop now')

    monkeypatch.setattr(pg_queue, 'listen_connection', flaky_listen)

    import select as select_module
    monkeypatch.setattr(select_module, 'select', lambda *args: ([], [], []))

    thread = threading.Thread(target=engine._listen_loop, daemon=True)
    thread.start()
    thread.join(3.0)
    assert len(attempts) >= 2
    engine.shutdown()


def test_durable_task_without_claim_or_kind_is_logged(fake_pg):
    engine = TaskEngine()
    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    # kind 未注册：_execute_durable 直接返回
    engine._execute_durable(TaskRecord(task_id='t1', kind='ghost',
                                       locked_by='w1'))
    # 没有 locked_by：同样直接返回
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         lambda record, ctx: None)
    engine._execute_durable(TaskRecord(task_id='t2', kind='work', locked_by=None))
    engine.shutdown()


def test_engine_start_is_idempotent(fake_pg):
    engine = TaskEngine()
    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         lambda record, ctx: None)
    fake_pg.set('reclaim_expired', [[{'id': 'recovered'}]])
    engine.start()
    wait_until(lambda: bool(fake_pg.calls.get('claim')))
    engine.start()                                     # 幂等：第二次直接返回
    engine.shutdown()
    assert engine.is_shutdown
    wait_until(lambda: len(fake_pg.calls.get('reclaim_expired', [])) >= 1)
    # 启动回收：有行时记 warning（见 caplog 版本的独立用例）


def test_engine_startup_reclaim_failure_is_logged(fake_pg, caplog):
    import logging
    engine = TaskEngine()
    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         lambda record, ctx: None)
    fake_pg.set('reclaim_expired', [RuntimeError('pg down')])
    with caplog.at_level(logging.WARNING):
        engine.start()
        wait_until(lambda: 'startup task reclaim failed' in caplog.text)
    engine.shutdown()


def test_stats_skips_records_of_unknown_kind(fake_pg):
    engine = TaskEngine()
    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         lambda record, ctx: None)
    ghost = TaskRecord(task_id='ghost', kind='ghost', status=STATUS_RETRY)
    with engine._lock:
        engine._records['ghost'] = ghost               # 历史遗留的未知类型
    stats = engine.stats()['db_lane']
    assert stats.retry == 0                            # 未知类型不进计数


def test_submit_swallows_notify_failures(fake_pg):
    engine = TaskEngine()
    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db'),
                         lambda record, ctx: None)
    fake_pg.set('notify', [RuntimeError('pg down')])
    engine.submit('work')                              # 不应抛出
    engine.shutdown()


def test_heartbeat_losing_lease_and_cancel_query_failure_are_swallowed(fake_pg):
    engine = TaskEngine()
    with engine._lock:
        engine._in_flight['t1'] = ('worker-1', 30)
    fake_pg.set('heartbeat', [False])
    fake_pg.set('cancel_requested_ids', [RuntimeError('pg down')])
    thread = threading.Thread(target=engine._heartbeat_loop, args=(0.01,),
                              daemon=True)
    thread.start()
    wait_until(lambda: bool(fake_pg.calls.get('heartbeat')))
    wait_until(lambda: bool(fake_pg.calls.get('cancel_requested_ids')))
    engine._heartbeat_stop.set()
    thread.join(2.0)


def test_run_record_without_kind_is_logged(fake_pg):
    engine = TaskEngine()
    engine._run_record(TaskRecord(task_id='t1', kind='ghost'))   # 无注册直接返回
    engine.shutdown()


def test_run_cancel_hook_without_hook_returns(fake_pg):
    kind = TaskKind(name='work', lane='lane')          # 未登记钩子
    assert TaskEngine._run_cancel_hook(kind, TaskRecord(task_id='t', kind='work')) is None


def test_run_cancel_hook_failure_is_logged(fake_pg, caplog):
    import logging

    def broken(row):
        raise RuntimeError('domain sync failed')

    registry.register_cancel_hook('TEST_TASK', broken)
    try:
        kind = TaskKind(name='work', lane='lane', persist_type='TEST_TASK')
        record = TaskRecord(task_id='t', kind='work',
                            payload={'kbase_id': 'graph_kb-1'})
        with caplog.at_level(logging.WARNING):
            TaskEngine._run_cancel_hook(kind, record)
        assert 'task cancel hook failed' in caplog.text
    finally:
        registry.unregister_cancel_hook('TEST_TASK')


def test_durable_retry_delay_failure_falls_back_to_immediate(fake_pg):
    """retry_delay 本身抛错：按 0 延迟立即重排，不让任务卡死。"""
    engine = TaskEngine()
    store = RecordingStore()

    def runner(record, ctx):
        raise RuntimeError('boom')

    def broken_delay(_error):
        raise RuntimeError('delay calc failed')

    engine.register_lane('db_lane', mode='db', poll_seconds=0.02)
    engine.register_kind(TaskKind(name='work', lane='db_lane', queue_mode='db',
                                  max_attempts=2, retry_delay=broken_delay),
                         runner, store)
    fake_pg.claim_rows.append(_claimed_row())
    engine.submit('work', create_row=False)
    wait_until(lambda: bool(fake_pg.calls.get('reschedule')))
    assert fake_pg.calls['reschedule'][0][2] == 0.0
    engine.shutdown()


def test_memory_retry_delay_failure_falls_back_to_immediate(fake_pg):
    engine = TaskEngine()
    done = threading.Event()
    attempts = []

    def runner(record, ctx):
        attempts.append(record.attempt)
        if record.attempt == 1:
            raise RuntimeError('boom')
        done.set()

    def broken_delay(_error):
        raise RuntimeError('delay calc failed')

    engine.register_lane('mem', workers=1)
    engine.register_kind(TaskKind(name='work', lane='mem', max_attempts=2,
                                  retry_delay=broken_delay, retain_completed=True),
                         runner)
    engine.submit('work')
    assert done.wait(3.0)                              # 0 延迟 → 立即重投成功
    engine.shutdown()


def test_requeue_delayed_full_lane_reschedules_again(fake_pg):
    engine = TaskEngine()
    engine.register_lane('mem', workers=1, capacity=1)
    engine._lanes['mem'].submit(TaskRecord(task_id='holder', kind='missing'))
    record = TaskRecord(task_id='x', kind='missing')
    engine._requeue_delayed('mem', record)             # 队满 → 进调度堆稍后再试
    wait_until(lambda: engine._scheduler.pending_for('mem') >= 1)
    engine.shutdown()                                  # 关停把遗留判失败
    wait_until(lambda: record.status == STATUS_FAILED)


def test_scheduler_delivers_due_records_and_stop_fails_leftovers(fake_pg):
    engine = TaskEngine()
    delivered = []
    engine._scheduler._on_due = lambda lane, record: delivered.append(record)

    record = TaskRecord(task_id='x', kind='k')
    engine._scheduler.schedule('mem', record, 5.0)     # 远未到期
    assert engine._scheduler.pending_for('mem') == 1
    engine._scheduler.schedule('mem', record, 0.0)     # 已到期
    wait_until(lambda: len(delivered) == 1)
    assert engine._scheduler.pending_for('mem') == 1   # 5s 的那条仍在堆里

    leftovers = []
    engine._scheduler._on_shutdown = leftovers.append
    engine._scheduler.stop()
    assert [item.task_id for item in leftovers] == ['x']
