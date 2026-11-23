"""``knowledge_base/repository/kbase.py`` 的分支覆盖。

不连库：``connection`` 换成按序吐结果的假游标，验证 SQL 形状、排序白名单、
id 生成的查重循环、唯一索引冲突的业务化等。

跑法（服务目录下）::

    python -m pytest tests/test_kb_repository_kbase.py -q
"""

from __future__ import annotations

import psycopg2
import pytest

from shared.errors.api import KbStoreError
from knowledge_base.repository import kbase as store


class _Cursor:
    """按序吐结果的假游标（答案形态见 test_kb_repository_directory.py）。"""

    def __init__(self, answers=()):
        self.answers = list(answers)
        self.calls = []
        self.rowcount = 0
        self.description = None
        self._current = None
        self.fail_on_execute = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if self.fail_on_execute is not None:
            raise self.fail_on_execute
        self._current = self.answers.pop(0) if self.answers else None
        if self._current and self._current[0] == 'rows':
            self.description = [(name,) for name in self._current[1]]

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


def test_escape_like_covers_metacharacters():
    assert store._escape_like('a\\b%c_d') == 'a\\\\b\\%c\\_d'


# ----------------------------------------------------------------------
# kbaseId 生成
# ----------------------------------------------------------------------


def test_new_kbase_id_candidate_is_16_hex():
    value = store.new_kbase_id_candidate()
    assert len(value) == store.KBASE_ID_HEX_LENGTH
    int(value, 16)


def test_generate_kbase_id_returns_first_free_candidate(monkeypatch):
    _patch(monkeypatch, [('rows', ['?'], []), ('rows', ['?'], [])])

    first = store.generate_kbase_id()
    second = store.generate_kbase_id()

    assert len(first) == 16 and len(second) == 16


def test_generate_kbase_id_gives_up_after_max_attempts(monkeypatch):
    cursor = _patch(monkeypatch)

    for _ in range(store._KBASE_ID_MAX_ATTEMPTS):
        cursor.answers.append(('rows', ['?'], [('occupied',)]))

    with pytest.raises(RuntimeError):
        store.generate_kbase_id()


# ----------------------------------------------------------------------
# 基础查询
# ----------------------------------------------------------------------


def test_select_all_kbases_optionally_scopes_by_org(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['kbase_id'], []), ('rows', ['kbase_id'], [])])

    store.select_all_kbases()
    store.select_all_kbases('org-1')

    assert 'org_id' not in cursor.calls[0][0]
    assert cursor.calls[1][1] == ['org-1']


def test_select_kbase_by_id_found_and_missing(monkeypatch):
    _patch(monkeypatch, [
        ('rows', ['kbase_id'], [('kb-1',)]),
        ('rows', ['kbase_id'], []),
    ])

    assert store.select_kbase_by_id('kb-1') == {'kbase_id': 'kb-1'}
    assert store.select_kbase_by_id('ghost') is None


def test_count_files_counts_only_file_rows(monkeypatch):
    cursor = _patch(monkeypatch, [('scalar', 5)])

    assert store.count_files('kb') == 5
    assert "type = 'file'" in cursor.calls[0][0]


def test_count_files_by_kbase_ids_empty_map_without_ids(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应连库')

    monkeypatch.setattr(store, 'connection', _boom)
    assert store.count_files_by_kbase_ids([]) == {}


def test_count_files_by_kbase_ids_groups(monkeypatch):
    _patch(monkeypatch, [('rows', ['kbase_id', 'count'], [('kb', 3)])])

    assert store.count_files_by_kbase_ids(['kb']) == {'kb': 3}


def test_search_where_includes_all_filters(monkeypatch):
    where, params = store._search_where('deep', [1], 'bge', 'org-9')

    assert where.count('ILIKE') == 3          # name + description + created_by
    assert where.count('org_id') == 1
    assert where.count('embedding_model') == 1
    assert 'category = ANY' in where
    assert params == ['deep', 'deep', 'deep', 'org-9', 'bge', [1]]


def test_search_where_escapes_keyword_like_metacharacters():
    where, params = store._search_where('a%b', None, None, None)
    assert params == ['a\\%b', 'a\\%b', 'a\\%b']


def test_search_where_empty_keeps_no_filter():
    where, params = store._search_where('', None, None, None)
    assert where == ' WHERE 1=1'
    assert params == []


# ----------------------------------------------------------------------
# 排序
# ----------------------------------------------------------------------


def test_build_order_by_maps_known_keys(monkeypatch):
    from knowledge_base.service import kbase_service

    items = kbase_service._bind_order_list([
        {'key': 'name', 'ascending': True},
        {'key': 'createdDate', 'ascending': False},
        {'key': 'embeddingModel', 'ascending': None},     # ascending 缺 → 丢弃
        {'key': 'description', 'ascending': True},        # 无映射 → 丢弃
        {'key': None, 'ascending': True},                 # null key → 丢弃
    ])

    assert store.build_order_by(items) == (
        "convert_to(name,'GB18030'), created_at DESC")


def test_build_order_by_defaults_to_created_date_desc():
    assert store.build_order_by(None) == store.DEFAULT_ORDER_BY
    assert store.build_order_by([]) == store.DEFAULT_ORDER_BY


def test_bind_order_list_rejects_unknown_key():
    from knowledge_base.service import kbase_service

    with pytest.raises(ValueError):
        kbase_service._bind_order_list([{'key': 'nope', 'ascending': True}])


def test_search_kbases_appends_limit_and_offset(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['kbase_id'], [])])

    store.search_kbases('', None, None, None, limit=10, offset=20,
                        order_list=[{'key': 'id', 'ascending': True}])

    sql, params = cursor.calls[0]
    assert 'ORDER BY kbase_id' in sql
    assert params[-2:] == [10, 20]


def test_count_search_kbases(monkeypatch):
    _patch(monkeypatch, [('scalar', 2)])

    assert store.count_search_kbases('kw', None, None, None) == 2


def test_find_kbases_by_name_optional_filters(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['kbase_id'], []), ('rows', ['kbase_id'], []),
                                  ('rows', ['kbase_id'], [])])

    store.find_kbases_by_name('同名')
    store.find_kbases_by_name('同名', 'org')
    store.find_kbases_by_name('同名', 'org', exclude_id='kb-1')

    assert cursor.calls[0][1] == ['同名']
    assert cursor.calls[1][1] == ['同名', 'org']
    assert cursor.calls[2][1] == ['同名', 'org', 'kb-1']


# ----------------------------------------------------------------------
# 插入与删除
# ----------------------------------------------------------------------


def _insert_kwargs(**overrides):
    kwargs = dict(kbase_id='kb-1', name='demo', description='desc', kbase_type='document',
                  embedding_model='bge', table_name='doc_kb-1_vector',
                  es_index_name='doc_kb-1', category=1, status=0, file_count_limit=5000,
                  org_id='org', created_by='admin')
    kwargs.update(overrides)
    return kwargs


def test_insert_kbase_returns_pk(monkeypatch):
    cursor = _patch(monkeypatch, [('scalar', 42)])

    assert store.insert_kbase(**_insert_kwargs()) == 42
    sql, params = cursor.calls[0]
    assert 'RETURNING id' in sql
    assert params[0] == 'kb-1' and params[3] == 'desc'


def test_insert_kbase_translates_unique_violation(monkeypatch):
    cursor = _patch(monkeypatch)
    cursor.fail_on_execute = psycopg2.errors.UniqueViolation()

    with pytest.raises(KbStoreError) as caught:
        store.insert_kbase(**_insert_kwargs())

    assert caught.value.kind == KbStoreError.DUPLICATE


def test_delete_kbase_row(monkeypatch):
    cursor = _patch(monkeypatch)

    store.delete_kbase_row('kb-1')

    assert cursor.calls[0][1] == ('kb-1',)


def test_select_by_ids_splits_numeric_and_textual(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['kbase_id'], [])])

    store.select_by_ids(['12', 'kb-1', None, '  '])

    sql, params = cursor.calls[0]
    assert ' OR ' in sql
    assert params == [[12], ['kb-1', '  ']]


def test_select_by_ids_empty_returns_no_rows(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应连库')

    monkeypatch.setattr(store, 'connection', _boom)
    assert store.select_by_ids([]) == []
    assert store.select_by_ids([None]) == []


# ----------------------------------------------------------------------
# 发布状态与抽图链路的更新
# ----------------------------------------------------------------------


def test_set_kbase_status_modified_only_touches_publishing_states(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('rows', ['status'], [(store.STATUS_PUBLISHING,)]), ('count', 1),
        ('rows', ['status'], [(store.STATUS_PUBLISHED,)]), ('count', 1),
        ('rows', ['status'], [(store.STATUS_MODIFIED_AFTER_PUBLISH,)]),
        ('rows', ['status'], [(0,)]),
        ('rows', ['status'], []),
    ])

    store.set_kbase_status_modified('kb')
    store.set_kbase_status_modified('kb')
    store.set_kbase_status_modified('kb')     # 8：已是「已修改」→ 不动
    store.set_kbase_status_modified('kb')     # 其它状态 → 不动
    store.set_kbase_status_modified('kb')     # 行不存在 → 不动

    updates = [call for call in cursor.calls if call[0].startswith('UPDATE')]
    assert len(updates) == 2
    assert updates[0][1] == (store.STATUS_MODIFIED_AFTER_PUBLISH, 'kb')


def test_update_process_does_not_touch_updated_at(monkeypatch):
    cursor = _patch(monkeypatch)

    store.update_process('kb', '5', 40)

    sql, params = cursor.calls[0]
    assert 'updated_at' not in sql
    assert params == ('5', '40', 'kb')


def test_update_process_with_time_writes_operator(monkeypatch):
    cursor = _patch(monkeypatch)

    store.update_process_with_time('kb', '5', 40, emp_no='admin')

    sql, params = cursor.calls[0]
    assert 'updated_at = NOW()' in sql and 'updated_by = %s' in sql
    assert params == ('5', '40', 'admin', 'kb')


def test_update_fail_reason_writes_bilingual_json(monkeypatch):
    cursor = _patch(monkeypatch)

    store.update_fail_reason('kb', '失败', 'failed')

    sql, params = cursor.calls[0]
    assert '::jsonb' in sql
    assert params[0] == '{"zh_CN": "\\u5931\\u8d25", "en_US": "failed"}'
    assert params[1] == 'kb'


def test_update_operator_id_stores_integer(monkeypatch):
    cursor = _patch(monkeypatch)

    store.update_operator_id('9', 'kb')

    assert cursor.calls[0][1] == (9, 'kb')


def test_update_schema_null_payload_writes_null(monkeypatch):
    cursor = _patch(monkeypatch)

    store.update_schema('kb', 'schema-1', None)

    assert cursor.calls[0][1] == ('schema-1', None, 'kb')


def test_update_schema_dumps_payload(monkeypatch):
    cursor = _patch(monkeypatch)

    store.update_schema('kb', 'schema-1', {'entities': []})

    assert cursor.calls[0][1][1] == '{"entities": []}'
