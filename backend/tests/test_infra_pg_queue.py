"""``task_center.task`` 持久化队列操作（pg_queue）的 SQL 形状与返回值契约。

不连真实 PG：``connection`` 换成假连接，游标按用例脚本返回行数/行集。
"""

from __future__ import annotations

from contextlib import contextmanager


from infrastructure.tasks import pg_queue


class FakeCursor:
    """记录 SQL；fetch 行集与 rowcount 按队列依次给出。"""

    def __init__(self, fetch_ones=None, fetch_alls=None, rowcounts=None,
                 descriptions=None):
        self.sql = []
        self.params = []
        self._fetch_ones = list(fetch_ones or [])
        self._fetch_alls = list(fetch_alls or [])
        self._rowcounts = list(rowcounts or [])
        self._descriptions = list(descriptions or [])
        self.description = None
        self.rowcount = -1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.sql.append(sql)
        self.params.append(params)
        if self._descriptions:
            self.description = self._descriptions.pop(0)
        if self._rowcounts:
            self.rowcount = self._rowcounts.pop(0)

    def fetchone(self):
        if self._fetch_ones:
            return self._fetch_ones.pop(0)
        if self._fetch_alls:
            rows = self._fetch_alls[0]
            return rows[0] if rows else None
        return None

    def fetchall(self):
        if self._fetch_alls:
            return self._fetch_alls.pop(0)
        return []

    def close(self):
        pass


class FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.commits = 0

    def cursor(self):
        return self._cursor

    def commit(self):
        self.commits += 1

    def close(self):
        pass

    def set_isolation_level(self, level):
        self.isolation_level = level


def _patch_conn(monkeypatch, cursor):
    conn = FakeConn(cursor)

    @contextmanager
    def _connection():
        yield conn

    monkeypatch.setattr(pg_queue, 'connection', _connection)
    return conn


def test_notify_and_notify_cancel_send_pg_notify(monkeypatch):
    cursor = FakeCursor()
    _patch_conn(monkeypatch, cursor)

    pg_queue.notify('graph_extract')
    pg_queue.notify_cancel('task-9')

    assert cursor.sql == ['SELECT pg_notify(%s, %s)', 'SELECT pg_notify(%s, %s)']
    assert cursor.params[0] == (pg_queue.NOTIFY_CHANNEL, 'graph_extract')
    assert cursor.params[1] == (pg_queue.CANCEL_NOTIFY_CHANNEL, 'task-9')


def test_listen_connection_uses_autocommit_and_listens_both_channels(monkeypatch):
    created = {}

    class FakePsycopg2Conn:
        def cursor(self):

            class _Cursor:
                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return False

                def execute(self, sql):
                    created.setdefault('listen', []).append(sql)

            return _Cursor()

        def set_isolation_level(self, level):
            created['isolation'] = level

    def fake_connect(database=None, connect_timeout=None, **info):
        created['database'] = database
        created['connect_timeout'] = connect_timeout
        created['info'] = info
        return FakePsycopg2Conn()

    import psycopg2
    monkeypatch.setattr(psycopg2, 'connect', fake_connect)
    monkeypatch.setattr('infrastructure.db.connection_info.get_db_conn_info',
                        lambda: {'driver': 'psycopg2', 'host': 'db', 'port': '5432',
                                 'database': 'explicit_db', 'user': 'u',
                                 'password': 'p'})
    monkeypatch.setattr('infrastructure.db.kb.get_kbase_db_name', lambda: 'kbase')

    pg_queue.listen_connection()

    assert created['database'] == 'explicit_db'          # 显式库名优先
    assert created['connect_timeout'] == 2
    assert 'driver' not in created['info']               # driver 不是 psycopg2 参数
    assert created['isolation'] == psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT
    assert created['listen'] == [f'LISTEN {pg_queue.NOTIFY_CHANNEL}',
                                 f'LISTEN {pg_queue.CANCEL_NOTIFY_CHANNEL}']


def test_listen_connection_falls_back_to_kbase_db_name(monkeypatch):
    def fake_connect(database=None, connect_timeout=None, **info):
        assert database == 'kbase_fallback'
        return FakeConn(FakeCursor())

    import psycopg2
    monkeypatch.setattr(psycopg2, 'connect', fake_connect)
    monkeypatch.setattr('infrastructure.db.connection_info.get_db_conn_info',
                        lambda: {'host': None, 'port': None,
                                 'user': None, 'password': ''})  # 没有 database 键
    monkeypatch.setattr('infrastructure.db.kb.get_kbase_db_name',
                        lambda: 'kbase_fallback')
    pg_queue.listen_connection()


def test_claim_returns_none_without_task_types(monkeypatch):
    cursor = FakeCursor()
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.claim('lane', [], 'worker-1') is None
    assert cursor.sql == []                              # 没有类型就不打库


_ROW_COLUMNS = [('id',), ('status',)]


def test_claim_returns_projected_row(monkeypatch):
    cursor = FakeCursor(fetch_alls=[[('t1', 'RUNNING')]],
                        descriptions=[_ROW_COLUMNS])
    _patch_conn(monkeypatch, cursor)

    row = pg_queue.claim('lane', ['FILE_IMPORT'], 'worker-1', lease_seconds=30)

    assert row == {'id': 't1', 'status': 'RUNNING'}
    assert 'FOR UPDATE SKIP LOCKED' in cursor.sql[0]
    assert cursor.params[0] == ('lane', ['FILE_IMPORT'], 'worker-1', 30)


def test_claim_returns_none_when_no_candidate(monkeypatch):
    cursor = FakeCursor(fetch_alls=[[]], descriptions=[_ROW_COLUMNS])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.claim('lane', ['FILE_IMPORT'], 'worker-1') is None


def test_lease_updates_report_rowcount(monkeypatch):
    cases = [
        (lambda: pg_queue.heartbeat('t1', 'w1'), 'heartbeat_at = now()'),
        (lambda: pg_queue.release('t1', 'w1'), 'locked_by = NULL'),
        (lambda: pg_queue.complete('t1', 'w1', progress=80), "status = 'COMPLETED'"),
        (lambda: pg_queue.fail('t1', 'w1', 'boom'), "status = 'FAILED'"),
    ]
    for func, sql_fragment in cases:
        cursor = FakeCursor(rowcounts=[1])
        _patch_conn(monkeypatch, cursor)
        assert func() is True
        assert sql_fragment in cursor.sql[0]

        cursor = FakeCursor(rowcounts=[0])
        _patch_conn(monkeypatch, cursor)
        assert func() is False


def test_reschedule_writes_retry_with_delay(monkeypatch):
    cursor = FakeCursor(rowcounts=[1])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.reschedule('t1', 'w1', 2, 5.0, 'boom') is True
    assert "status = 'RETRY'" in cursor.sql[0]
    assert cursor.params[0] == (2, 5.0, 'boom', 't1', 'w1')


def test_pending_count_counts_queue(monkeypatch):
    cursor = FakeCursor(fetch_ones=[(3,)])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.pending_count('lane') == 3
    assert "status IN ('PENDING', 'RETRY')" in cursor.sql[0]


def test_get_and_task_status(monkeypatch):
    cursor = FakeCursor(fetch_alls=[[('t1', 'PENDING')]],
                        descriptions=[_ROW_COLUMNS])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.get('t1') == {'id': 't1', 'status': 'PENDING'}

    cursor = FakeCursor(fetch_ones=[('FAILED',)])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.task_status('t1') == 'FAILED'

    cursor = FakeCursor(fetch_ones=[None])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.task_status('gone') is None


def test_cancel_only_takes_pending_or_retry(monkeypatch):
    cursor = FakeCursor(fetch_alls=[[('t1', 'CANCELLED')]],
                        descriptions=[_ROW_COLUMNS])
    _patch_conn(monkeypatch, cursor)
    row = pg_queue.cancel('t1', 'dup upload')
    assert row == {'id': 't1', 'status': 'CANCELLED'}
    assert "status IN ('PENDING', 'RETRY')" in cursor.sql[0]
    assert cursor.params[0] == ('dup upload', 't1')

    cursor = FakeCursor(fetch_alls=[[]], descriptions=[_ROW_COLUMNS])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.cancel('t1') is None


def test_request_cancel_marks_running_row(monkeypatch):
    cursor = FakeCursor(fetch_alls=[[]], descriptions=[_ROW_COLUMNS])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.request_cancel('t1') is None
    assert "status = 'RUNNING'" in cursor.sql[0]


def test_cancel_requested_ids_empty_short_circuits(monkeypatch):
    cursor = FakeCursor()
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.cancel_requested_ids([]) == []
    assert cursor.sql == []


def test_cancel_requested_ids_returns_marked_ids(monkeypatch):
    cursor = FakeCursor(fetch_alls=[[('t2',)]])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.cancel_requested_ids(['t1', 't2']) == ['t2']
    assert 'cancel_requested' in cursor.sql[0]


def test_cancel_running_is_fenced_by_worker_id(monkeypatch):
    cursor = FakeCursor(rowcounts=[1])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.cancel_running('t1', 'w1', 'stop') is True
    assert cursor.params[0] == ('stop', 't1', 'w1')

    cursor = FakeCursor(rowcounts=[0])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.cancel_running('t1', 'w2') is False


def test_retry_resets_failed_or_cancelled(monkeypatch):
    cursor = FakeCursor(fetch_alls=[[('t1', 'PENDING')]],
                        descriptions=[_ROW_COLUMNS])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.retry('t1')['status'] == 'PENDING'
    assert "status IN ('FAILED', 'CANCELLED')" in cursor.sql[0]


def test_set_priority_only_touches_queued_tasks(monkeypatch):
    cursor = FakeCursor(fetch_alls=[[('t1', 'PENDING')]],
                        descriptions=[_ROW_COLUMNS])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.set_priority('t1', 7) is not None
    assert cursor.params[0] == (7, 't1')


def test_reclaim_expired_returns_rows(monkeypatch):
    rows = [('t1', 'FILE_IMPORT', 'lane', 2, 2, 'FAILED')]
    cursor = FakeCursor(fetch_alls=[rows],
                        descriptions=[[('id',), ('task_type',), ('lane',),
                                       ('attempt',), ('max_attempts',), ('status',)]])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.reclaim_expired() == [
        {'id': 't1', 'task_type': 'FILE_IMPORT', 'lane': 'lane',
         'attempt': 2, 'max_attempts': 2, 'status': 'FAILED'}]
    assert "WHEN attempt >= max_attempts THEN 'FAILED'" in cursor.sql[0]


def test_count_by_lane_groups_by_status(monkeypatch):
    cursor = FakeCursor(fetch_alls=[[(  'PENDING', 2), ('RUNNING', 1)]])
    _patch_conn(monkeypatch, cursor)
    assert pg_queue.count_by_lane('lane') == {'PENDING': 2, 'RUNNING': 1}
