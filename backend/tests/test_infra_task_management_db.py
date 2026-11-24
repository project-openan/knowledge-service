"""任务管理面（management）的 SQL 路径：列表/详情/统计/取消/重试/优先级。

DB 全部换成假连接与 pg_queue 桩；钩子语义与错误归宿一并钉住。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta

import pytest

from infrastructure.tasks import management
from infrastructure.tasks import pg_queue, registry
from shared.errors.api import KbConflictError, KbNotFoundError, KbValidationError


class ScriptedCursor:
    """execute 顺序脚本化 fetchone/fetchall/rowcount/description。"""

    def __init__(self, fetch_ones=None, fetch_alls=None, descriptions=None):
        self.sql = []
        self.params = []
        self._ones = list(fetch_ones or [])
        self._alls = list(fetch_alls or [])
        self._descriptions = list(descriptions or [])
        self.rowcount = -1
        self.description = [('id',), ('status',)]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.sql.append(sql)
        self.params.append(params)
        if self._descriptions:
            self.description = self._descriptions.pop(0)

    def fetchone(self):
        return self._ones.pop(0) if self._ones else None

    def fetchall(self):
        return self._alls.pop(0) if self._alls else []

    def close(self):
        pass


class ScriptedConn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.commits = 0

    def cursor(self):
        return self._cursor

    def commit(self):
        self.commits += 1

    def close(self):
        pass


def _patch_conn(monkeypatch, cursor):
    conn = ScriptedConn(cursor)

    @contextmanager
    def _connection():
        yield conn

    monkeypatch.setattr(management, 'connection', _connection)
    return conn


def _task_row(**overrides):
    row = {
        'id': 't1', 'task_type': 'FILE_IMPORT', 'lane': 'file_import',
        'status': 'PENDING', 'priority': 3, 'progress': 10, 'attempt': 1,
        'max_attempts': 4, 'kbase_id': 'kb1', 'kbase_name': 'Demo', 'file_name': None,
        'error_message': None, 'start_time': None, 'finish_time': None,
        'available_at': datetime(2026, 1, 1, 0, 0), 'locked_by': None,
        'locked_until': None, 'heartbeat_at': None, 'cancel_requested': True,
        'cancel_requested_at': None, 'created_at': datetime(2026, 1, 1, 0, 0),
        'updated_at': 'raw-string-stays', 'payload': {'fileId': 'f1'}, 'extra': None,
    }
    row.update(overrides)
    return row


#: 列名与 `_task_row` 的键逐一对应；fetchall 返回按同序的元组（模拟 psycopg2 游标）。
_TASK_COLUMNS = [(name,) for name in _task_row()]


def _row_tuple(row):
    return tuple(row.values())


def test_where_clause_combines_all_filters():
    where, params = management._where_clause(
        task_type='FILE_IMPORT', statuses=['FAILED'], lane='file_import',
        kbase_id='kb1', keyword='demo')
    assert where.startswith(' WHERE ')
    assert where.count(' AND ') == 4
    assert params == ['FILE_IMPORT', ['FAILED'], 'file_import', 'kb1',
                      'demo', 'demo', '%demo%', '%demo%']


def test_where_clause_handles_sentinel_and_kb_scope():
    where, params = management._where_clause(
        task_type=None, statuses=None, lane=None, kbase_id='__none__',
        keyword=None)
    assert 't.kbase_id IS NULL' in where
    assert params == []

    where, params = management._where_clause(
        task_type=None, statuses=None, lane=None, kbase_id=None,
        keyword='demo', keyword_scope='kb')
    assert 'k.name ILIKE %s' in where
    assert params == ['demo', '%demo%']

    where, _ = management._where_clause(task_type=None, statuses=None, lane=None,
                                        kbase_id=None, keyword=None)
    assert where == ''


def test_iso_keeps_non_datetime_values_untouched():
    assert management._iso(datetime(2026, 1, 1, 5, 6)) == '2026-01-01T05:06:00'
    assert management._iso('2026-01-01') == '2026-01-01'
    assert management._iso(None) is None


def test_task_dict_clamps_missing_numbers_and_cancels_flag():
    item = management._task_dict(_task_row(priority=None, progress=None,
                                           attempt=None, max_attempts=None,
                                           cancel_requested=None))
    assert item['priority'] == 0 and item['progress'] == 0
    assert item['attempt'] == 0 and item['maxAttempts'] == 0
    assert item['cancelRequested'] is False
    assert item['updatedAt'] == 'raw-string-stays'      # 非(datetime) 原样透出


def test_list_tasks_runs_count_and_page_queries(monkeypatch):
    cursor = ScriptedCursor(fetch_ones=[(11,)],
                            fetch_alls=[[_row_tuple(_task_row())]],
                            descriptions=[None, _TASK_COLUMNS])
    _patch_conn(monkeypatch, cursor)

    result = management.list_tasks(task_type='FILE_IMPORT', status='pending',
                                   lane='file_import', kbase_id='kb1',
                                   keyword='demo', page=2, size=5)

    assert result['total'] == 11
    assert result['page'] == 2 and result['pageSize'] == 5
    assert result['items'][0]['taskType'] == 'FILE_IMPORT'
    assert len(cursor.sql) == 2
    assert 'LIMIT %s OFFSET %s' in cursor.sql[1]
    assert cursor.params[1][-2:] == [5, 5]              # page=2, size=5 → offset 5


def test_list_tasks_rejects_bad_pagination(monkeypatch):
    with pytest.raises(KbValidationError):
        management.list_tasks(page=0)
    with pytest.raises(KbValidationError):
        management.list_tasks(size=management.MAX_PAGE_SIZE + 1)


def test_list_tasks_rejects_unknown_status(monkeypatch):
    with pytest.raises(KbValidationError):
        management.list_tasks(status='PENDING,NOPE')


def test_list_task_groups_aggregates_by_kbase(monkeypatch):
    {'kbase_id': 'kb1', 'kbase_name': 'Demo', 'total': 2,
                 'latest_created_at': datetime(2026, 1, 2, 3, 4),
                 'pending': 2, 'running': 0}
    _GROUP_COLUMNS = [('kbase_id',), ('kbase_name',), ('total',),
                      ('latest_created_at',), ('pending',), ('running',),
                      ('retry',), ('completed',), ('completed_with_errors',),
                      ('failed',), ('cancelled',)]
    group_tuple = ('kb1', 'Demo', 2, datetime(2026, 1, 2, 3, 4), 2, 0, 0, 0, 0, 0, 0)
    cursor = ScriptedCursor(fetch_ones=[(1,), (9,)], fetch_alls=[[group_tuple]],
                            descriptions=[None, None, _GROUP_COLUMNS])
    _patch_conn(monkeypatch, cursor)

    result = management.list_task_groups(kbase_id='kb1', keyword='demo')

    assert result['total'] == 1
    assert result['taskTotal'] == 9
    assert result['items'][0]['byStatus']['PENDING'] == 2
    assert result['items'][0]['latestCreatedAt'] == '2026-01-02T03:04:00'
    assert 'FILTER (WHERE t.status' in cursor.sql[2]


_ATTEMPT_COLUMNS = [('attempt',), ('worker_id',), ('status',), ('error_message',),
                    ('started_at',), ('finished_at',)]


def test_get_task_returns_detail_with_attempts(monkeypatch):
    started = datetime(2026, 1, 1, 0, 0, 0)
    finished = started + timedelta(milliseconds=1500)
    cursor = ScriptedCursor(
        fetch_alls=[[_row_tuple(_task_row())],
                    [(2, 'w1', 'FAILED', 'boom', started, finished)]],
        descriptions=[_TASK_COLUMNS, _ATTEMPT_COLUMNS])
    _patch_conn(monkeypatch, cursor)

    item = management.get_task('t1')

    assert item['payload'] == {'fileId': 'f1'}
    assert item['extra'] == {}                       # extra=None → 回落空 dict
    assert item['attempts'][0]['durationMs'] == 1500
    assert item['attempts'][0]['workerId'] == 'w1'


def test_get_task_clamps_negative_duration(monkeypatch):
    cursor = ScriptedCursor(
        fetch_alls=[[_row_tuple(_task_row())],
                    [(1, 'w', 'FAILED', None,
                      datetime(2026, 1, 1, 0, 0, 10), datetime(2026, 1, 1, 0, 0))]],
        descriptions=[_TASK_COLUMNS, _ATTEMPT_COLUMNS])
    _patch_conn(monkeypatch, cursor)
    item = management.get_task('t1')
    assert item['attempts'][0]['durationMs'] == 0


def test_get_task_missing_row_is_404(monkeypatch):
    cursor = ScriptedCursor(fetch_alls=[[]], descriptions=[_TASK_COLUMNS])
    _patch_conn(monkeypatch, cursor)
    with pytest.raises(KbNotFoundError) as error:
        management.get_task('gone')
    assert error.value.problem_spec().code == 'task_not_found'


def test_stats_aggregates_status_lane_type_and_health(monkeypatch):
    cursor = ScriptedCursor(
        fetch_alls=[[('PENDING', 2), ('FAILED', 1), ('WEIRD', 4)],
                    [('file_import', 'PENDING', 2)],
                    [('FILE_IMPORT', 3)],
                    ],
        fetch_ones=[(15,), (1,)])
    _patch_conn(monkeypatch, cursor)

    result = management.stats()

    assert result['total'] == 7
    assert result['queueDepth'] == 2
    assert result['oldestPendingAgeSeconds'] == 15
    assert result['overdueRunning'] == 1
    assert result['byStatus']['WEIRD'] == 4
    assert result['byLane']['file_import']['PENDING'] == 2
    assert result['byType'] == {'FILE_IMPORT': 3}


def _patch_pg_queue(monkeypatch, **funcs):
    for name, func in funcs.items():
        monkeypatch.setattr(pg_queue, name, func)


def test_cancel_task_takes_pending_row_and_runs_hook(monkeypatch):
    seen = []
    registry.register_cancel_hook('FILE_IMPORT', lambda row: seen.append(row))
    try:
        row = _task_row(status='CANCELLED', cancel_requested=True)
        _patch_pg_queue(monkeypatch, cancel=lambda task_id, reason: row)
        result = management.cancel_task('t1', '  ')
        assert result['status'] == 'CANCELLED'
        assert seen == [row]                              # reason 缺省不拦钩子
    finally:
        registry.unregister_cancel_hook('FILE_IMPORT')


def test_cancel_task_marks_running_and_notifies(monkeypatch):
    notified = []
    row = _task_row(status='RUNNING')
    _patch_pg_queue(monkeypatch,
                    cancel=lambda task_id, reason: None,
                    request_cancel=lambda task_id: row,
                    notify_cancel=lambda task_id: notified.append(task_id))
    result = management.cancel_task('t1', 'duplicate')
    assert result['status'] == 'RUNNING'
    assert notified == ['t1']


def test_cancel_task_swallows_notify_failures(monkeypatch):
    row = _task_row(status='RUNNING')

    def broken_notify(task_id):
        raise RuntimeError('pg down')

    _patch_pg_queue(monkeypatch,
                    cancel=lambda task_id, reason: None,
                    request_cancel=lambda task_id: row,
                    notify_cancel=broken_notify)
    assert management.cancel_task('t1')['status'] == 'RUNNING'


def test_cancel_task_reason_length_is_capped(monkeypatch):
    with pytest.raises(KbValidationError):
        management.cancel_task('t1', 'x' * (management.MAX_REASON_LENGTH + 1))


def test_cancel_task_maps_missing_and_terminal_states(monkeypatch):
    _patch_pg_queue(monkeypatch,
                    cancel=lambda task_id, reason: None,
                    request_cancel=lambda task_id: None,
                    task_status=lambda task_id: None)
    with pytest.raises(KbNotFoundError):
        management.cancel_task('gone')

    _patch_pg_queue(monkeypatch, task_status=lambda task_id: 'COMPLETED')
    with pytest.raises(KbConflictError) as error:
        management.cancel_task('t1')
    assert error.value.problem_spec().code == 'task_not_cancellable'


def test_cancel_hook_failure_is_logged_not_raised(monkeypatch):
    def broken_hook(row):
        raise RuntimeError('domain sync failed')

    registry.register_cancel_hook('FILE_IMPORT', broken_hook)
    try:
        row = _task_row(status='CANCELLED')
        _patch_pg_queue(monkeypatch, cancel=lambda task_id, reason: row)
        assert management.cancel_task('t1')['status'] == 'CANCELLED'
    finally:
        registry.unregister_cancel_hook('FILE_IMPORT')


def test_cancel_and_retry_skip_missing_hooks(monkeypatch):
    row = _task_row(status='CANCELLED')
    _patch_pg_queue(monkeypatch, cancel=lambda task_id, reason: row)
    registry.clear_cancel_hooks()                        # 该类型没有登记钩子
    assert management.cancel_task('t1')['status'] == 'CANCELLED'

    row = _task_row(status='PENDING')
    _patch_pg_queue(monkeypatch,
                    get=lambda task_id: _task_row(status='FAILED'),
                    retry=lambda task_id: row,
                    notify=lambda lane: None)
    assert management.retry_task('t1')['status'] == 'PENDING'


def test_retry_task_requires_retryable_state_and_input(monkeypatch):
    _patch_pg_queue(monkeypatch, get=lambda task_id: None)
    with pytest.raises(KbNotFoundError):
        management.retry_task('gone')

    _patch_pg_queue(monkeypatch, get=lambda task_id: _task_row(status='PENDING'))
    with pytest.raises(KbConflictError) as error:
        management.retry_task('t1')
    assert error.value.problem_spec().code == 'task_not_retryable'

    _patch_pg_queue(monkeypatch, get=lambda task_id: _task_row(
        status='FAILED', task_type='GRAPH_EXTRACT', payload={'tmpDir': '/gone'}))
    with pytest.raises(KbConflictError) as error:
        management.retry_task('t1')
    assert error.value.problem_spec().code == 'task_input_expired'


def test_retry_task_race_reports_conflict(monkeypatch):
    _patch_pg_queue(monkeypatch,
                    get=lambda task_id: _task_row(status='FAILED'),
                    retry=lambda task_id: None,
                    task_status=lambda task_id: 'COMPLETED')
    with pytest.raises(KbConflictError):
        management.retry_task('t1')

    _patch_pg_queue(monkeypatch, task_status=lambda task_id: None)
    with pytest.raises(KbNotFoundError):
        management.retry_task('t1')


def test_retry_task_success_runs_hook_and_notifies(monkeypatch):
    hooks = []
    registry.register_retry_hook('FILE_IMPORT', lambda row: hooks.append(row))
    try:
        row = _task_row(status='PENDING')
        notified = []
        _patch_pg_queue(monkeypatch,
                        get=lambda task_id: _task_row(status='FAILED'),
                        retry=lambda task_id: row,
                        notify=lambda lane: notified.append(lane))
        result = management.retry_task('t1')
        assert result['status'] == 'PENDING'
        assert hooks == [row]
        assert notified == ['file_import']
    finally:
        registry.unregister_retry_hook('FILE_IMPORT')


def test_retry_task_hook_and_notify_failures_do_not_escape(monkeypatch):
    def broken(row):
        raise RuntimeError('hook failed')

    registry.register_retry_hook('FILE_IMPORT', broken)
    try:
        row = _task_row(status='PENDING')

        def broken_notify(lane):
            raise RuntimeError('pg down')

        _patch_pg_queue(monkeypatch,
                        get=lambda task_id: _task_row(status='FAILED'),
                        retry=lambda task_id: row,
                        notify=broken_notify)
        assert management.retry_task('t1')['status'] == 'PENDING'
    finally:
        registry.unregister_retry_hook('FILE_IMPORT')


def test_set_priority_success_and_misses(monkeypatch):
    row = _task_row(priority=5)
    _patch_pg_queue(monkeypatch, set_priority=lambda task_id, priority: row)
    assert management.set_priority('t1', 5)['priority'] == 5

    _patch_pg_queue(monkeypatch,
                    set_priority=lambda task_id, priority: None,
                    task_status=lambda task_id: None)
    with pytest.raises(KbNotFoundError):
        management.set_priority('t1', 5)

    _patch_pg_queue(monkeypatch, task_status=lambda task_id: 'RUNNING')
    with pytest.raises(KbConflictError) as error:
        management.set_priority('t1', 5)
    assert error.value.problem_spec().code == 'task_not_queued'


def test_set_priority_rejects_out_of_range():
    with pytest.raises(KbValidationError):
        management.set_priority('t1', management.PRIORITY_MIN - 1)
    with pytest.raises(KbValidationError):
        management.set_priority('t1', management.PRIORITY_MAX + 1)
