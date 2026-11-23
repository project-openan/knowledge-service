"""``operator_store`` 的 SQL 口径测试（假连接，不连库）。

用内存游标记下每条 SQL 与参数，钉住的是**语句形状**：

* 分页查询**没有 ORDER BY**（顺序由 PG 堆序决定，加排序是行为变更）；
* ``visible_range`` 三分支的过滤条件；
* ``operatorIds`` 空列表在两个重载里的**不同**语义（分页「不过滤」、published「直接空」）；
* 删除是**物理删除**，先删 param/prop 再删主行。

跑法（服务目录下）::

    python -m pytest tests/test_operator_store_gateway.py -q
"""

import pytest

from shared.errors.api import KbStoreError
from operators.repository import operator_store


class _FakeCursor:
    """记 SQL 与参数；fetchall/fetchone/description 由用例给。"""

    def __init__(self, fetchall=(), fetchone=None, description=None):
        self.queries = []
        self._fetchall = list(fetchall)
        self._fetchone = fetchone
        self.description = description

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        self.queries.append((sql, params))

    def fetchall(self):
        return list(self._fetchall)

    def fetchone(self):
        return self._fetchone


class _FakeConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self._cursor


def _row_cursor(rows, columns=None):
    """把 dict 行转成带 description 的游标（``_rows`` 需要列名）。

    列名缺省取首行的键序 —— 与 psycopg2 按 ``cursor.description`` 配列名一致。
    """
    if columns is None:
        columns = list(rows[0].keys()) if rows else []
    return _FakeCursor(fetchall=[tuple(row[column] for column in columns) for row in rows],
                       description=[(column,) for column in columns])


@pytest.fixture()
def conn(monkeypatch):
    """装一个可换内容的假连接，返回游标供断言。"""
    holder = {}

    def _install(cursor):
        holder['cursor'] = cursor
        monkeypatch.setattr(operator_store, 'connection', lambda: _FakeConnection(cursor))

    holder['install'] = _install
    return holder


@pytest.fixture()
def no_db(monkeypatch):
    """一碰连接就炸 —— 用来证明「空 id 集根本不发 SQL」。"""
    def _boom():
        raise AssertionError('空入参不该访问数据库')

    monkeypatch.setattr(operator_store, 'connection', _boom)


# ----------------------------------------------------------------------
# 过滤条件拼装
# ----------------------------------------------------------------------


def test_visible_clause_three_branches():
    public = operator_store._visible_clause('public', 'u1')
    private = operator_store._visible_clause('private', 'u1')
    default = operator_store._visible_clause(None, 'u1')

    assert public == (" AND visible_range = 'public'", [])
    assert private == (' AND created_by = %s', ['u1'])
    # 默认分支：公开的 + 我自己私有的
    assert 'visible_range = \'public\' OR' in default[0]
    assert default[1] == ['u1']


def test_common_filters_stack_ids_module_org_keyword(conn):
    sql, params = operator_store._common_filters([1, 2], 'k', 'text_split', 'org-1')

    assert 'AND id = ANY(%s)' in sql
    assert 'AND module = %s' in sql
    assert 'AND org_id = %s' in sql
    assert 'name ILIKE' in sql
    assert params == [[1, 2], 'text_split', 'org-1', '%k%', '%k%']


# ----------------------------------------------------------------------
# 分页与计数
# ----------------------------------------------------------------------


def test_search_operators_appends_limit_offset_after_filters(conn):
    cursor = _row_cursor([{'id': 1, 'name': 'a'}])
    conn['install'](cursor)

    rows = operator_store.search_operators(None, None, '', 'text_split', None, 'u1',
                                           limit=50, offset=100)

    assert rows == [{'id': 1, 'name': 'a'}]
    sql, params = cursor.queries[0]
    assert 'SELECT * FROM operator' in sql
    assert 'ORDER BY' not in sql, '列表查询没有任何 ORDER BY（行为契约）'
    assert sql.endswith('LIMIT %s OFFSET %s')
    # 过滤参数在前，limit/offset 固定收尾
    assert params[-2:] == [50, 100]


def test_count_operators_returns_int(conn):
    cursor = _FakeCursor(fetchone=(7,))
    conn['install'](cursor)

    assert operator_store.count_operators(None, None, '', '', None, 'u1') == 7
    sql, _ = cursor.queries[0]
    assert 'SELECT count(*) FROM operator' in sql


# ----------------------------------------------------------------------
# published 重载：空列表直接返回空
# ----------------------------------------------------------------------


def test_select_published_by_condition_empty_ids_short_circuits(no_db):
    """空 ``operatorIds`` → **直接空列表**（不发 SQL）—— 分页重载里空列表是「不过滤」，
    两个重载语义相反，这正是要钉住的地方。"""
    assert operator_store.select_published_by_condition([], 'k', 'text_split', 'org-1', 'u1') == []


def test_select_published_by_condition_forces_published(conn):
    cursor = _row_cursor([{'id': 3, 'name': 'c'}])
    conn['install'](cursor)

    rows = operator_store.select_published_by_condition([3], None, 'text_split', None, 'u1')

    assert rows == [{'id': 3, 'name': 'c'}]
    sql, params = cursor.queries[0]
    assert 'WHERE is_published' in sql
    assert list(params[0]) == [3]


# ----------------------------------------------------------------------
# 单条/按列查询
# ----------------------------------------------------------------------


def test_select_by_module_with_and_without_org(conn):
    cursor = _row_cursor([], columns=('id',))
    conn['install'](cursor)

    assert operator_store.select_by_module('text_split') == []
    sql1, params1 = cursor.queries[0]
    assert 'org_id' not in sql1 and params1 == ['text_split']

    operator_store.select_by_module('text_split', 'org-2')
    sql2, params2 = cursor.queries[1]
    assert 'AND org_id = %s' in sql2 and params2 == ['text_split', 'org-2']


def test_select_by_id_found_and_missing(conn):
    cursor = _row_cursor([{'id': 1, 'name': 'a'}])
    conn['install'](cursor)

    assert operator_store.select_by_id(1) == {'id': 1, 'name': 'a'}
    cursor.queries.clear()
    cursor._fetchall = []
    assert operator_store.select_by_id(2) is None


def test_select_by_name_checks_zh_only(conn):
    cursor = _row_cursor([])
    conn['install'](cursor)

    assert operator_store.select_by_name('甲') == []
    sql, params = cursor.queries[0]
    assert 'name = %s' in sql and list(params) == ['甲']

    operator_store.select_by_name('甲', 'org-1')
    sql2, params2 = cursor.queries[1]
    assert 'AND org_id = %s' in sql2 and list(params2) == ['甲', 'org-1']


def test_select_by_creator_scopes_by_emp_no(conn):
    cursor = _row_cursor([{'id': 1, 'name': 'a'}])
    conn['install'](cursor)

    assert operator_store.select_by_creator(1, 'me') == {'id': 1, 'name': 'a'}
    _, params = cursor.queries[0]
    assert list(params) == [1, 'me']


def test_select_by_org_id_without_org_has_no_org_filter(conn):
    cursor = _row_cursor([{'id': 1}])
    conn['install'](cursor)

    assert operator_store.select_by_org_id(1, None) == {'id': 1}
    sql, params = cursor.queries[0]
    assert 'org_id' not in sql and list(params) == [1]

    operator_store.select_by_org_id(1, 'org-1')
    sql2, params2 = cursor.queries[1]
    assert 'AND org_id = %s' in sql2 and list(params2) == [1, 'org-1']


def test_list_params_by_operator_id_ordered(conn):
    cursor = _row_cursor([{'operator_id': 1, 'arg_name': 'k'}])
    conn['install'](cursor)

    rows = operator_store.list_params_by_operator_id(1)
    assert rows == [{'operator_id': 1, 'arg_name': 'k'}]
    sql, _ = cursor.queries[0]
    assert 'ORDER BY id' in sql


def test_list_props_by_operator_id_maps_name_to_value(conn):
    cursor = _FakeCursor(fetchall=[('position', 'p1'), ('operator', 'Op')],
                         description=None)
    conn['install'](cursor)

    assert operator_store.list_props_by_operator_id(1) == {'position': 'p1', 'operator': 'Op'}


def test_select_ids_by_format_is_substring_like(conn):
    """``prop_value LIKE '%fmt%'``：子串匹配（不是集合成员判断）。"""
    cursor = _FakeCursor(fetchall=[(1,), (2,)], description=None)
    conn['install'](cursor)

    assert operator_store.select_ids_by_format('md') == [1, 2]
    sql, params = cursor.queries[0]
    assert "prop_name = 'support_format'" in sql
    assert list(params) == ['%md%']


# ----------------------------------------------------------------------
# 批量分组查询
# ----------------------------------------------------------------------


def test_list_params_by_operator_ids_empty_ids_never_queries(no_db):
    assert operator_store.list_params_by_operator_ids([]) == {}


def test_list_params_by_operator_ids_groups_by_operator(conn):
    cursor = _row_cursor([
        {'operator_id': 1, 'arg_name': 'a'},
        {'operator_id': 1, 'arg_name': 'b'},
        {'operator_id': 2, 'arg_name': 'c'},
    ])
    conn['install'](cursor)

    grouped = operator_store.list_params_by_operator_ids([1, 2])

    assert [row['arg_name'] for row in grouped[1]] == ['a', 'b']
    assert [row['arg_name'] for row in grouped[2]] == ['c']
    _, params = cursor.queries[0]
    assert list(params[0]) == [1, 2]


def test_list_props_by_operator_ids_empty_ids_never_queries(no_db):
    assert operator_store.list_props_by_operator_ids([]) == {}


def test_list_props_by_operator_ids_groups_rows(conn):
    cursor = _FakeCursor(fetchall=[(1, 'position', 'p1'), (2, 'operator', 'Op')],
                         description=None)
    conn['install'](cursor)

    assert operator_store.list_props_by_operator_ids([1, 2]) == {
        1: {'position': 'p1'}, 2: {'operator': 'Op'}}


# ----------------------------------------------------------------------
# 状态翻转与删除
# ----------------------------------------------------------------------


def test_fill_last_updated_with_and_without_user(conn):
    cursor = _FakeCursor()
    conn['install'](cursor)

    operator_store._fill_last_updated(cursor, 1, 'me')
    sql1, params1 = cursor.queries[0]
    assert 'updated_by = %s' in sql1 and list(params1) == ['me', 1]

    operator_store._fill_last_updated(cursor, 1, None)
    sql2, params2 = cursor.queries[1]
    assert 'updated_by' not in sql2 and list(params2) == [1]


def test_set_publish_status_updates_then_touches_row(conn):
    cursor = _FakeCursor()
    conn['install'](cursor)

    operator_store.set_publish_status(1, 1, 'me')

    sql1, params1 = cursor.queries[0]
    assert 'SET is_published = %s' in sql1 and list(params1) == [True, 1]
    assert len(cursor.queries) == 2, '第二句刷 updated_at/updated_by'


def test_set_public_status_updates_then_touches_row(conn):
    cursor = _FakeCursor()
    conn['install'](cursor)

    operator_store.set_public_status(1, 'public', 'me')

    sql1, params1 = cursor.queries[0]
    assert 'SET visible_range = %s' in sql1 and list(params1) == ['public', 1]


def test_require_by_id_raises_store_error_when_missing(conn):
    cursor = _row_cursor([])
    conn['install'](cursor)

    with pytest.raises(KbStoreError) as excinfo:
        operator_store.require_by_id(404)
    assert excinfo.value.kind == KbStoreError.NOT_FOUND


def test_update_system_requires_existing_row(conn):
    cursor = _FakeCursor(fetchone=None, description=[])
    conn['install'](cursor)
    # require_by_id 走 select_by_id → 查不到 → 先抛，UPDATE 不发
    with pytest.raises(KbStoreError):
        operator_store.update_system(404, 'me')
    assert all('UPDATE operator SET system' not in sql for sql, _ in cursor.queries)


def test_update_system_sets_true_and_touches_row(conn):
    cursor = _FakeCursor()
    conn['install'](cursor)
    # select_by_id 由同一个游标服务：第一句 SELECT 要有返回
    original_execute = cursor.execute

    def _execute(sql, params=None):
        if sql.lstrip().upper().startswith('SELECT'):
            cursor._fetchall = [(1,)]
            cursor.description = [('id',)]
        original_execute(sql, params)

    cursor.execute = _execute

    operator_store.update_system(1, 'me')

    sql2, _ = cursor.queries[1]
    assert 'SET system = TRUE' in sql2


def test_delete_operator_is_physical_and_cascades(conn):
    cursor = _FakeCursor()
    conn['install'](cursor)

    operator_store.delete_operator(1)

    sqls = [sql for sql, _ in cursor.queries]
    assert sqls == [
        'DELETE FROM operator_param WHERE operator_id = %s',
        'DELETE FROM operator_prop WHERE operator_id = %s',
        'DELETE FROM operator WHERE id = %s',
    ]
