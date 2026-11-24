"""``knowledge_base/repository/directory.py`` 的分支覆盖。

不连库：``connection`` 换成按序吐结果的假游标，验证 SQL 形状与分支语义
（``get_parent_path`` 的三态、``update_file_status`` 的 fail_reason 保留、
``claim_file_for_retry`` 的原子认领、参数绑定顺序等）。

跑法（服务目录下）::

    python -m pytest tests/test_kb_repository_directory.py -q
"""

from __future__ import annotations

import pytest

from shared.errors.api import KbApiError
from knowledge_base.repository import directory as store


class _Cursor:
    """按序吐结果的假游标。

    答案形态：``('rows', [列名], [行元组])``（配 ``description`` 供 ``_rows`` 用）、
    ``('scalar', 值)``（fetchone 单列）、``('count', n)``（只设 rowcount）、
    ``('tuples', [行元组])``（fetchall 裸元组）。
    """

    def __init__(self, answers=()):
        self.answers = list(answers)
        self.calls = []
        self.rowcount = 0
        self.description = None
        self._current = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        self._current = self.answers.pop(0) if self.answers else None
        kind = self._current[0] if self._current else None
        if kind == 'rows':
            self.description = [(name,) for name in self._current[1]]
        elif kind == 'count':
            self.rowcount = self._current[1]

    def fetchone(self):
        kind = self._current[0] if self._current else None
        if kind == 'rows':
            data = list(self._current[2])
            return data.pop(0) if data else None
        if kind == 'scalar':
            return (self._current[1],)
        return None

    def fetchall(self):
        kind = self._current[0] if self._current else None
        if kind == 'rows':
            return list(self._current[2])
        if kind == 'tuples':
            return list(self._current[1])
        return []

    def executemany(self, sql, rows):
        self.calls.append((sql, list(rows)))


class _Conn:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self._cursor


def _patch(monkeypatch, answers=()):
    cursor = _Cursor(answers)
    monkeypatch.setattr(store, 'connection', lambda: _Conn(cursor))
    return cursor


# ----------------------------------------------------------------------
# new_id / get_parent_path
# ----------------------------------------------------------------------


def test_new_id_is_32_hex():
    value = store.new_id()
    assert len(value) == 32
    int(value, 16)


def test_get_parent_path_without_parent_is_root(monkeypatch):
    def _boom(*args, **kwargs):
        raise AssertionError('无父目录时不应查询')

    monkeypatch.setattr(store, 'connection', _boom)
    assert store.get_parent_path(_Cursor(), None) == store.ROOT_DIRECTORY_SYMBOL


def test_get_parent_path_appends_parent_id_and_spreads(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('rows', ['parent_path'], [('0-dir-1',)]),
        ('count', 1),
    ])

    assert store.get_parent_path(cursor, 'dir-2') == '0-dir-1-dir-2'
    assert len(cursor.calls) == 2
    assert 'can_spread = TRUE' in cursor.calls[1][0]
    assert cursor.calls[1][1] == ('dir-2',)


def test_get_parent_path_missing_parent_raises(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['parent_path'], [])])

    with pytest.raises(LookupError):
        store.get_parent_path(cursor, 'ghost')


# ----------------------------------------------------------------------
# 同名 / 层级判定的两个 DAO
# ----------------------------------------------------------------------


def test_find_folder_by_title_filters_by_parent(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('rows', ['id'], [('dir-1',)]),
        ('rows', ['id'], []),
    ])

    assert store.find_folder_by_title(cursor, 'kb', 'p1', '同名') == {'id': 'dir-1'}
    assert store.find_folder_by_title(cursor, 'kb', None, '同名') is None
    assert 'parent_id = %s' in cursor.calls[0][0]
    assert 'parent_id IS NULL' in cursor.calls[1][0]


def test_count_children_folders_both_branches(monkeypatch):
    cursor = _patch(monkeypatch, [('scalar', 3), ('scalar', 1)])

    assert store.count_children_folders(cursor, 'kb', 'p1') == 3
    assert store.count_children_folders(cursor, 'kb', None) == 1
    assert 'parent_id = %s' in cursor.calls[0][0]
    assert 'parent_id IS NULL' in cursor.calls[1][0]


# ----------------------------------------------------------------------
# 插入 / 更新
# ----------------------------------------------------------------------


def test_insert_directory_uses_given_id_and_fills_creator(monkeypatch):
    cursor = _patch(monkeypatch)

    returned = store.insert_directory(cursor, 'kb', 'p1', '0', '标题', store.TYPE_FOLDER,
                                      status=None, directory_id='fixed',
                                      created_by='admin', file_from='1')

    assert returned == 'fixed'
    sql, params = cursor.calls[0]
    assert params == ('fixed', 'kb', '标题', 'p1', '0', store.TYPE_FOLDER, None,
                      'admin', 'admin', '1')


def test_insert_directory_generates_id_when_absent(monkeypatch):
    cursor = _patch(monkeypatch)

    returned = store.insert_directory(cursor, 'kb', None, '0', '标题', store.TYPE_FILE,
                                      status=0)

    assert len(returned) == 32
    assert cursor.calls[0][1][0] == returned


def test_update_file_from(monkeypatch):
    cursor = _patch(monkeypatch)

    store.update_file_from(cursor, 'file-1', '2')

    assert cursor.calls[0][1] == ('2', 'file-1')


def test_update_title_touches_updated_at(monkeypatch):
    cursor = _patch(monkeypatch)

    store.update_title(cursor, 'dir-1', '新名')

    assert 'updated_at = NOW()' in cursor.calls[0][0]
    assert cursor.calls[0][1] == ('新名', 'dir-1')


# ----------------------------------------------------------------------
# 查询
# ----------------------------------------------------------------------


def test_get_children_orders_by_updated_at(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('rows', ['id'], [('a',)]),
        ('rows', ['id'], []),
        ('rows', ['id'], []),
    ])

    assert store.get_children('kb', None)[0]['id'] == 'a'
    store.get_children('kb', 'p1')
    store.get_children('kb', 'p1', store.TYPE_FILE)
    assert 'ORDER BY updated_at DESC' in cursor.calls[0][0]
    assert 'parent_id IS NULL' in cursor.calls[0][0]
    assert cursor.calls[1][1] == ['kb', 'p1']
    assert cursor.calls[2][1] == ['kb', 'p1', 'file']


def test_get_descendants_root_branch(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [('a',)]), ('rows', ['id'], [])])

    store.get_descendants('kb', None)
    store.get_descendants('kb', None, store.TYPE_FILE)
    assert 'WITH RECURSIVE' not in cursor.calls[0][0]
    assert cursor.calls[1][1] == ['kb', 'file']


def test_get_descendants_recursive_branch_param_order(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [])])

    store.get_descendants('kb', 'p1', store.TYPE_FILE)

    sql, params = cursor.calls[0]
    assert 'WITH RECURSIVE' in sql
    # kbase_id、parent_id、type（基础段）、kbase_id、type（递归段）
    assert params == ['kb', 'p1', 'file', 'kb', 'file']


def test_get_descendants_recursive_without_type_has_no_type_filter(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [])])

    store.get_descendants('kb', 'p1')

    assert cursor.calls[0][1] == ['kb', 'p1', 'kb']
    assert 'd.type' not in cursor.calls[0][0]


def test_delete_folders_empty_is_noop(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应连库')

    monkeypatch.setattr(store, 'connection', _boom)
    assert store.delete_folders(None, []) == 0


def test_delete_folders_reports_rowcount(monkeypatch):
    cursor = _patch(monkeypatch)
    cursor.rowcount = 2

    assert store.delete_folders(cursor, ['a', 'b']) == 2
    assert cursor.calls[0][1] == (['a', 'b'],)


def test_titles_by_ids_skips_empty_and_null_titles(monkeypatch):
    _patch(monkeypatch, [
        ('rows', ['title'], [('甲',), (None,)]),
    ])

    assert store.titles_by_ids('kb', []) == []
    assert store.titles_by_ids('kb', ['f1']) == ['甲']


def test_delete_files_empty_is_noop():
    assert store.delete_files(_Cursor(), 'kb', []) == 0


def test_delete_files_scopes_by_kbase(monkeypatch):
    cursor = _patch(monkeypatch)
    cursor.rowcount = 1

    assert store.delete_files(cursor, 'kb', ['f1']) == 1
    assert cursor.calls[0][1] == ('kb', ['f1'])


def test_get_files_by_ids_requires_ids(monkeypatch):
    def _boom():
        raise AssertionError('空 id 清单不应连库')

    monkeypatch.setattr(store, 'connection', _boom)
    assert store.get_files_by_ids([]) == []
    assert store.get_files_by_ids(['', None]) == []


def test_get_files_by_ids_optionally_filters_kbase(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [('f1',)]), ('rows', ['id'], [])])

    rows = store.get_files_by_ids(['f1'])
    assert rows[0]['id'] == 'f1'
    assert 'kbase_id' not in cursor.calls[0][0]

    store.get_files_by_ids(['f1'], kbase_id='kb')
    assert cursor.calls[1][1] == [['f1'], 'kb']


def test_get_directory_optional_type(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [('d1',)]), ('rows', ['id'], [])])

    row = store.get_directory('d1', 'kb')
    assert row == {'id': 'd1'}
    assert 'type' not in cursor.calls[0][0]

    assert store.get_directory('d1', 'kb', store.TYPE_FILE) is None
    assert cursor.calls[1][1] == ['d1', 'kb', 'file']


def test_get_all_folders_and_all_files_filter_by_type(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], []), ('rows', ['id'], [])])

    store.get_all_folders('kb')
    store.get_all_files('kb')
    assert "type = 'folder'" in cursor.calls[0][0]
    assert "type = 'file'" in cursor.calls[1][0]


# ----------------------------------------------------------------------
# 属性表
# ----------------------------------------------------------------------


def test_property_readers_need_ids(monkeypatch):
    def _boom():
        raise AssertionError('空 id 清单不应连库')

    monkeypatch.setattr(store, 'connection', _boom)
    assert store.get_properties([], 'KType') == {}
    assert store.get_all_properties([]) == {}


def test_get_properties_maps_file_id_to_value(monkeypatch):
    _patch(monkeypatch, [
        ('rows', ['file_id', 'prop_value'], [('f1', 'document'), ('f2', 'qa')]),
    ])

    assert store.get_properties(['f1', 'f2'], 'KType') == {'f1': 'document', 'f2': 'qa'}


def test_get_all_properties_groups_by_file_id(monkeypatch):
    _patch(monkeypatch, [
        ('rows', ['file_id', 'prop_name', 'prop_value'],
         [('f1', 'KType', 'document'), ('f1', 'file_size', '10')]),
    ])

    assert store.get_all_properties(['f1']) == {'f1': {'KType': 'document',
                                                       'file_size': '10'}}


def test_create_property_stringifies_scalar_values(monkeypatch):
    cursor = _patch(monkeypatch)

    store.create_property(cursor, 'kb', 'f1', 'file_size', 128)
    store.create_property(cursor, 'kb', 'f1', 'KType', None)

    assert cursor.calls[0][1][4] == '128'
    assert cursor.calls[1][1][4] is None
    assert 'INSERT INTO kb_directory_property' in cursor.calls[0][0]


def test_upsert_property_uses_on_conflict(monkeypatch):
    cursor = _patch(monkeypatch)

    store.upsert_property(cursor, 'kb', 'f1', 'file_size', 5)

    assert 'ON CONFLICT (file_id, prop_name) DO UPDATE' in cursor.calls[0][0]


def test_update_property_scopes_by_kbase(monkeypatch):
    cursor = _patch(monkeypatch)

    store.update_property(cursor, 'kb', 'f1', 'file_size', 7)

    assert cursor.calls[0][1] == ('7', 'kb', 'f1', 'file_size')


def test_delete_properties_by_file_ids(monkeypatch):
    cursor = _patch(monkeypatch)
    cursor.rowcount = 3

    assert store.delete_properties_by_file_ids('kb', ['f1', 'f2']) == 3
    assert store.delete_properties_by_file_ids('kb', []) == 0


# ----------------------------------------------------------------------
# 分页查询与 LIKE 转义
# ----------------------------------------------------------------------


def test_search_files_by_page_escapes_keyword(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], []), ('rows', ['id'], [])])

    store.search_files_by_page('kb', 'p1', 'a_b%c/d\\e', 10, 0)
    store.search_files_by_page('kb', None, None, 5, 5)

    assert cursor.calls[0][1][2] == 'a\\_b\\%c\\/d\\\\e'
    assert 'parent_id = %s' in cursor.calls[0][0]
    assert 'parent_id' not in cursor.calls[1][0]


def test_count_files_by_page_mirrors_search_where(monkeypatch):
    cursor = _patch(monkeypatch, [('scalar', 4), ('scalar', 0)])

    assert store.count_files_by_page('kb', None, 'kw') == 4
    assert store.count_files_by_page('kb', 'p1', None) == 0
    assert "type = 'file'" in cursor.calls[0][0]


def test_search_all_files_by_page_has_no_parent_filter(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], []), ('rows', ['id'], [])])

    store.search_all_files_by_page('kb', None, 10, 0)
    store.search_all_files_by_page('kb', 'kw', 10, 10)

    assert 'parent_id' not in cursor.calls[0][0]
    assert cursor.calls[1][1][-2:] == [10, 10]


def test_count_all_files(monkeypatch):
    _patch(monkeypatch, [('scalar', 9)])

    assert store.count_all_files('kb', None) == 9


def test_query_by_ktype_joins_property_table(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [])])

    store.query_by_ktype('kb', 'p1', 'document')

    sql, params = cursor.calls[0]
    assert "prop_name = 'KType'" in sql
    assert params == ('document', 'kb', 'p1')


def test_escape_like_covers_all_metacharacters():
    assert store._escape_like('a\\b_c%d/e') == 'a\\\\b\\_c\\%d\\/e'


# ----------------------------------------------------------------------
# 状态更新与重试认领
# ----------------------------------------------------------------------


def test_update_file_status_missing_row_raises(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [])])

    with pytest.raises(LookupError):
        store.update_file_status(cursor, 'ghost', 0)


def test_update_file_status_keeps_old_fail_reason_when_blank(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [('f1',)]), ('count', 1),
                                  ('rows', ['id'], [('f1',)]), ('count', 1)])

    store.update_file_status(cursor, 'f1', 2, '   ')
    store.update_file_status(cursor, 'f1', 0, None)

    for sql, _params in cursor.calls[1::2]:
        assert 'fail_reason' not in sql


def test_update_file_status_writes_fail_reason_when_given(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [('f1',)]), ('count', 1)])

    store.update_file_status(cursor, 'f1', 2, 'RetCode.operator.split.error')

    sql, params = cursor.calls[1]
    assert 'fail_reason = %s' in sql
    assert params == (2, 'RetCode.operator.split.error', 'f1')


def test_claim_file_for_retry_succeeds_only_when_row_returned(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], [('f1',)]), ('rows', ['id'], [])])

    assert store.claim_file_for_retry(cursor, 'f1') is True
    assert store.claim_file_for_retry(cursor, 'f1') is False
    sql, params = cursor.calls[0]
    assert 'WHERE id = %s AND status = %s RETURNING id' in sql
    assert params == (0, 'f1', 2)


# ----------------------------------------------------------------------
# 算子读取（文件链的支撑查询）
# ----------------------------------------------------------------------


def test_get_operator_found_and_missing(monkeypatch):
    _patch(monkeypatch, [
        ('rows', ['id', 'operator_path'], [(1, '/ops/a.py')]),
        ('rows', ['id'], []),
    ])

    assert store.get_operator(1)['operator_path'] == '/ops/a.py'
    assert store.get_operator(404) is None


def test_get_operator_props(monkeypatch):
    _patch(monkeypatch, [
        ('rows', ['prop_name', 'prop_value'], [('position', '1'), ('operator', 'x')]),
    ])

    assert store.get_operator_props(1) == {'position': '1', 'operator': 'x'}


def test_operator_python_path_missing_operator_is_none(monkeypatch):
    _patch(monkeypatch, [('rows', ['id'], [])])

    assert store.operator_python_path(404) is None


def test_operator_authorize_raises_for_missing_operator(monkeypatch):
    _patch(monkeypatch, [('rows', ['id'], [])])

    with pytest.raises(KbApiError) as caught:
        store.operator_authorize(404)

    assert caught.value.key == 'RetCode.operator.notfound'


def test_operator_authorize_returns_row(monkeypatch):
    _patch(monkeypatch, [('rows', ['id'], [(1,)])])

    assert store.operator_authorize(1) == {'id': 1}


def test_count_files_delegates_to_kbase_store(monkeypatch):
    from knowledge_base.repository import kbase as kbase_store

    monkeypatch.setattr(kbase_store, 'count_files', lambda kbase_id: 7)
    assert store.count_files('kb') == 7
