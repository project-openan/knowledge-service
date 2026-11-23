"""DB 底座：连接池事务语义、PgDatabase 行为、动态表 DDL（全部用假连接，不连 PG）。"""

from __future__ import annotations

from contextlib import contextmanager

import pytest

from infrastructure.db import ddl, pool
from infrastructure.db import kb as kb_pool
from infrastructure.db.pg import PgDatabase


# ---------------------------------------------------------------------------
# 通用假连接
# ---------------------------------------------------------------------------

class FakeCursor:
    """带 description/rowcount/fetch 脚本的假游标。"""

    def __init__(self, description=None, fetch_ones=None, rowcounts=0):
        self.description = description or [('id',), ('name',)]
        self.sql = []
        self.params = []
        self._ones = list(fetch_ones or [])
        self.rowcount = rowcounts
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.sql.append(sql)
        self.params.append(params)

    def fetchone(self):
        return self._ones.pop(0) if self._ones else None

    def fetchall(self):
        return [('t1', 'demo'), ('t2', 'other')]

    def close(self):
        self.closed = True


class FakeConn:
    def __init__(self, cursor=None, closed=0):
        self._cursor = cursor or FakeCursor()
        self.commits = 0
        self.rollbacks = 0
        self.closes = 0
        self.closed = closed
        self.fail_commit = False

    def cursor(self):
        return self._cursor

    def commit(self):
        if self.fail_commit:
            raise RuntimeError('commit failed')
        self.commits += 1

    def rollback(self):
        if getattr(self, 'fail_rollback', False):
            raise RuntimeError('rollback failed')
        self.rollbacks += 1

    def close(self):
        self.closes += 1


# ---------------------------------------------------------------------------
# 连接池（db.kb）：库名、池边界、事务语义
# ---------------------------------------------------------------------------

def test_get_kbase_db_name_falls_back_to_default(monkeypatch):
    monkeypatch.delenv(kb_pool.ENV_DB_NAME, raising=False)
    assert kb_pool.get_kbase_db_name() == kb_pool.DEFAULT_DB_NAME
    monkeypatch.setenv(kb_pool.ENV_DB_NAME, '  ')
    assert kb_pool.get_kbase_db_name() == kb_pool.DEFAULT_DB_NAME
    monkeypatch.setenv(kb_pool.ENV_DB_NAME, 'kb_db')
    assert kb_pool.get_kbase_db_name() == 'kb_db'


def test_pool_bounds_parse_env_with_clamps(monkeypatch):
    for name in (kb_pool.ENV_POOL_MIN, kb_pool.ENV_POOL_MAX):
        monkeypatch.delenv(name, raising=False)
    assert kb_pool._pool_bounds() == (1, 10)               # 默认值

    monkeypatch.setenv(kb_pool.ENV_POOL_MIN, 'not-a-number')
    monkeypatch.setenv(kb_pool.ENV_POOL_MAX, '')
    assert kb_pool._pool_bounds() == (1, 10)               # 非法回落默认

    monkeypatch.setenv(kb_pool.ENV_POOL_MIN, '-5')
    monkeypatch.setenv(kb_pool.ENV_POOL_MAX, '4')
    assert kb_pool._pool_bounds() == (0, 4)                # min 下限 0

    monkeypatch.setenv(kb_pool.ENV_POOL_MIN, '9')
    monkeypatch.setenv(kb_pool.ENV_POOL_MAX, '0')
    assert kb_pool._pool_bounds() == (1, 1)                # max 下限 1 且截住 min


class FakePool:
    def __init__(self):
        self.conns = [FakeConn()]
        self.put = []
        self.closeall_fails = False
        self.closed_all = False

    def getconn(self):
        return self.conns.pop(0)

    def putconn(self, conn, close=False):
        self.put.append((conn, close))

    def closeall(self):
        if self.closeall_fails:
            raise RuntimeError('already closed')
        self.closed_all = True


def _use_pool(monkeypatch, fake_pool):
    monkeypatch.setattr(kb_pool, '_POOLS', {'kb_db': fake_pool})
    monkeypatch.setenv(kb_pool.ENV_DB_NAME, 'kb_db')
    return fake_pool


def test_get_pool_creates_threaded_pool_once(monkeypatch):
    created = []

    class FakeThreadedPool(FakePool):
        def __init__(self, minconn, maxconn, **kwargs):
            super().__init__()
            created.append((minconn, maxconn, kwargs))

    monkeypatch.setattr('psycopg2.pool.ThreadedConnectionPool', FakeThreadedPool)
    monkeypatch.setattr(kb_pool, '_POOLS', {})
    monkeypatch.setenv(kb_pool.ENV_DB_NAME, 'fresh_db')
    monkeypatch.setattr('infrastructure.db.connection_info.get_db_conn_info',
                        lambda: {'user': 'u', 'password': 'p', 'host': 'h',
                                 'port': '5432'})

    first = kb_pool._get_pool('fresh_db')
    second = kb_pool._get_pool('fresh_db')
    assert first is second                                 # 双检锁只建一次
    assert created == [(1, 10, {'user': 'u', 'password': 'p', 'host': 'h',
                                'port': '5432', 'database': 'fresh_db',
                                'connect_timeout': 2})]


def test_get_pool_double_check_returns_early(monkeypatch):
    """双检锁内层：拿到锁之前别人已建好池。"""
    import threading

    created = []

    class FakeThreadedPool(FakePool):
        def __init__(self, minconn, maxconn, **kwargs):
            super().__init__()
            created.append(1)

    monkeypatch.setattr('psycopg2.pool.ThreadedConnectionPool', FakeThreadedPool)
    monkeypatch.setattr(kb_pool, '_POOLS', {})
    monkeypatch.setenv(kb_pool.ENV_DB_NAME, 'double_db')
    monkeypatch.setattr('infrastructure.db.connection_info.get_db_conn_info',
                        lambda: {'user': 'u', 'password': 'p', 'host': 'h',
                                 'port': '5432'})

    class _UnlockingLock:
        def __init__(self, on_enter):
            self._on_enter = on_enter

        def __enter__(self):
            self._on_enter()
            return self

        def __exit__(self, *exc):
            return False

    import contextlib

    @contextlib.contextmanager
    def _releasing_lock():
        marker = threading.Lock()
        marker.acquire()

        def _on_enter():
            kb_pool._POOLS['double_db'] = 'prefetched'

        # 第一次 `with` 直接由测试控制：包装模块锁会破坏其它用例，改为直接调用
        raise AssertionError('unused')

    # 直接模拟：外检未命中（空 dict）→ 进锁 → 锁内回填 → 内检命中
    class FakePoolLock:
        def __enter__(self):
            kb_pool._POOLS['double_db'] = 'prefetched'
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(kb_pool, '_POOL_LOCK', FakePoolLock())
    assert kb_pool._get_pool('double_db') == 'prefetched'
    assert created == []                                   # 未真正建池


def test_close_pools_swallows_closeall_failures(monkeypatch):
    good, bad = FakePool(), FakePool()
    bad.closeall_fails = True
    monkeypatch.setattr(kb_pool, '_POOLS', {'a': good, 'b': bad})
    kb_pool.close_pools()
    assert good.closed_all and bad.closed_all is False     # 失败只告警
    assert kb_pool._POOLS == {}


def test_connection_commits_and_returns_conn(monkeypatch):
    pool_obj = _use_pool(monkeypatch, FakePool())
    with kb_pool.connection() as conn:
        conn.cursor().execute('SELECT 1')
    assert pool_obj.conns == []
    put_conn, put_close = pool_obj.put[0]
    assert put_conn.commits == 1 and put_close is False


def test_connection_rolls_back_and_reraises(monkeypatch):
    pool_obj = _use_pool(monkeypatch, FakePool())
    with pytest.raises(RuntimeError, match='boom'):
        with kb_pool.connection():
            raise RuntimeError('boom')
    conn, put_close = pool_obj.put[0]
    assert conn.rollbacks == 1 and put_close is False


def test_connection_keeps_original_error_when_rollback_fails(monkeypatch):
    pool_obj = _use_pool(monkeypatch, FakePool())
    with pytest.raises(RuntimeError, match='the real cause'):
        with kb_pool.connection():
            raise RuntimeError('the real cause')
    conn, put_close = pool_obj.put[0]
    assert put_close is False


def test_connection_destroys_conn_when_commit_fails(monkeypatch):
    pool_obj = _use_pool(monkeypatch, FakePool())
    failing = FakeConn()
    failing.fail_commit = True
    pool_obj.conns = [failing]
    with pytest.raises(RuntimeError, match='commit failed'):
        with kb_pool.connection():
            pass                               # 正常退出 → commit 失败
    conn, put_close = pool_obj.put[0]
    assert put_close is True                               # 坏连接不回池


def test_connection_returns_closed_conn_with_close_flag(monkeypatch):
    pool_obj = _use_pool(monkeypatch, FakePool())
    pool_obj.conns = [FakeConn(closed=1)]
    with kb_pool.connection():
        pass
    _conn, put_close = pool_obj.put[0]
    assert put_close is True                               # 已断的连接直接销毁


# ---------------------------------------------------------------------------
# PgDatabase（db.pg）
# ---------------------------------------------------------------------------

def _patch_psycopg2(monkeypatch, conn=None, error=None):
    import psycopg2

    def fake_connect(**kwargs):
        if error is not None:
            raise error
        return conn

    monkeypatch.setattr(psycopg2, 'connect', fake_connect)


def test_pg_database_get_conn_reuses_open_connection(monkeypatch):
    conn = FakeConn()
    client = PgDatabase('db', 'h', '5432', 'u', 'p')
    _patch_psycopg2(monkeypatch, conn)
    assert client.get_conn() is conn
    assert client.get_conn() is conn                       # 复用同一条连接

    conn.closed = 1
    second = FakeConn()
    _patch_psycopg2(monkeypatch, second)
    assert client.get_conn() is second                     # 断开后重连


def test_pg_database_commit_rollback_close_ignore_closed_conn():
    client = PgDatabase('db', 'h', '5432', 'u', 'p')
    client.commit()                                        # 没有连接 → 空操作
    client.rollback()
    client.close()

    conn = FakeConn()
    client._connection = conn
    client.commit()
    client.rollback()
    client.close()
    assert (conn.commits, conn.rollbacks, conn.closes) == (1, 1, 1)

    conn.closed = 1
    client.commit()
    client.rollback()
    client.close()
    assert (conn.commits, conn.rollbacks, conn.closes) == (1, 1, 1)


def test_pg_database_execute_query_maps_rows(monkeypatch):
    cursor = FakeCursor(description=[('id',), ('name',)])
    conn = FakeConn(cursor)
    _patch_psycopg2(monkeypatch, conn)

    client = PgDatabase('db', 'h', '5432', 'u', 'p')
    rows = client.execute_query('SELECT * FROM t', ('x',))
    assert rows == [{'id': 't1', 'name': 'demo'}, {'id': 't2', 'name': 'other'}]
    assert cursor.closed and not conn.closes               # 连接保持复用


def test_pg_database_execute_query_without_description(monkeypatch):
    cursor = FakeCursor()
    cursor.description = None
    conn = FakeConn(cursor)
    _patch_psycopg2(monkeypatch, conn)
    client = PgDatabase('db', 'h', '5432', 'u', 'p')
    assert client.execute_query('UPDATE t SET x=1') == []


def test_pg_database_execute_query_error_closes_cursor(monkeypatch):
    class BrokenCursor(FakeCursor):
        def execute(self, sql, params=None):
            raise RuntimeError('bad sql')

    conn = FakeConn(BrokenCursor())
    _patch_psycopg2(monkeypatch, conn)
    client = PgDatabase('db', 'h', '5432', 'u', 'p')
    with pytest.raises(RuntimeError, match='bad sql'):
        client.execute_query('SELECT 1')
    assert conn._cursor.closed


def test_pg_database_execute_commits_and_rollbacks(monkeypatch):
    cursor = FakeCursor()
    conn = FakeConn(cursor)
    _patch_psycopg2(monkeypatch, conn)
    client = PgDatabase('db', 'h', '5432', 'u', 'p')

    client.execute('UPDATE t SET x=1')
    assert conn.commits == 1

    client.execute('UPDATE t SET x=2', commit=False)
    assert conn.commits == 1                               # 不自动提交

    class BrokenCursor(FakeCursor):
        def execute(self, sql, params=None):
            raise RuntimeError('write failed')

    conn2 = FakeConn(BrokenCursor())
    _patch_psycopg2(monkeypatch, conn2)
    failing_client = PgDatabase('db', 'h', '5432', 'u', 'p')
    with pytest.raises(RuntimeError, match='write failed'):
        failing_client.execute('UPDATE t SET x=3')
    assert conn2.rollbacks == 1


def test_pg_database_create_schema(monkeypatch):
    cursor = FakeCursor()
    conn = FakeConn(cursor)
    _patch_psycopg2(monkeypatch, conn)
    client = PgDatabase('db', 'h', '5432', 'u', 'p')
    client.create_pg_schema('kb_index')
    assert cursor.sql == ['CREATE SCHEMA IF NOT EXISTS kb_index;']


def test_database_operator_get_db_conn_passes_env_params(monkeypatch):
    seen = {}

    def fake_connect(**kwargs):
        seen.update(kwargs)
        return FakeConn()

    import psycopg2
    monkeypatch.setattr(psycopg2, 'connect', fake_connect)
    monkeypatch.setattr(pool, 'get_db_conn_info',
                        lambda: {'driver': 'psycopg2', 'host': 'h', 'port': '1',
                                 'database': 'd', 'user': 'u', 'password': 'p'})
    operator = pool.DatabaseOperator()
    assert operator.get_db_conn() is not None
    assert seen['connect_timeout'] == 2 and seen['database'] == 'd'
    assert 'driver' not in seen


# ---------------------------------------------------------------------------
# 动态表 DDL（db.ddl）
# ---------------------------------------------------------------------------

def _patch_ddl_conn(monkeypatch, cursor):
    conn = FakeConn(cursor)

    @contextmanager
    def _connection():
        yield conn

    monkeypatch.setattr(ddl, 'connection', _connection)
    return conn


def test_parse_vector_dimension_variants():
    assert ddl.parse_vector_dimension('vector(1024)') == 1024
    assert ddl.parse_vector_dimension(' VECTOR(2000) ') == 2000
    assert ddl.parse_vector_dimension('vector') is None
    assert ddl.parse_vector_dimension('') is None
    assert ddl.parse_vector_dimension(None) is None
    assert ddl.parse_vector_dimension('int4') is None


def test_ddl_ensure_schema_executes_idempotent_sql(monkeypatch):
    cursor = FakeCursor()
    _patch_ddl_conn(monkeypatch, cursor)
    ddl.ensure_schema()
    assert cursor.sql == ['CREATE SCHEMA IF NOT EXISTS kb_index']


def test_ddl_vector_dimension_reads_pg_and_tolerates_errors(monkeypatch):
    cursor = FakeCursor(fetch_ones=[('vector(768)',)])
    _patch_ddl_conn(monkeypatch, cursor)
    assert ddl.vector_dimension('doc_1_vector') == 768

    cursor = FakeCursor(fetch_ones=[(None,)])
    _patch_ddl_conn(monkeypatch, cursor)
    assert ddl.vector_dimension('doc_1_vector') is None    # 没有行

    cursor = FakeCursor(fetch_ones=[('int4',)])
    _patch_ddl_conn(monkeypatch, cursor)
    assert ddl.vector_dimension('doc_1_vector') is None    # 列不是 vector

    assert ddl.vector_dimension('bad name;') is None       # 非法标识符 → 不打库

    class BrokenConn:
        def cursor(self):
            raise RuntimeError('pg down')

    @contextmanager
    def _broken():
        yield BrokenConn()

    monkeypatch.setattr(ddl, 'connection', _broken)
    assert ddl.vector_dimension('doc_1_vector') is None


def test_ddl_table_exists(monkeypatch):
    cursor = FakeCursor(fetch_ones=[(True,)])
    _patch_ddl_conn(monkeypatch, cursor)
    assert ddl.table_exists('doc_1_vector') is True
    assert 'information_schema.tables' in cursor.sql[0]


def _capture_ddl(monkeypatch, exists=False):
    cursor = FakeCursor(fetch_ones=[(exists,)])
    conn = _patch_ddl_conn(monkeypatch, cursor)
    return cursor, conn


def test_ddl_create_vector_table_existing_and_new(monkeypatch):
    cursor, _conn = _capture_ddl(monkeypatch, exists=True)
    assert ddl.create_vector_table('doc_1_vector') is False   # 已存在 → 跳过

    cursor, _conn = _capture_ddl(monkeypatch, exists=False)
    assert ddl.create_vector_table('doc_1_vector', dimension=1024) is True
    assert 'CREATE TABLE IF NOT EXISTS kb_index.doc_1_vector' in cursor.sql[2]
    assert 'vector(1024)' in cursor.sql[2]
    assert 'USING hnsw' in cursor.sql[3]                   # 维度 ≤ 上限 → 建 HNSW


def test_ddl_create_vector_table_rejects_bad_dimension(monkeypatch):
    _capture_ddl(monkeypatch, exists=False)
    with pytest.raises(ValueError):                      # 0 会被回落成默认值，负数才炸
        ddl.create_vector_table('doc_1_vector', dimension=-1)


def test_ddl_create_vector_table_skips_hnsw_over_limit(monkeypatch, capsys):
    cursor, _conn = _capture_ddl(monkeypatch, exists=False)
    limit = ddl.HNSW_MAX_DIMENSIONS
    assert ddl.create_vector_table('doc_big_vector', dimension=limit + 1) is True
    joined = '\n'.join(cursor.sql)
    assert 'USING hnsw' not in joined                      # 超限不建 HNSW
    assert any('CREATE TABLE' in sql for sql in cursor.sql)


def test_ddl_create_chunk_and_graph_chunk_tables(monkeypatch):
    cursor, _conn = _capture_ddl(monkeypatch, exists=True)
    assert ddl.create_chunk_table('doc_1_chunk') is False  # 已存在 → 跳过
    cursor2, _conn2 = _capture_ddl(monkeypatch, exists=False)
    assert ddl.create_chunk_table('doc_1_chunk') is True
    cursor3, _conn3 = _capture_ddl(monkeypatch, exists=True)
    assert ddl.create_graph_chunk_table('graph_1_chunk') is False
    cursor2, _conn2 = _capture_ddl(monkeypatch, exists=False)
    assert ddl.create_graph_chunk_table('graph_1_chunk') is True
    graph_sql = '\n'.join(cursor2.sql)
    assert 'chunk_order' in graph_sql                      # 图谱契约字段在模板里


def test_ddl_drop_table_is_idempotent_sql(monkeypatch):
    cursor, _conn = _capture_ddl(monkeypatch)
    ddl.drop_table('doc_1_chunk')                          # 先 ensure_schema 再 DROP
    assert 'DROP TABLE IF EXISTS kb_index.doc_1_chunk;' == cursor.sql[-1]


def test_ddl_delete_by_node_ids_and_chunks(monkeypatch):
    cursor = FakeCursor()
    _patch_ddl_conn(monkeypatch, cursor)
    ddl.delete_by_node_ids('doc_1_vector', [])             # 空列表不打库
    assert cursor.sql == []

    cursor = FakeCursor()
    _patch_ddl_conn(monkeypatch, cursor)
    ddl.delete_by_node_ids('doc_1_vector', ['n1', 'n2'])
    assert 'node_id = ANY(%s)' in cursor.sql[0]

    cursor = FakeCursor()
    _patch_ddl_conn(monkeypatch, cursor)
    assert ddl.delete_chunks_by_source('doc_1_chunk', []) == 0

    cursor = FakeCursor(fetch_ones=[(False,)])
    _patch_ddl_conn(monkeypatch, cursor)
    assert ddl.delete_chunks_by_source('doc_1_chunk', ['a.md']) == 0  # 表不存在

    cursor = FakeCursor(fetch_ones=[(True,)], rowcounts=3)
    _patch_ddl_conn(monkeypatch, cursor)
    assert ddl.delete_chunks_by_source('doc_1_chunk', ['a.md']) == 3
