"""graph_index_store 的删改与切片装载路径（假连接 + 真 zip）。

补齐既有测试没碰的部分：``delete_*`` 家族、``replace_chunks``、
``_vector_table_empty``、``ensure_chunk_table``、``read_jsonl`` 的坏 zip、
``upsert_vectors`` 的 bulk/空行分支与 ``_embed_and_write`` 的进度回调。

跑法::

    python -m pytest tests/test_graph_index_store_pipeline.py -q
"""

from __future__ import annotations

import json
import zipfile

import pytest

from graph.repository import graph_index_store as store
from infrastructure.db import ddl


class FakeCursor:
    def __init__(self, results=None, rowcount=1):
        self._results = list(results or [])
        self.rowcount = rowcount
        self.executed = []
        self.description = []

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

    def executemany(self, sql, rows):
        for row in rows:
            self.executed.append((sql, row))


class FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture()
def conn(monkeypatch):
    holder = {}

    def install(cursor):
        fake = FakeConn(cursor)
        holder['conn'] = fake
        holder['cursor'] = cursor
        monkeypatch.setattr(store, 'connection', lambda: fake)
        return fake

    holder['install'] = install
    return holder


# ----------------------------------------------------------------------
# 纯函数
# ----------------------------------------------------------------------


def test_properties_text_skips_blank_and_none():
    assert store._properties_text({'a': 1, 'b': '  ', 'c': None}) == 'a: 1'
    assert store._properties_text('not a dict') == ''
    assert store._properties_text({}) == ''


def test_chunk_key_id_and_entity_key_id_strip():
    assert store.chunk_key_id({'id': ' c1 '}) == 'c1'
    assert store.entity_key_id({'entity_id': None}) == ''
    assert store.edge_key_id({'edge_id': 7}) == '7'


def test_smallint_rejects_bool_and_garbage():
    assert store._smallint(True) is None
    assert store._smallint(None) is None
    assert store._smallint('3') == 3
    assert store._smallint('system') is None
    assert store._smallint(2) == 2


def test_table_names():
    assert store.vector_table('g') == 'g_vector'
    assert store.chunk_table('g') == 'g_chunk'


# ----------------------------------------------------------------------
# 删除家族
# ----------------------------------------------------------------------


def test_delete_chunks_by_sources_cleans_vectors(monkeypatch, conn):
    state = {'table': True, 'vector': True, 'deleted': 3}

    def fake_table_exists(name):
        return state['table'] and (state['vector'] or 'vector' not in name)

    monkeypatch.setattr(ddl, 'table_exists', fake_table_exists)
    monkeypatch.setattr(ddl, 'delete_chunks_by_source', lambda table, sources: state['deleted'])

    cursor = FakeCursor(results=[('c1',), ('c2',)])
    conn['install'](cursor)
    deleted = store.delete_chunks_by_sources('g', ['a.md', 'b.md', ''])
    assert deleted == 3
    delete_sql, delete_params = cursor.executed[-1]
    assert 'key_type = %s AND key_id = ANY(%s)' in delete_sql
    assert delete_params == (store.KEY_TYPE_CHUNK, ['c1', 'c2'])

    # 没有命中向量行时不发 DELETE
    cursor = FakeCursor(results=[])
    conn['install'](cursor)
    assert store.delete_chunks_by_sources('g', ['a.md']) == 3
    assert len(cursor.executed) == 1

    # 空入参 / 表不存在 → 0
    assert store.delete_chunks_by_sources('g', []) == 0
    state['table'] = False
    assert store.delete_chunks_by_sources('g', ['a.md']) == 0


def test_chunk_ids_for_sources_requires_existing_table(monkeypatch, conn):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: 'vector' not in name)
    cursor = FakeCursor(results=[('c1',), (None,)])
    conn['install'](cursor)
    assert store.chunk_ids_for_sources('g', ['a.md']) == ['c1']
    assert store.chunk_ids_for_sources('g', []) == []
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    assert store.chunk_ids_for_sources('g', ['a.md']) == []


def test_delete_vector_keys_needs_table_and_ids(monkeypatch, conn):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: True)
    cursor = FakeCursor(rowcount=2)
    conn['install'](cursor)
    assert store.delete_vector_keys('g', store.KEY_TYPE_ENTITY, ['P1', '', 'P2']) == 2
    sql, params = cursor.executed[0]
    assert params == (store.KEY_TYPE_ENTITY, ['P1', 'P2'])

    assert store.delete_vector_keys('g', store.KEY_TYPE_ENTITY, []) == 0
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    assert store.delete_vector_keys('g', store.KEY_TYPE_ENTITY, ['P1']) == 0


def test_delete_edge_vectors_touching_matches_endpoints(monkeypatch, conn):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: True)
    cursor = FakeCursor(results=[
        ('K1', 'P1', 'C1'),
        ('K2', None, 'P9'),
        ('K3', 'X1', 'X2'),
        ('', 'P1', 'X2'),
    ])
    conn['install'](cursor)
    deleted = store.delete_edge_vectors_touching('g', ['P1'])
    # 命中的只有 K1：K2 的端点是 P9；空 key_id 的行不参与
    assert deleted == 1

    # 空入参 → 0；表不存在 → 0
    assert store.delete_edge_vectors_touching('g', []) == 0
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    assert store.delete_edge_vectors_touching('g', ['P1']) == 0


def test_delete_edge_vectors_touching_counts_expected(monkeypatch, conn):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: True)
    cursor = FakeCursor(results=[
        ('K1', 'P1', 'C1'),
        ('K2', 'P9', 'P1'),
        ('K3', 'X1', 'X2'),
    ], rowcount=2)
    conn['install'](cursor)
    # K1 与 K2 都有一端是 P1
    assert store.delete_edge_vectors_touching('g', ['P1']) == 2


def test_delete_source_graph_data_orchestrates(monkeypatch, conn):
    from graph.repository import graph_pg

    monkeypatch.setattr(graph_pg, 'new_client', lambda name: {'name': name})
    monkeypatch.setattr(graph_pg, 'graph_db_name', lambda kb: f'graph_{kb}')
    monkeypatch.setattr(graph_pg, 'delete_entities_by_chunk_ids',
                        lambda client, ids: ['P1', 'P2'])

    calls = []
    monkeypatch.setattr(store, 'delete_vector_keys',
                        lambda base, key_type, ids: calls.append((key_type, list(ids))) or 2)
    monkeypatch.setattr(store, '_delete_edge_vectors_touching',
                        lambda base, ids: calls.append(('touching', sorted(ids))) or 1)
    result = store.delete_source_graph_data('g', 'kb1', ['c1', 'c2'])
    assert result == {'entities': 2, 'edges': 1, 'chunks': 2}
    assert calls == [('entity', ['P1', 'P2']), ('touching', ['P1', 'P2']),
                     ('chunk', ['c1', 'c2'])]
    assert store.delete_source_graph_data('g', 'kb1', []) == {
        'entities': 0, 'edges': 0, 'chunks': 0}


def test_replace_chunks_deletes_sources_then_inserts(monkeypatch, conn):
    cursor = FakeCursor()
    conn['install'](cursor)
    records = [
        {'id': 'c1', 'source': 'a.md', 'chunk_id': '9', 'text': '正文', 'type': 'system',
         'label': 'L', 'table_name': 't', 'table_id': '1', 'chunk_index': '0',
         'content_expand': '扩', 'create_user': 'u', 'update_user': 'u'},
        {'id': '  ', 'source': 'a.md'},                      # 无 id → 跳过
    ]
    written = store.replace_chunks('g', 'kb1', records)
    assert written == 1
    delete_sql, delete_params = cursor.executed[0]
    assert 'DELETE FROM' in delete_sql and 'source = ANY(%s)' in delete_sql
    insert_sql, insert_params = cursor.executed[1]
    assert 'ON CONFLICT (id) DO NOTHING' in insert_sql
    assert insert_params[0] == 'c1'
    assert insert_params[2] == 'a.md'
    assert insert_params[5] == '扩'   # chunk_text 优先 content_expand

    assert store.replace_chunks('g', 'kb1', []) == 0


def test_replace_chunks_smallint_conversion(monkeypatch, conn):
    cursor = FakeCursor()
    conn['install'](cursor)
    store.replace_chunks('g', 'kb1', [
        {'id': 'c1', 'source': 'a.md', 'type': 'system'},
        {'id': 'c2', 'source': 'a.md', 'type': 7},
        {'id': 'c3', 'source': 'a.md', 'type': True},
    ])
    # executemany 每行一次：(sql, row)
    types = [row[12] for _sql, row in cursor.executed[1:]]
    assert types == [None, 7, None]   # 'system' 与 bool 都归一成 NULL


# ----------------------------------------------------------------------
# 表存在性 / 建表
# ----------------------------------------------------------------------


def test_vector_table_empty_checks_rows(monkeypatch, conn):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: True)
    cursor = FakeCursor(results=[])
    conn['install'](cursor)
    assert store._vector_table_empty('g') is True
    cursor = FakeCursor(results=[(1,)])
    conn['install'](cursor)
    assert store._vector_table_empty('g') is False
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    assert store._vector_table_empty('g') is True


def test_ensure_chunk_table_creates_only_when_missing(monkeypatch):
    created = []
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    monkeypatch.setattr(ddl, 'create_graph_chunk_table',
                        lambda name: created.append(name))
    store.ensure_chunk_table('g')
    assert created == ['g_chunk']

    monkeypatch.setattr(ddl, 'table_exists', lambda name: True)
    store.ensure_chunk_table('g')
    assert created == ['g_chunk']


def test_ensure_chunk_table_validates_identifier(monkeypatch):
    with pytest.raises(Exception):
        store.ensure_chunk_table('bad name')


# ----------------------------------------------------------------------
# upsert_vectors 与读 zip
# ----------------------------------------------------------------------


def test_upsert_vectors_skips_blank_key_ids_and_chunks(monkeypatch, conn):
    cursor = FakeCursor()
    conn['install'](cursor)
    written = store.upsert_vectors('g', store.KEY_TYPE_ENTITY, [
        ('P1', 'text', ['L'], [0.1]),
        ('', 'no-key', [], [0.2]),
        (None, None, None, None),
    ])
    # 空 key_id（含 None）都跳过
    assert written == 1
    sql, params = cursor.executed[0]
    assert 'ON CONFLICT' in sql
    assert len(params) == 8

    # 批量 > 500 时分多条
    cursor = FakeCursor()
    conn['install'](cursor)
    rows = [(f'P{i}', 't', [], [0.1]) for i in range(501)]
    store.upsert_vectors('g', store.KEY_TYPE_ENTITY, rows)
    assert len(cursor.executed) == 2

    # bulk 事务开关
    cursor = FakeCursor()
    conn['install'](cursor)
    store.upsert_vectors('g', store.KEY_TYPE_ENTITY, [('P1', 't', None, [0.1])],
                         bulk=True)
    assert 'synchronous_commit' in cursor.executed[0][0]

    # 空载荷不发 SQL
    cursor = FakeCursor()
    conn['install'](cursor)
    assert store.upsert_vectors('g', store.KEY_TYPE_ENTITY, []) == 0
    assert cursor.executed == []

    # 关闭 ON CONFLICT（空表装载）
    cursor = FakeCursor()
    conn['install'](cursor)
    store.upsert_vectors('g', store.KEY_TYPE_ENTITY, [('P1', 't', [], [0.1])],
                         on_conflict=False)
    assert 'ON CONFLICT' not in cursor.executed[0][0]


def test_read_jsonl_bad_zip_raises_graph_index_error(tmp_path):
    bad = tmp_path / 'x.zip'
    bad.write_bytes(b'nope')
    with pytest.raises(store.GraphIndexError):
        store.read_jsonl(str(bad), 'entities.jsonl')


def test_read_jsonl_skips_non_dict_lines(tmp_path):
    path = tmp_path / 'x.zip'
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('entities.jsonl', '\n'.join(
            [json.dumps({'entity_id': 'P1'}), '[1,2]', '   ', 'bad']))
    rows = store.read_jsonl(str(path), 'entities.jsonl')
    assert rows == [{'entity_id': 'P1'}]


# ----------------------------------------------------------------------
# 流水线
# ----------------------------------------------------------------------


def _make_zip(tmp_path, entries):
    path = tmp_path / 'graph.zip'
    with zipfile.ZipFile(path, 'w') as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload if isinstance(payload, str) else '\n'.join(
                json.dumps(row) for row in payload))
    return str(path)


def test_wait_write_wraps_errors():
    import concurrent.futures as futures

    done = futures.Future()
    done.set_result(None)
    store._wait_write(done, 'entity')
    failed = futures.Future()
    failed.set_exception(RuntimeError('write down'))
    with pytest.raises(store.GraphIndexError) as caught:
        store._wait_write(failed, 'entity')
    assert 'write failed for entity' in str(caught.value)


def test_build_index_empty_records_no_writes(monkeypatch, conn, tmp_path):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    monkeypatch.setattr(store, 'ensure_vector_table', lambda *a, **k: None)
    monkeypatch.setattr(store, 'ensure_vector_indexes', lambda *a, **k: None)
    conn['install'](FakeCursor())
    stats = store.build_index('g', 'kb1', _make_zip(tmp_path, {}),
                              'model', lambda texts, model: [])
    assert stats['entities'] == 0 and stats['edges'] == 0 and stats['chunk_rows'] == 0


def test_build_index_bulk_reports_progress(monkeypatch, conn, tmp_path):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    captured = {}
    monkeypatch.setattr(store, 'ensure_vector_table',
                        lambda base, dim, **kw: captured.update({'table': kw}))
    monkeypatch.setattr(store, 'ensure_vector_indexes',
                        lambda base, dim: captured.update({'rebuilt': base}))
    monkeypatch.setattr(store, 'upsert_vectors',
                        lambda base, key_type, rows, **kw: len(list(rows)))
    conn['install'](FakeCursor())

    zip_path = _make_zip(tmp_path, {
        'entities.jsonl': [{'entity_id': 'P1', 'entity_type': 'Person',
                            'properties': {'name': 'n'}}],
    })
    percents = []
    stats = store.build_index('g', 'kb1', zip_path, 'm',
                              lambda texts, model: [[0.0] * 4 for _ in texts],
                              bulk=True, progress_cb=percents.append)
    assert stats['entities'] == 1
    assert captured['rebuilt'] == 'g'
    assert percents and percents[-1] == 100
    assert captured['table']['with_hnsw'] is False  # bulk 模式先卸 HNSW


def test_build_index_chunk_stage_replaces_rows(monkeypatch, conn, tmp_path):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    monkeypatch.setattr(store, 'ensure_vector_table', lambda *a, **k: None)
    monkeypatch.setattr(store, 'ensure_chunk_table', lambda base: None)
    calls = {}
    monkeypatch.setattr(store, 'replace_chunks',
                        lambda base, kb, records: calls.setdefault('rows', records) and 1)
    monkeypatch.setattr(store, 'upsert_vectors',
                        lambda base, key_type, rows, **kw: len(list(rows)))
    conn['install'](FakeCursor())

    zip_path = _make_zip(tmp_path, {
        'document_chunk.jsonl': [{'id': 'c1', 'source': 'a.md', 'text': '正文'}],
    })
    stats = store.build_index('g', 'kb1', zip_path, 'm',
                              lambda texts, model: [[0.0] * 4 for _ in texts])
    assert stats['chunk_rows'] == 1 and stats['chunks'] == 1
    assert calls['rows'][0]['source'] == 'a.md'


def test_embed_and_write_merges_and_reports_collisions(monkeypatch, conn):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    written = {}
    monkeypatch.setattr(store, 'upsert_vectors',
                        lambda base, key_type, rows, **kw:
                        written.update({'rows': list(rows)}) or len(rows))
    conn['install'](FakeCursor())
    stats = {'skipped': 0, 'collisions': 0}
    records = [
        {'entity_id': 'P1', 'entity_type': 'Person', 'properties': {'n': 'a'}},
        {'entity_id': 'P1', 'entity_type': 'Person', 'properties': {'n': 'b'}},
        {'entity_id': '   ', 'properties': {}},                       # 空 key → 跳过
    ]
    count = store._embed_and_write(
        'g', store.KEY_TYPE_ENTITY, records, store.entity_key_id, store.entity_text,
        'm', lambda texts, model: [[0.0] * 4 for _ in texts], stats,
        label_fn=lambda record: ['Person'])
    assert count == 1
    assert stats['collisions'] == 1
    assert stats['skipped'] == 1
    key_id, text, labels, _vector, _edge, _source, _target = written['rows'][0]
    assert key_id == 'P1'
    assert text.count('entity_type: Person') == 2   # 冲突的两条文本拼接
    assert labels == ['Person']


def test_embed_and_write_embedding_failure_raises(monkeypatch, conn):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    conn['install'](FakeCursor())

    def boom(texts, model):
        raise RuntimeError('gateway')

    with pytest.raises(store.GraphIndexError) as caught:
        store._embed_and_write('g', store.KEY_TYPE_ENTITY,
                               [{'entity_id': 'P1', 'entity_type': 'P', 'properties': {}}],
                               store.entity_key_id, store.entity_text, 'm', boom,
                               {'skipped': 0, 'collisions': 0})
    assert 'embedding failed' in str(caught.value)


def test_embed_and_write_count_mismatch_raises(monkeypatch, conn):
    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    conn['install'](FakeCursor())
    with pytest.raises(store.GraphIndexError) as caught:
        store._embed_and_write('g', store.KEY_TYPE_ENTITY,
                               [{'entity_id': 'P1', 'entity_type': 'P', 'properties': {}}],
                               store.entity_key_id, store.entity_text, 'm',
                               lambda texts, model: [],   # 数量不符
                               {'skipped': 0, 'collisions': 0})
    assert 'embedding count mismatch' in str(caught.value)


def test_allowed_filters_by_index():
    assert store._allowed(None, 'Person', 'P1') is True
    assert store._allowed({'Person': {'P1'}}, 'Person', 'P1') is True
    assert store._allowed({'Person': {'P1'}}, 'Person', 'P2') is False
    assert store._allowed({'Person': {'P1'}}, None, 'P1') is False
    assert store._allowed({'Person': {'P1'}}, 'Person', None) is False
