"""``infrastructure.db`` 公共底座：建表守卫、标识符白名单、行投影、连接参数。

schema_guard 的竞态语义用**假 conn/stub** 钉住双检锁的两条路径，不连真实 PG。
"""

from __future__ import annotations

import threading

import pytest

from infrastructure.db import connection_info, identifiers, rows, schema_guard


# ---------------------------------------------------------------------------
# schema_guard：检查 → 加锁 → 执行 → 标记 的公共顺序
# ---------------------------------------------------------------------------

class RecordingConn:
    """只记录 execute/commit 调用的假连接。"""

    def __init__(self):
        self.executed = []
        self.commits = 0

    def cursor(self):
        guard = self

        class _Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, sql):
                guard.executed.append(sql)

        return _Cursor()

    def commit(self):
        self.commits += 1


class _UnlockingLock:
    """``with`` 进入时执行回调的假锁 —— 用来模拟「拿到锁之前别人已建完表」。"""

    def __init__(self, on_enter):
        self._on_enter = on_enter

    def __enter__(self):
        self._on_enter()
        return self

    def __exit__(self, *exc):
        return False


def test_ensure_schema_skips_when_flag_already_set():
    conn = RecordingConn()
    import types
    owner = types.ModuleType('fake_owner')
    owner._schema_ready = True

    schema_guard.ensure_schema(conn, ['CREATE TABLE t (id int)'], owner=owner)

    assert conn.executed == [] and conn.commits == 0


def test_ensure_schema_executes_and_commits_then_marks_ready():
    conn = RecordingConn()
    import types
    owner = types.ModuleType('fake_owner')
    owner._schema_ready = False

    schema_guard.ensure_schema(
        conn, ['CREATE TABLE a', 'CREATE TABLE b'],
        owner=owner, flag='_schema_ready')

    assert conn.executed == ['CREATE TABLE a', 'CREATE TABLE b']
    assert conn.commits == 1
    assert owner._schema_ready is True


def test_ensure_schema_without_commit_leaves_flag_set():
    """model 侧语义：DDL 随外层事务提交，守卫不自行 commit。"""
    conn = RecordingConn()
    import types
    owner = types.ModuleType('fake_owner')
    owner._schema_ready = False

    schema_guard.ensure_schema(conn, ['CREATE TABLE a'], owner=owner, commit=False)

    assert conn.executed == ['CREATE TABLE a']
    assert conn.commits == 0
    assert owner._schema_ready is True


def test_ensure_schema_double_checked_lock_returns_without_reapply():
    """双检锁第二条路径：外检通过后、进锁前别人已建完 —— 不再执行 DDL。"""
    conn = RecordingConn()
    import types
    owner = types.ModuleType('fake_owner')
    owner._schema_ready = False

    def _mark_ready_before_inner_check():
        owner._schema_ready = True

    schema_guard.ensure_schema(
        conn, ['CREATE TABLE a'], owner=owner,
        lock=_UnlockingLock(_mark_ready_before_inner_check))

    assert conn.executed == [] and conn.commits == 0


def test_ensure_schema_lock_held_only_once_for_real_concurrency():
    """真并发：两条线程同时首查，DDL 只执行一次（加锁路径的本意）。"""
    conn = RecordingConn()
    import types
    owner = types.ModuleType('fake_owner')
    owner._schema_ready = False
    lock = threading.Lock()
    barrier = threading.Barrier(2)

    def _first_query():
        barrier.wait()
        schema_guard.ensure_schema(conn, ['CREATE TABLE a'], owner=owner, lock=lock)

    threads = [threading.Thread(target=_first_query) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)

    assert conn.executed == ['CREATE TABLE a']
    assert owner._schema_ready is True


# ---------------------------------------------------------------------------
# identifiers：动态表名的唯一防线
# ---------------------------------------------------------------------------

def test_validate_identifier_accepts_legal_names():
    assert identifiers.validate_identifier('doc_kb1_vector') == 'doc_kb1_vector'
    assert identifiers.validate_identifier('_leading_underscore') == '_leading_underscore'
    assert identifiers.SCHEMA == 'kb_index'


@pytest.mark.parametrize('name', ['', None, '1abc', 'has space', 'drop;table',
                                  'a-b', '表名', "x'"])
def test_validate_identifier_rejects_illegal_names(name):
    with pytest.raises(ValueError):
        identifiers.validate_identifier(name)


def test_doc_vector_table_and_chunk_table_derivation():
    assert identifiers.doc_vector_table('kb1') == 'doc_kb1_vector'
    assert identifiers.chunk_table_for('doc_kb1_vector') == 'doc_kb1_chunk'
    assert identifiers.chunk_table_for('graph_kb2') == 'graph_kb2_chunk'


# ---------------------------------------------------------------------------
# rows：cursor.description → dict 列表
# ---------------------------------------------------------------------------

class _FakeCursor:
    description = [('id',), ('name',), ('status',)]

    def fetchall(self):
        return [('t1', 'demo', 'PENDING'), ('t2', 'other', None)]


def test_rows_zips_columns_with_tuples():
    assert rows.rows(_FakeCursor()) == [
        {'id': 't1', 'name': 'demo', 'status': 'PENDING'},
        {'id': 't2', 'name': 'other', 'status': None},
    ]


# ---------------------------------------------------------------------------
# connection_info：RKB_DB_* 是连接参数的唯一来源
# ---------------------------------------------------------------------------

def test_conn_info_blank_values_fall_back_to_psycopg2_defaults(monkeypatch):
    for name in ('RKB_DB_HOST', 'RKB_DB_PORT', 'RKB_DB_NAME', 'RKB_DB_USER',
                 'RKB_DB_PASSWORD'):
        monkeypatch.delenv(name, raising=False)
    info = connection_info.get_db_conn_info()
    assert info['host'] is None and info['port'] is None
    assert info['user'] is None
    assert info['database'] == connection_info.DEFAULT_DB_NAME
    assert info['password'] == ''
    assert info['driver'] == 'psycopg2'


def test_conn_info_whitespace_and_explicit_values(monkeypatch):
    monkeypatch.setenv('RKB_DB_HOST', '  db.internal  ')
    monkeypatch.setenv('RKB_DB_PORT', '5433')
    monkeypatch.setenv('RKB_DB_NAME', '  ')
    monkeypatch.setenv('RKB_DB_USER', 'scott')
    monkeypatch.setenv('RKB_DB_PASSWORD', 'tiger')
    info = connection_info.get_db_conn_info()
    assert info['host'] == 'db.internal'
    assert info['port'] == '5433'
    assert info['database'] == connection_info.DEFAULT_DB_NAME
    assert info['user'] == 'scott'
    assert info['password'] == 'tiger'
