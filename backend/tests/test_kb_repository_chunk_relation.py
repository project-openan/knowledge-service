"""``knowledge_base/repository/chunk.py`` 与 ``node_relation.py`` 的分支覆盖。

不连库：``connection`` 换成按序吐结果的假游标、``ddl`` 的表级操作替换成记录器。
重点钉住：表名解析回退、metadata 展开列的拼装/还原、关系表批处理。

跑法（服务目录下）::

    python -m pytest tests/test_kb_repository_chunk_relation.py -q
"""

from __future__ import annotations

import pytest

from knowledge_base.repository import chunk as chunk_store
from knowledge_base.repository import node_relation as relation_store
from shared.chunk_schema import node_columns


class _Cursor:
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
    monkeypatch.setattr(chunk_store, 'connection', lambda: _Conn(cursor))
    return cursor


KB_DOC = {'kbase_id': 'kb1a2b3c4', 'table_name': 'doc_kb1a2b3c4_vector'}
KB_GRAPH = {'kbase_id': 'kb9f8e7d6c', 'table_name': 'graph_kb9f8e7d6c'}
KB_NO_TABLE = {'kbase_id': 'kb2b3c4d5', 'table_name': None}


# ----------------------------------------------------------------------
# 表名
# ----------------------------------------------------------------------


def test_vector_table_name_prefers_row_and_falls_back():
    assert chunk_store.vector_table_name(KB_DOC) == 'doc_kb1a2b3c4_vector'
    assert chunk_store.vector_table_name(KB_GRAPH) == 'graph_kb9f8e7d6c'
    assert chunk_store.vector_table_name(KB_NO_TABLE) == 'doc_kb2b3c4d5_vector'
    assert chunk_store.vector_table_name({'kbase_id': 'kb', 'table_name': '   '}) == \
        'doc_kb_vector'


def test_chunk_table_name_swaps_suffix():
    assert chunk_store.chunk_table_name(KB_DOC) == 'doc_kb1a2b3c4_chunk'
    assert chunk_store.chunk_table_name(KB_GRAPH) == 'graph_kb9f8e7d6c_chunk'


def test_index_from_sql_joins_chunk_table_for_supplement():
    from infrastructure.db.identifiers import SCHEMA as REAL_SCHEMA

    from_sql, text_expr = chunk_store.index_from_sql(KB_DOC)

    assert from_sql == (f'{REAL_SCHEMA}.doc_kb1a2b3c4_vector AS idx'
                        f' LEFT JOIN {REAL_SCHEMA}.doc_kb1a2b3c4_chunk AS chunk '
                        'ON idx.content_expand = chunk.id')
    assert text_expr == 'COALESCE(idx.text, chunk.text)'


def test_index_select_sql_prefixes_expanded_columns():
    from_sql, select = chunk_store.index_select_sql(KB_DOC)

    assert 'idx.source' in select
    assert 'idx.id' in select and 'idx.node_id' in select
    assert from_sql.startswith('kb_index.')


# ----------------------------------------------------------------------
# 向量索引表
# ----------------------------------------------------------------------


def test_query_by_node_id_returns_first_row_with_metadata(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('rows', ['id', 'text', 'node_id', 'source', 'content_expand', 'chunk_id', 'type'],
         [(7, '正文', 'node-1', 'a.md', 'chunk-1', 0, 1)]),
        ('rows', ['id', 'text', 'node_id', 'source', 'content_expand', 'chunk_id', 'type'],
         []),
    ])

    row = chunk_store.query_by_node_id(KB_DOC, 'node-1')
    assert row['metadata'] == {'source': 'a.md', 'content_expand': 'chunk-1',
                               'chunk_id': 0, 'type': 1}
    assert chunk_store.query_by_node_id(KB_DOC, 'ghost') is None


def test_query_page_by_keyword_uses_case_sensitive_like(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('scalar', 1),
        ('rows', ['id', 'text', 'node_id', 'source', 'content_expand', 'chunk_id', 'type'],
         []),
        ('scalar', 0),
        ('rows', ['id', 'text', 'node_id', 'source', 'content_expand', 'chunk_id', 'type'],
         []),
    ])

    rows, total = chunk_store.query_page_by_keyword(KB_DOC, 'kw', 1, 10)
    assert total == 1 and rows == []
    chunk_store.query_page_by_keyword(KB_DOC, None, 1, 10)
    sql, params = cursor.calls[0]
    assert ' LIKE %s' in sql and 'ILIKE' not in sql
    assert params == ['%kw%']
    sql, params = cursor.calls[2]
    assert params == []


def test_query_page_by_keyword_offset_never_negative(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('scalar', 0), ('rows', ['id'], []),
        ('scalar', 0), ('rows', ['id'], []),
    ])

    chunk_store.query_page_by_keyword(KB_DOC, None, 0, 10)     # page=0 → offset 0
    chunk_store.query_page_by_keyword(KB_DOC, None, 3, 10)

    assert cursor.calls[1][1][-2:] == [10, 0]
    assert cursor.calls[3][1][-2:] == [10, 20]


def test_update_index_writes_all_expanded_columns(monkeypatch):
    cursor = _patch(monkeypatch)

    chunk_store.update_index(KB_DOC, 5, '正文', {'source': 'a.md', 'type': 1}, [0.5])

    sql, params = cursor.calls[0]
    assert 'embedding = %s::vector' in sql
    assert params == ('正文', '[0.5]', 'a.md', None, None, 1, 5)


def test_insert_index_empty_rows_is_noop(monkeypatch):
    def _boom():
        raise AssertionError('空行清单不应连库')

    monkeypatch.setattr(chunk_store, 'connection', _boom)
    chunk_store.insert_index(KB_DOC, [])


def test_insert_index_executemany_per_row(monkeypatch):
    cursor = _patch(monkeypatch)

    chunk_store.insert_index(KB_DOC, [
        {'text': 't1', 'node_id': 'n1', 'embedding': [1.0, 2.0],
         'metadata': {'source': 'a.md', 'chunk_id': 3}},
        {'text': 't2', 'node_id': 'n2', 'embedding': [],
         'metadata': {}},
    ])

    sql, rows = cursor.calls[0]
    assert rows[0] == ('t1', 'n1', '[1.0,2.0]', 'a.md', None, 3, None)
    assert rows[1] == ('t2', 'n2', '[]', None, None, None, None)


def test_delete_by_node_ids_empty_is_noop(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应连库')

    monkeypatch.setattr(chunk_store, 'connection', _boom)
    chunk_store.delete_by_node_ids(KB_DOC, [])


def test_delete_by_node_ids_scopes_by_table(monkeypatch):
    cursor = _patch(monkeypatch)

    chunk_store.delete_by_node_ids(KB_GRAPH, ['n1', 'n2'])

    assert 'graph_kb9f8e7d6c' in cursor.calls[0][0]
    assert cursor.calls[0][1] == (['n1', 'n2'],)


def test_delete_chunk_by_id_returns_rowcount(monkeypatch):
    cursor = _patch(monkeypatch)
    cursor.rowcount = 1

    assert chunk_store.delete_chunk_by_id(KB_DOC, 'chunk-1') == 1
    assert 'doc_kb1a2b3c4_chunk' in cursor.calls[0][0]


# ----------------------------------------------------------------------
# 按文件（relation join 向量表）
# ----------------------------------------------------------------------


def test_count_by_file_optional_filters(monkeypatch):
    cursor = _patch(monkeypatch, [('scalar', 3), ('scalar', 0), ('scalar', 2)])

    assert chunk_store.count_by_file(KB_DOC, 'f1', 'kw') == 3
    assert chunk_store.count_by_file(KB_DOC, None, None) == 0
    assert chunk_store.count_by_file(KB_DOC, 'f1', None) == 2

    assert 'directory_id = %s' in cursor.calls[0][0]
    assert "1=1" in cursor.calls[1][0]
    assert 'ILIKE' in cursor.calls[0][0]


def test_count_all_returns_zero_when_table_missing(monkeypatch):
    monkeypatch.setattr(chunk_store, 'table_exists', lambda table: False)

    def _boom():
        raise AssertionError('表不存在时不应查询')

    monkeypatch.setattr(chunk_store, 'connection', _boom)
    assert chunk_store.count_all(KB_DOC) == 0


def test_count_all_counts_vector_rows(monkeypatch):
    monkeypatch.setattr(chunk_store, 'table_exists', lambda table: True)
    cursor = _patch(monkeypatch, [('scalar', 12)])

    assert chunk_store.count_all(KB_DOC) == 12
    assert 'count(*)' in cursor.calls[0][0]


def test_count_by_files_empty_is_noop(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应连库')

    monkeypatch.setattr(chunk_store, 'connection', _boom)
    assert chunk_store.count_by_files(KB_DOC, []) == {}


def test_count_by_files_groups_by_directory(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['directory_id', 'count'], [('f1', 4)])])

    assert chunk_store.count_by_files(KB_DOC, ['f1']) == {'f1': 4}


def test_list_by_file_orders_and_strips_meta_prefix(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('rows', ['chunk_id', 'directory_id', 'text', 'meta_source',
                  'meta_content_expand', 'meta_chunk_id', 'meta_type'],
         [(11, 'f1', '正文', 'a.md', 'chunk-9', 2, 1),
          (12, 'f1', '正文2', None, None, None, None)]),
        ('rows', ['chunk_id', 'directory_id', 'text', 'meta_source',
                  'meta_content_expand', 'meta_chunk_id', 'meta_type'], []),
    ])

    rows = chunk_store.list_by_file(KB_DOC, 'f1', None, 1, 10, chunk_id_asc=True)
    assert rows[0]['metadata'] == {'source': 'a.md', 'content_expand': 'chunk-9',
                                   'chunk_id': 2, 'type': 1}
    # 缺失列不凭空出现（JSON 时代的「键不存在」语义）
    assert rows[1]['metadata'] == {}
    for name in node_columns.EXPANDED_FIELDS:
        assert ('meta_' + name) not in rows[0]

    chunk_store.list_by_file(KB_DOC, 'f1', None, 1, 10)     # 默认倒序
    sql, params = cursor.calls[0]
    assert 'ORDER BY REL.id ASC' in sql
    assert 'REL.id AS chunk_id' in sql
    assert cursor.calls[1][0].find('ORDER BY REL.id DESC') > 0


def test_list_by_file_without_file_id_matches_all(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['chunk_id'], [])])

    chunk_store.list_by_file(KB_DOC, None, None, 1, 10)

    assert '1=1' in cursor.calls[0][0]


# ----------------------------------------------------------------------
# 切片表
# ----------------------------------------------------------------------


def test_query_by_chunk_ids_empty_is_noop(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应连库')

    monkeypatch.setattr(chunk_store, 'connection', _boom)
    assert chunk_store.query_by_chunk_ids(KB_DOC, []) == []


def test_query_by_chunk_ids_returns_metadata(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('rows', ['id', 'kb_id', 'text', 'source', 'content_expand', 'chunk_id', 'type',
                  'created_at', 'updated_at'],
         [('c1', 'kb', '正文', 'a.md', 'x', 1, 0, None, None)]),
    ])

    rows = chunk_store.query_by_chunk_ids(KB_DOC, ['c1'])

    assert rows[0]['metadata'] == {'source': 'a.md', 'content_expand': 'x',
                                   'chunk_id': 1, 'type': 0}
    assert 'WHERE id = ANY(%s)' in cursor.calls[0][0]


def test_update_chunk_text_never_touches_source_column(monkeypatch):
    cursor = _patch(monkeypatch)

    chunk_store.update_chunk_text(KB_DOC, 'c1', '新正文', {'source': 'a.md', 'type': 1})

    sql, params = cursor.calls[0]
    assert 'source' not in sql.replace('text', '')
    assert params == ('新正文', None, 1, 'c1')


def test_insert_chunk_uses_on_conflict_do_nothing(monkeypatch):
    cursor = _patch(monkeypatch)

    chunk_store.insert_chunk(KB_DOC, 'c1', 'kb', 'a.md', '正文')

    sql, params = cursor.calls[0]
    assert 'ON CONFLICT (id) DO NOTHING' in sql
    assert params == ('c1', 'kb', 'a.md', '正文')


# ----------------------------------------------------------------------
# 关系表（chunk 侧的两个轻封装）
# ----------------------------------------------------------------------


def test_select_relation_by_id(monkeypatch):
    cursor = _patch(monkeypatch, [
        ('rows', ['id', 'kbase_id', 'directory_id', 'node_id'],
         [(11, 'kb', 'f1', 'node-1')]),
        ('rows', ['id'], []),
    ])

    assert chunk_store.select_relation_by_id(11, 'kb')['node_id'] == 'node-1'
    assert chunk_store.select_relation_by_id(404, 'kb') is None


def test_select_relations_by_node_ids_optional_kbase(monkeypatch):
    cursor = _patch(monkeypatch, [('rows', ['id'], []), ('rows', ['id'], [])])

    chunk_store.select_relations_by_node_ids(['n1'])
    chunk_store.select_relations_by_node_ids(['n1'], kbase_id='kb')

    assert cursor.calls[0][1] == [['n1']]
    assert cursor.calls[1][1] == [['n1'], 'kb']


def test_delete_relation_by_pk(monkeypatch):
    cursor = _patch(monkeypatch)

    chunk_store.delete_relation(11)

    assert cursor.calls[0][1] == (11,)


# ----------------------------------------------------------------------
# node_relation.py
# ----------------------------------------------------------------------


def test_relation_select_needs_ids(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应连库')

    monkeypatch.setattr(relation_store, 'connection', _boom)
    assert relation_store.select_node_ids_by_directory_ids([]) == []


def test_relation_select_drops_blank_node_ids(monkeypatch):
    cursor = _Cursor([('rows', ['node_id'], [('n1',), (None,), ('',)])])
    monkeypatch.setattr(relation_store, 'connection', lambda: _Conn(cursor))

    assert relation_store.select_node_ids_by_directory_ids(['f1']) == ['n1']


def test_relation_delete_empty_returns_zero(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应连库')

    monkeypatch.setattr(relation_store, 'connection', _boom)
    assert relation_store.delete_by_directory_ids(1, []) == 0


def test_relation_delete_batches_vector_deletes(monkeypatch):
    pytest.importorskip('infrastructure.db.ddl')
    from infrastructure.db import ddl

    deleted = []
    monkeypatch.setattr(ddl, 'delete_by_node_ids',
                        lambda table, node_ids: deleted.append((table, list(node_ids))))
    monkeypatch.setattr(relation_store, 'RELATION_BATCH_SIZE', 2)
    cursor = _Cursor([
        ('rows', ['node_id'], [('n1',), ('n2',), ('n3',), ('n4',), ('n5',)]),
    ])
    cursor.rowcount = 5
    monkeypatch.setattr(relation_store, 'connection', lambda: _Conn(cursor))

    assert relation_store.delete_by_directory_ids(1, ['f1'], vector_table='doc_x_vector') == 5

    assert deleted == [('doc_x_vector', ['n1', 'n2']),
                       ('doc_x_vector', ['n3', 'n4']),
                       ('doc_x_vector', ['n5'])]
    assert 'DELETE FROM kb_node_relation' in cursor.calls[1][0]


def test_relation_delete_resolves_table_from_kbase_row(monkeypatch):
    from infrastructure.db import ddl

    deleted = []
    monkeypatch.setattr(ddl, 'delete_by_node_ids',
                        lambda table, node_ids: deleted.append((table, node_ids)))
    cursor = _Cursor([
        ('rows', ['node_id'], [('n1',)]),
        ('rows', ['table_name'], [('doc_kb1a2b3c4_vector',)]),
        ('count', 1),
    ])
    monkeypatch.setattr(relation_store, 'connection', lambda: _Conn(cursor))

    relation_store.delete_by_directory_ids(7, ['f1'])

    assert deleted == [('doc_kb1a2b3c4_vector', ['n1'])]


def test_resolve_vector_table_falls_back_to_doc_prefix(monkeypatch):
    cursor = _Cursor([
        ('rows', ['table_name'], [(None,)]),
        ('rows', ['table_name'], []),
    ])
    monkeypatch.setattr(relation_store, 'connection', lambda: _Conn(cursor))

    assert relation_store._resolve_vector_table(9) == 'doc_9_vector'
    assert relation_store._resolve_vector_table(404) == 'doc_404_vector'


def test_batch_insert_relations_empty_is_noop(monkeypatch):
    def _boom():
        raise AssertionError('空清单不应连库')

    monkeypatch.setattr(relation_store, 'connection', _boom)
    relation_store.batch_insert_relations('kb', 'f1', [])


def test_batch_insert_relations_chunks_by_batch_size(monkeypatch):
    cursor = _Cursor()
    monkeypatch.setattr(relation_store, 'connection', lambda: _Conn(cursor))
    monkeypatch.setattr(relation_store, 'RELATION_BATCH_SIZE', 2)

    relation_store.batch_insert_relations('kb', 'f1', ['n1', 'n2', 'n3'])

    assert len(cursor.calls) == 2
    assert cursor.calls[0][1] == [('kb', 'f1', 'n1'), ('kb', 'f1', 'n2')]
    assert cursor.calls[1][1] == [('kb', 'f1', 'n3')]
    assert 'ON CONFLICT (kbase_id, node_id) DO NOTHING' in cursor.calls[0][0]
