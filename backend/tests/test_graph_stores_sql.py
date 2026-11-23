"""四个 graph repository store 的 SQL 组装与行形状（假连接，不碰真库）。

覆盖：graph_schema_store / graph_extract_store / graph_import_store /
graph_delete_store。钉的是「SQL 里那条 WHERE / 那个列单」—— 拼错列名或漏条件
这类错误只有对着 SQL 文本才看得见。

跑法::

    python -m pytest tests/test_graph_stores_sql.py -q
"""

from __future__ import annotations

import json



class FakeCursor:
    def __init__(self, results=None, rowcount=1, description=None):
        self._results = list(results or [])
        self.rowcount = rowcount
        self.description = description or []
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchone(self):
        return self._results[0] if self._results else None

    def fetchall(self):
        rows, self._results = self._results, []
        return rows


class FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _install(monkeypatch, module, cursor):
    """把 `module.connection` 换成返回假连接。"""
    conn = FakeConn(cursor)
    monkeypatch.setattr(module, 'connection', lambda: conn)
    return conn


# ----------------------------------------------------------------------
# graph_schema_store
# ----------------------------------------------------------------------


def test_schema_store_get_by_id_parses_json_obj(monkeypatch):
    from graph.repository import graph_schema_store as store

    description = [(name,) for name in store.SCHEMA_COLUMNS]
    cursor = FakeCursor(results=[('s-1', '{"entities": []}', 'name', 'd', None,
                                  None, 'u', None, 0)],
                        description=description)
    _install(monkeypatch, store, cursor)
    row = store.get_schema_by_id('s-1')
    assert row['schema_obj'] == {'entities': []}
    sql, params = cursor.executed[0]
    assert 'FROM graph_schema WHERE schema_id = %s' in sql
    assert params == ('s-1',)

    cursor2 = FakeCursor(results=[], description=description)
    _install(monkeypatch, store, cursor2)
    assert store.get_schema_by_id('missing') is None


def test_schema_store_get_by_name_has_limit(monkeypatch):
    from graph.repository import graph_schema_store as store

    cursor = FakeCursor(results=[], description=[('schema_id',), ('schema_name',)])
    _install(monkeypatch, store, cursor)
    assert store.get_schema_by_name('x') is None
    sql, params = cursor.executed[0]
    assert 'LIMIT 1' in sql
    assert params == ('x',)


def test_schema_store_is_schema_exist_conditions(monkeypatch):
    from graph.repository import graph_schema_store as store

    cursor = FakeCursor(results=[(0,)])
    _install(monkeypatch, store, cursor)
    assert store.is_schema_exist('s-1', 'name') is False
    sql, params = cursor.executed[0]
    assert 'WHERE (schema_id = %s OR schema_name = %s)' in sql
    assert params == ['s-1', 'name']

    cursor = FakeCursor(results=[(3,)])
    _install(monkeypatch, store, cursor)
    assert store.is_schema_exist(None, 'name') is True
    sql, params = cursor.executed[0]
    assert 'schema_id' not in sql
    assert params == ['name']


def test_schema_store_list_by_user_filters_and_orders(monkeypatch):
    from graph.repository import graph_schema_store as store

    description = [(name,) for name in store.LIST_COLUMNS]
    cursor = FakeCursor(results=[('s-1', 'name', 'd', None, None, 'u', None, 0)],
                        description=description)
    _install(monkeypatch, store, cursor)
    rows = store.list_by_user('u1')
    assert rows[0]['schema_id'] == 's-1'
    sql, params = cursor.executed[0]
    assert 'WHERE (created_by = %s)' in sql
    assert 'ORDER BY created_at DESC' in sql
    assert 'schema_obj' not in sql.split('FROM')[0]
    assert params == ['u1']

    cursor = FakeCursor(results=[], description=description)
    _install(monkeypatch, store, cursor)
    store.list_by_user(None)
    assert 'WHERE' not in cursor.executed[0][0]


def test_schema_store_insert_serializes_schema_obj(monkeypatch):
    from graph.repository import graph_schema_store as store

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.insert_schema(None, 'name', 'desc', {'a': 1}, 'u')
    sql, params = cursor.executed[0]
    assert 'INSERT INTO graph_schema' in sql
    assert params == (None, '{"a": 1}', 'name', 'desc', 'u', 0)

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.insert_schema('s', 'n', 'd', 'raw-string', None)
    assert cursor.executed[0][1][1] == 'raw-string'
    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.insert_schema('s', 'n', 'd', None, None)
    assert cursor.executed[0][1][1] is None


def test_schema_store_delete_and_update(monkeypatch):
    from graph.repository import graph_schema_store as store

    cursor = FakeCursor(rowcount=1)
    _install(monkeypatch, store, cursor)
    assert store.delete_schema_by_id('s-1') == 1
    assert cursor.executed[0][1] == ('s-1',)

    cursor = FakeCursor(rowcount=0)
    _install(monkeypatch, store, cursor)
    assert store.update_schema('s-1', 'n', 'd', {'b': 2}, None) == 0
    sql, params = cursor.executed[0]
    assert params == ('{"b": 2}', 'n', 'd', '', 's-1')


def test_schema_store_parse_schema_obj_tolerates_garbage():
    from graph.repository.graph_schema_store import _parse_schema_obj

    assert _parse_schema_obj(None) is None
    assert _parse_schema_obj({'k': 1}) == {'k': 1}
    assert _parse_schema_obj([1]) == [1]
    assert _parse_schema_obj('["x"]') == ['x']
    assert _parse_schema_obj('oops') is None


# ----------------------------------------------------------------------
# graph_extract_store
# ----------------------------------------------------------------------


def test_extract_store_select_maps_to_domain_shape(monkeypatch):
    from graph.repository import graph_extract_store as store

    description = [(name,) for name in store.COLUMNS]
    cursor = FakeCursor(results=[('t-1', 'kb-1', 's-1', '5', 2, 'COMPLETED', 100,
                                  None, '/tmp/out', None, '2024', '2024', None, None)],
                        description=description)
    _install(monkeypatch, store, cursor)
    row = store.select_task('t-1')
    assert row['status'] == 'SUCCESS'          # COMPLETED → 领域态
    sql, params = cursor.executed[0]
    assert 'task_type = %s' in sql
    assert params == ('t-1', store.TASK_TYPE)

    cursor = FakeCursor(results=[], description=description)
    _install(monkeypatch, store, cursor)
    assert store.select_task('none') is None


def test_extract_store_insert_defaults_payload(monkeypatch):
    from graph.repository import graph_extract_store as store

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    task_id = store.insert_task('kb-1', 's-1', 5, 2)
    assert len(task_id) == 32
    sql, params = cursor.executed[0]
    assert params[1] == store.TASK_TYPE
    assert params[2] == store.LANE
    payload = json.loads(params[6])
    assert payload == {'schemaId': 's-1', 'operatorId': 5, 'fileCount': 2}


def test_extract_store_update_status_timestamps_by_state(monkeypatch):
    from graph.repository import graph_extract_store as store

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.update_task_status('t', store.STATUS_RUNNING, 30)
    sql, params = cursor.executed[0]
    assert 'start_time = NOW()' in sql
    assert params[:3] == ['RUNNING', 30, None]

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.update_task_status('t', store.STATUS_SUCCESS, 100)
    sql, params = cursor.executed[0]
    assert 'finish_time = NOW()' in sql and 'start_time' not in sql
    assert params[0] == 'COMPLETED'

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.update_task_status('t', 'INIT', 0)
    sql, _params = cursor.executed[0]
    assert 'start_time' not in sql and 'finish_time' not in sql


def test_extract_store_cancel_and_schema_id(monkeypatch):
    from graph.repository import graph_extract_store as store

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.cancel_task('t', reason='bye')
    sql, params = cursor.executed[0]
    assert "status = 'CANCELLED'" in sql
    assert "AND status = 'RUNNING'" in sql
    assert params == ('bye', 't', store.TASK_TYPE)

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.update_task_schema_id('t', 's-9')
    sql, params = cursor.executed[0]
    assert 'jsonb_set' in sql
    assert params == ('s-9', 't', store.TASK_TYPE)


# ----------------------------------------------------------------------
# graph_import_store
# ----------------------------------------------------------------------


def test_import_store_create_task_counts_all_zero(monkeypatch):
    from graph.repository import graph_import_store as store

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.create_task('t-1', 'graph_kb1', 's-1', payload={'zipPath': '/x'})
    sql, params = cursor.executed[0]
    assert params[1] == store.TASK_TYPE
    assert params[5] == 'kb1'                  # 统一表存**裸 id**
    payload = json.loads(params[6])
    assert payload['zipPath'] == '/x' and payload['schemaId'] == 's-1'
    extra = json.loads(params[7])
    assert extra['entity_total'] == 0 and extra['failed_records'] is None

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.create_task('t-2', 'kb1', 's-1', lane='graph_import_internal')
    assert cursor.executed[0][1][2] == 'graph_import_internal'


def test_import_store_update_status_writes_finish_time(monkeypatch):
    from graph.repository import graph_import_store as store

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.update_status('t', store.STATUS_COMPLETED, 'done')
    sql, params = cursor.executed[0]
    assert 'finish_time = NOW()' in sql
    assert params[:2] == ['COMPLETED', 'done']

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.update_status('t', store.STATUS_PROCESSING, None)
    sql, params = cursor.executed[0]
    assert 'finish_time' not in sql
    assert params[0] == 'RUNNING'

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.update_status('t', 'bogus')
    assert cursor.executed[0][1][0] == 'FAILED'


def test_import_store_update_progress_six_counters(monkeypatch):
    from graph.repository import graph_import_store as store
    from graph.service.graph_import_engine import Counters

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    entity, edge = Counters(), Counters()
    entity.total, entity.success, entity.failed = 5, 4, 1
    entity.failed_records = [{'id': 'x', 'error': 'e'}]
    edge.total, edge.success, edge.failed = 2, 2, 0
    store.update_progress('t', 50, entity, edge)
    sql, params = cursor.executed[0]
    assert params[0] == 50
    extra = json.loads(params[1])
    assert extra['entity_total'] == 5 and extra['edge_failed'] == 0
    assert extra['failed_records'] == [{'id': 'x', 'error': 'e'}]

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.update_progress('t', 100, Counters(), Counters())
    assert json.loads(cursor.executed[0][1][1])['failed_records'] is None


def test_import_store_select_task_rebuilds_view_shape(monkeypatch):
    from graph.repository import graph_import_store as store

    description = [('id',), ('kbase_id',), ('schema_id',), ('status',), ('progress',),
                   ('extra',), ('error_message',), ('created_at',), ('updated_at',)]
    cursor = FakeCursor(results=[('t', 'kb1', 's-1', 'COMPLETED', 100,
                                  {'entity_total': 2}, 'msg', 'c', 'u')],
                        description=description)
    _install(monkeypatch, store, cursor)
    row = store.select_task('t')
    assert row['kb_id'] == 'graph_kb1'         # 对外视图拼回前缀
    assert row['status'] == 'COMPLETED'
    assert row['entity_total'] == 2

    cursor = FakeCursor(results=[('t', None, None, 'RUNNING', 0, None, None, None, None)],
                        description=description)
    _install(monkeypatch, store, cursor)
    row = store.select_task('t')
    assert row['kb_id'] is None
    assert row['status'] == 'PROCESSING'
    assert row['entity_total'] == 0

    cursor = FakeCursor(results=[], description=description)
    _install(monkeypatch, store, cursor)
    assert store.select_task('none') is None


def test_import_store_cancel_and_abbrev(monkeypatch):
    from graph.repository import graph_import_store as store

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    store.cancel_task('t')
    sql, params = cursor.executed[0]
    assert "AND status = 'RUNNING'" in sql
    assert params[1:] == ('t', store.TASK_TYPE)
    assert store.abbrev(None) is None
    assert store.abbrev('x' * 10) == 'x' * 10
    assert len(store.abbrev('y' * (store.ERROR_MESSAGE_MAX + 5))) == store.ERROR_MESSAGE_MAX


def test_import_store_bare_kbase_id():
    from graph.repository.graph_import_store import _bare_kbase_id

    assert _bare_kbase_id('graph_kb1') == 'kb1'
    assert _bare_kbase_id('kb1') == 'kb1'


# ----------------------------------------------------------------------
# graph_delete_store
# ----------------------------------------------------------------------


def test_delete_store_names_and_tables():
    from graph.repository import graph_delete_store as store

    assert store.graph_db_name('kb1') == 'graph_kb1'
    assert store.chunk_table('kb1') == 'kb_index.graph_kb1_chunk'
    assert store.vector_table('kb1') == 'kb_index.graph_kb1_vector'


def test_delete_store_exists_checks_table_then_row(monkeypatch):
    from graph.repository import graph_delete_store as store

    cursor = FakeCursor(results=[(0,), (0,)])
    _install(monkeypatch, store, cursor)
    assert store.exists_knowledge_graph_info('graph_kb1') is False

    cursor = FakeCursor(results=[(1,), (2,)])
    _install(monkeypatch, store, cursor)
    assert store.exists_knowledge_graph_info('graph_kb1') is True
    sql2, params2 = cursor.executed[1]
    assert 'FROM graph_registry WHERE kb_id = %s' in sql2
    assert params2 == ('graph_kb1',)


def test_delete_store_delete_and_drop(monkeypatch):
    from graph.repository import graph_delete_store as store

    cursor = FakeCursor(rowcount=2)
    _install(monkeypatch, store, cursor)
    assert store.delete_knowledge_graph_info('graph_kb1') is None
    assert cursor.executed[0][1] == ('graph_kb1',)

    cursor = FakeCursor(rowcount=3)
    _install(monkeypatch, store, cursor)
    assert store.delete_import_tasks('kb1') == 3
    sql, params = cursor.executed[0]
    assert params == (store.IMPORT_TASK_TYPE, 'kb1')

    cursor = FakeCursor(rowcount=1)
    _install(monkeypatch, store, cursor)
    assert store.delete_extract_tasks('kb1') == 1
    assert cursor.executed[0][1] == (store.EXTRACT_TASK_TYPE, 'kb1')

    cursor = FakeCursor()
    _install(monkeypatch, store, cursor)
    assert store.drop_table_if_exists('kb_index.graph_kb1_chunk') is True
    assert 'DROP TABLE IF EXISTS' in cursor.executed[0][0]
