"""graph_export_service.export_graph 的完整流程（桩 kbase / 图存储 / chunk 表）。

钉三条行为（模块 docstring 声明的）：

1. 库不存在 / 类别不对 / schema 缺失 → 各自的业务异常；
2. ``entities.jsonl`` 在「没有实体定义」时**缺席**（上游不对称 bug 的载体），
   而 ``edges.jsonl`` 两个分支都建文件；
3. 空 zip 仍是合法 200（图库不存在产出空文件）。

跑法::

    python -m pytest tests/test_graph_export_flow.py -q
"""

from __future__ import annotations

import json
import zipfile
from io import BytesIO

import pytest

from graph.service import graph_export_service as svc
from shared.errors.api import KbApiError

SCHEMA = {
    'entities': [{'entity_type': 'Person', 'properties': [{'name': 'name'}]}],
    'edges': [{'edge_type': 'Knows', 'properties': []}],
}


@pytest.fixture()
def export_env(monkeypatch):
    from knowledge_base.service import kbase_service as kbase_store
    from graph.repository import graph_pg

    state = {'kbase': {'kbase_id': 'kb1', 'name': 'kb', 'category': 10,
                       'embedding_model': 'm', 'description': 'd',
                       'schema_obj': SCHEMA, 'table_name': 'graph_kb1'},
             'db_exists': True,
             'vertices': [],
             'edges': [],
             'chunk_rows': None}

    monkeypatch.setattr(kbase_store, 'get_kbase_row',
                        lambda kb_id: state['kbase'] if kb_id == 'kb1' else None)
    from types import SimpleNamespace
    monkeypatch.setattr(graph_pg, 'new_client',
                        lambda dbname: SimpleNamespace(dbname=dbname))
    monkeypatch.setattr(graph_pg, 'graph_db_name', lambda kb_id: f'graph_{kb_id}')
    monkeypatch.setattr(graph_pg, 'is_database_exists', lambda client: state['db_exists'])
    monkeypatch.setattr(graph_pg, 'query_vertices',
                        lambda dbname, groups, limit, offset: list(state['vertices']))
    monkeypatch.setattr(graph_pg, 'query_edges',
                        lambda dbname, groups, limit, offset: list(state['edges']))

    from infrastructure.db import kb as db

    class _Cursor:
        executed = []

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            _Cursor.executed.append(sql)

        def fetchone(self):
            if state['chunk_rows'] is None:
                return [False]
            return [True]

        @property
        def description(self):
            return [('id',), ('source',), ('label',), ('spilt_type',), ('table_id',),
                    ('content_expand',), ('table_name',), ('chunk_id',),
                    ('chunk_index',), ('text',), ('chunk_order',)]

        def fetchall(self):
            return list(state['chunk_rows'] or [])

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(db, 'connection', lambda: _Conn())
    return state


def test_export_graph_returns_zip_with_all_entries(export_env):
    export_env['vertices'] = [{'entity_id': 'P1', 'name': '张三', '@class': 'Person',
                               '@rid': '#1:0', 'entity_type': 'Person'}]
    export_env['edges'] = [{'edge_id': 'K1', 'source_id': 'P1', 'target_id': 'P1',
                            '@class': 'Knows', '@rid': '#2:0', 'edge_type': 'Knows'}]
    export_env['chunk_rows'] = [('c1', 'a.md', 'L', 'system', 't1', '正文', 'tn', '9',
                                 '0', '正文', 1)]
    content, filename = svc.export_graph({'kbId': 'kb1'})

    assert filename.startswith('graph_kb1_') and filename.endswith('.zip')
    with zipfile.ZipFile(BytesIO(content)) as archive:
        names = archive.namelist()
        assert names == ['desc.json', 'schema.json', 'entities.jsonl',
                         'edges.jsonl', 'document_chunk.jsonl']
        desc = json.loads(archive.read('desc.json'))
        assert desc['id'] == 'graph_kb1'
        entities = [json.loads(line) for line in
                    archive.read('entities.jsonl').decode().splitlines()]
        assert entities[0]['entity_id'] == 'P1'
        assert entities[0]['properties'] == {'name': '张三'}
        edges = [json.loads(line) for line in
                 archive.read('edges.jsonl').decode().splitlines()]
        assert edges[0]['edge_id'] == 'K1'
        chunk = json.loads(archive.read('document_chunk.jsonl').decode().splitlines()[0])
        assert chunk['id'] == 'c1' and chunk['type'] == 'system'


def test_export_graph_without_entity_definitions_skips_entities_entry(export_env):
    export_env['kbase'] = {**export_env['kbase'],
                           'schema_obj': {'entities': [], 'edges': []}}
    content, _filename = svc.export_graph({'kbId': 'kb1'})
    with zipfile.ZipFile(BytesIO(content)) as archive:
        assert 'entities.jsonl' not in archive.namelist()
        assert 'edges.jsonl' in archive.namelist()
        assert archive.read('edges.jsonl') == b''


def test_export_graph_missing_graph_db_still_exports_empty_files(export_env):
    export_env['db_exists'] = False
    content, _filename = svc.export_graph({'kbId': 'kb1'})
    with zipfile.ZipFile(BytesIO(content)) as archive:
        assert archive.read('entities.jsonl') == b''
        assert archive.read('edges.jsonl') == b''


def test_export_graph_without_chunk_table_has_no_chunk_entry(export_env):
    export_env['chunk_rows'] = None
    content, _filename = svc.export_graph({'kbId': 'kb1'})
    with zipfile.ZipFile(BytesIO(content)) as archive:
        assert 'document_chunk.jsonl' not in archive.namelist()


def test_export_graph_business_error_ladder(export_env):
    with pytest.raises(KbApiError) as caught:
        svc.export_graph({'kbId': 'unknown'})
    assert 'graph.export.kbase.not.found' in caught.value.key

    export_env['kbase'] = {**export_env['kbase'], 'category': 1}
    with pytest.raises(KbApiError) as caught:
        svc.export_graph({'kbId': 'kb1'})
    assert 'graph.export.kbase.not.graph' in caught.value.key

    export_env['kbase'] = {**export_env['kbase'], 'schema_obj': None, 'category': 10}
    with pytest.raises(KbApiError) as caught:
        svc.export_graph({'kbId': 'kb1'})
    assert 'graph.export.schema.not.found' in caught.value.key


def test_export_graph_wraps_unexpected_build_errors(export_env, monkeypatch):
    monkeypatch.setattr(svc, '_export_entities',
                        lambda kb_id, schema: (_ for _ in ()).throw(RuntimeError('boom')))
    with pytest.raises(KbApiError) as caught:
        svc.export_graph({'kbId': 'kb1'})
    assert 'graph.export.failed' in caught.value.key


def test_export_entities_rows_carry_type_and_edges_are_stable(export_env):
    export_env['vertices'] = [{'entity_id': 'P1', '@class': 'Person', 'name': 'x'}]
    bytes_entities = svc._export_entities('kb1', SCHEMA)
    lines = bytes_entities.decode().splitlines()
    row = json.loads(lines[0])
    assert row['entity_type'] == 'Person' and row['entity_id'] == 'P1'

    # 实体定义里没有 entity_type 的条目被跳过
    schema = {'entities': [{'properties': []}], 'edges': []}
    assert svc._export_entities('kb1', schema) == b''


def test_export_document_chunk_maps_physical_columns(export_env):
    # 假连接按行原样返回（COALESCE(content_expand, text) 在 DB 侧展开）
    export_env['chunk_rows'] = [('c1', 'a.md', 'L', 'system', 't1', '正文', 'tn', '9',
                                 '0', '正文', 1)]
    payload = svc._export_document_chunk('kb1')
    row = json.loads(payload.decode().splitlines()[0])
    assert row['content_expand'] == '正文'
    assert row['text'] == '正文'
    assert row['chunk_order'] == 1 and row['chunk_index'] == '0'


def test_build_entries_order_is_stable(export_env):
    export_env['chunk_rows'] = [('c1', 'a.md', 'L', 'system', 't1', '正文', 'tn', '9',
                                 '0', '正文', 1)]
    entries = svc._build_entries('kb1', export_env['kbase'], SCHEMA)
    assert list(entries) == ['desc.json', 'schema.json', 'entities.jsonl',
                             'edges.jsonl', 'document_chunk.jsonl']


def test_select_all_sets_type_key_from_class(export_env):
    export_env['vertices'] = [{'entity_id': 'P1', '@class': 'Person'}]
    from types import SimpleNamespace
    client = SimpleNamespace(dbname='graph_kb1')
    rows = svc._select_all(client, 'Person', ['name'], entity_kind=True)
    assert rows[0]['entity_type'] == 'Person'
    assert rows[0]['entity_id'] == 'P1'

    export_env['edges'] = [{'edge_id': 'K1', '@class': 'Knows'}]
    rows = svc._select_all(client, 'Knows', [], entity_kind=False)
    assert rows[0]['edge_type'] == 'Knows'


def test_timestamp_shape():
    stamp = svc._timestamp()
    assert len(stamp) == 14 and stamp.isdigit()
