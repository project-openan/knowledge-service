"""任务车道的边界：参数校验、关停语义、worker 崩溃，以及取消信号与钩子登记表。"""

from __future__ import annotations

import threading
import time

import pytest

from infrastructure.tasks import cancellation, registry
from infrastructure.tasks.durable_lane import DurableTaskLane
from infrastructure.tasks.lane import TaskLane
from infrastructure.tasks.types import (
    STATUS_FAILED,
    REQUEUE_FAILED_MESSAGE,
    TERMINAL_STATUSES,
    RETRYABLE_STATUSES,
    TaskContext,
    TaskRecord,
    TaskRejectedError,
)


@pytest.fixture(autouse=True)
def _shutdown_lanes(monkeypatch):
    """兜底关停本用例创建的车道：断言失败也不能留下非 daemon 的 worker 线程。"""
    lanes = []
    for cls in (TaskLane, DurableTaskLane):
        original = cls.__init__

        def patched(self, *args, _original=original, **kwargs):
            _original(self, *args, **kwargs)
            lanes.append(self)

        monkeypatch.setattr(cls, '__init__', patched)
    yield
    for lane in lanes:
        try:
            lane.shutdown()
        except Exception:                              # noqa: BLE001
            pass


def wait_until(predicate, timeout=3.0, interval=0.005):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise AssertionError('condition not met within %.1fs' % timeout)


# ---------------------------------------------------------------------------
# TaskLane（内存队列车道）
# ---------------------------------------------------------------------------

def test_lane_rejects_illegal_workers_and_capacity():
    with pytest.raises(ValueError):
        TaskLane('x', workers=0)
    with pytest.raises(ValueError):
        TaskLane('x', capacity=-1)


def test_lane_start_is_idempotent_under_concurrency():
    lane = TaskLane('x', workers=2)
    started = []

    def handler(record):
        started.append(record)

    threads = [threading.Thread(target=lane.start, args=(handler,))
               for _ in range(3)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(2)

    assert len(lane._threads) == 2                     # 只起一组 worker
    lane.shutdown()


def test_lane_shutdown_drains_queue_before_stopping():
    lane = TaskLane('x', workers=1)
    done = []
    lane.start(lambda record: done.append(record.task_id))
    lane.submit(TaskRecord(task_id='a', kind='k'))
    lane.submit(TaskRecord(task_id='b', kind='k'))
    lane.shutdown(drain_seconds=3.0)

    assert sorted(done) == ['a', 'b']
    assert lane.is_shutdown


def test_lane_submit_after_shutdown_returns_false():
    lane = TaskLane('x', workers=1)
    lane.shutdown()
    assert lane.submit(TaskRecord(task_id='a', kind='k')) is False


def test_lane_worker_crash_does_not_kill_lane():
    lane = TaskLane('x', workers=1)
    crashed = threading.Event()
    proceed = threading.Event()

    def handler(record):
        if record.task_id == 'boom':
            crashed.set()
            proceed.wait(2.0)
            raise RuntimeError('worker crashed')
        return 'ok'

    lane.start(handler)
    lane.submit(TaskRecord(task_id='boom', kind='k'))
    assert crashed.wait(3.0)
    proceed.set()
    wait_until(lambda: lane.running == 0)
    assert lane.queued == 0
    lane.submit(TaskRecord(task_id='next', kind='k'))  # 车道还在工作
    wait_until(lambda: lane.queued == 0)
    lane.shutdown()


def test_lane_full_queue_reports_queued_size():
    """capacity=1：不启动 worker（无消费者），第二件必被拒。"""
    lane = TaskLane('x', workers=1, capacity=1)
    assert lane.submit(TaskRecord(task_id='first', kind='k')) is True
    assert lane.queued == 1
    assert lane.submit(TaskRecord(task_id='second', kind='k')) is False
    lane.shutdown()


# ---------------------------------------------------------------------------
# DurableTaskLane（DB 认领车道）
# ---------------------------------------------------------------------------

def test_durable_lane_rejects_illegal_workers():
    with pytest.raises(ValueError):
        DurableTaskLane('x', workers=0)


def test_durable_lane_start_is_idempotent():
    lane = DurableTaskLane('x', poll_seconds=0.02)
    lane.start(lambda worker_id: None, lambda record: None)
    lane.start(lambda worker_id: None, lambda record: None)   # 二次调用直接返回
    lane.shutdown()
    assert lane._threads == []


def test_durable_lane_wake_and_shutdown_drain():
    lane = DurableTaskLane('x', poll_seconds=0.02)
    lane.start(lambda worker_id: None, lambda record: None)
    lane.wake()                                        # 不应抛错
    lane.shutdown(drain_seconds=0.05)
    assert lane.is_shutdown


def test_durable_lane_shutdown_drains_running_task():
    lane = DurableTaskLane('x', workers=1, poll_seconds=0.02)
    started = threading.Event()

    def execute(record):
        started.set()
        time.sleep(0.2)                                # 短任务：drain 循环能等到它结束

    def claim(worker_id):
        return TaskRecord(task_id='t1', kind='k') if not started.is_set() else None

    lane.start(claim, execute)
    assert started.wait(3.0)
    deadline = time.monotonic() + 0.05                 # 与 drain 循环并发起跑
    lane.shutdown(drain_seconds=3.0)                   # 等 running 归零再关停
    assert lane.running == 0
    assert lane._threads == []


def test_durable_lane_claim_failure_backs_off_then_recovers():
    lane = DurableTaskLane('x', poll_seconds=0.02)
    failures = [True, True, False]                     # 前两次认领抛错
    executed = threading.Event()

    def claim(worker_id):
        if failures:
            failures.pop(0)
            raise RuntimeError('pg down')
        return TaskRecord(task_id='t1', kind='k')

    def execute(record):
        executed.set()

    lane.start(claim, execute)
    try:
        assert executed.wait(3.0)
    finally:
        lane.shutdown()


def test_durable_lane_execute_crash_does_not_kill_worker():
    lane = DurableTaskLane('x', poll_seconds=0.02)
    crashed = threading.Event()
    lock = threading.Lock()
    rows = []

    def claim(worker_id):
        with lock:
            if rows:
                return rows.pop(0)
        return None

    def execute(record):
        crashed.set()
        raise RuntimeError('execute crashed')

    rows.append(TaskRecord(task_id='t1', kind='k'))
    lane.start(claim, execute)
    try:
        assert crashed.wait(3.0)
        wait_until(lambda: lane.running == 0)          # worker 还活着并回到轮询
    finally:
        lane.shutdown()


# ---------------------------------------------------------------------------
# cancellation / registry / types
# ---------------------------------------------------------------------------

def test_cancellation_signal_round_trip():
    event = threading.Event()
    assert cancellation.is_cancelled() is False        # 未设置事件
    cancellation.set_cancel_event(event)
    assert cancellation.is_cancelled() is False
    assert cancellation.raise_if_cancelled() is None   # 未置位时不抛

    event.set()
    assert cancellation.is_cancelled() is True
    with pytest.raises(cancellation.TaskCancelled):
        cancellation.raise_if_cancelled()

    cancellation.clear_cancel_event()
    assert cancellation.is_cancelled() is False


def test_task_context_progress_and_cancel_helpers():
    record = TaskRecord(task_id='t1', kind='k')
    progress = []

    class Store:
        def on_progress(self, record, percent):
            progress.append(percent)

        def load(self, task_id):
            return None

        def on_submit(self, record):
            pass

        def on_change(self, record):
            pass

    event = threading.Event()
    ctx = TaskContext(record=record, lane='lane', store=Store(), cancel_event=event)
    ctx.set_progress(42)
    assert progress == [42]

    silent = TaskContext(record=record, lane='lane', store=object())
    silent.set_progress(10)                            # store 没有 on_progress → 静默

    plain = TaskContext(record=record, lane='lane')
    assert plain.is_cancelled() is False               # 没有事件也不炸
    assert plain.raise_if_cancelled() is None

    cancellation.set_cancel_event(event)               # raise_if_cancelled 走 thread-local
    event.set()
    assert ctx.is_cancelled() is True
    with pytest.raises(cancellation.TaskCancelled):
        ctx.raise_if_cancelled()
    cancellation.clear_cancel_event()


def test_registry_hook_table_round_trip_and_clear():
    registry.clear_cancel_hooks()

    def hook_a(row):
        pass

    def hook_b(row):
        pass

    registry.register_cancel_hook('', hook_a)          # 空 type 不登记
    registry.register_cancel_hook('T', None)           # 空钩子不登记
    assert registry.cancel_hook_for('T') is None
    assert registry.retry_hook_for('T') is None

    registry.register_cancel_hook('T', hook_a)
    registry.register_retry_hook('T', hook_b)
    assert registry.cancel_hook_for('T') is hook_a
    assert registry.retry_hook_for('T') is hook_b

    registry.unregister_cancel_hook('T')
    registry.unregister_retry_hook('T')
    assert registry.cancel_hook_for('T') is None

    registry.register_cancel_hook('T2', hook_a)
    registry.register_retry_hook('T2', hook_b)
    registry.clear_cancel_hooks()                      # 测试兜底清空两张表
    assert registry.cancel_hook_for('T2') is None
    assert registry.retry_hook_for('T2') is None


def test_public_task_type_constants_and_rejected_error():
    assert set(RETRYABLE_STATUSES) <= set(TERMINAL_STATUSES)
    assert REQUEUE_FAILED_MESSAGE.startswith('Failed to resubmit')
    error = TaskRejectedError('lane full')
    assert isinstance(error, RuntimeError)
    assert STATUS_FAILED in TERMINAL_STATUSES
