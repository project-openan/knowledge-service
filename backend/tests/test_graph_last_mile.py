"""graph 域 98%+ 收尾：剩余可达分支（路径提取的显式起点回退、chunk 空参短路、
导入解压的条目读取失败、_as_business、嵌套同名条目、写向量线程池分支、
update 抽图任务失败包装、graph_download 的 form 体闸门）。

跑法::

    python -m pytest tests/test_graph_last_mile.py -q
"""

from __future__ import annotations

import json
import zipfile

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from graph.service.graph_query_service import extract_paths


# ----------------------------------------------------------------------
# extract_paths：显式起点与列表条件
# ----------------------------------------------------------------------


def _entities(*specs):
    out = []
    for rid, props in specs:
        row = {'@rid': rid}
        row.update(props)
        out.append(row)
    return out


def test_explicit_rid_start_does_not_fall_back():
    entities = _entities(('#a:0', {}), ('#b:0', {}))
    edges = [{'@rid': '#e0:0', 'out': '#a:0', 'in': '#b:0'}]
    # 起点 #b:0 无出边，但**显式指定**了起点 → 不回退到入度 0；
    # 反向遍历额外产出到达它的路径
    paths = extract_paths(entities, edges, {'@rid': '#b:0'})
    assert {'nodes': ['#b:0'], 'edges': []} in paths
    assert {'nodes': ['#a:0', '#b:0'], 'edges': ['#e0:0']} in paths


def test_list_conditions_with_rid_marks_explicit_start():
    entities = _entities(('#a:0', {}), ('#b:0', {}))
    edges = [{'@rid': '#e0:0', 'out': '#a:0', 'in': '#b:0'}]
    paths = extract_paths(entities, edges, [{'@rid': '#b:0'}, {'nope': 1}])
    assert any(path['nodes'] == ['#b:0'] for path in paths)


def test_list_conditions_with_in_degree_zero_marker():
    entities = _entities(('#a:0', {'n': 1}), ('#b:0', {'n': 2}))
    edges = [{'@rid': '#e0:0', 'out': '#a:0', 'in': '#b:0'}]
    paths = extract_paths(entities, edges, [{'_use_in_degree_zero': True}])
    assert paths and paths[0]['nodes'][0] == '#a:0'


def test_build_start_conditions_skips_empty_condition():
    service = __import__('graph.service.graph_query_service',
                         fromlist=['GraphQueryService']).GraphQueryService()
    from graph.models.graph_query_dto import GraphQueryDto, GraphFilter

    dto = GraphQueryDto(kb_id='g', query_type='path',
                        filters=[GraphFilter(start_entity_properties={})])
    # 唯一的 filter 产出空条件 → 整体回落到入度 0
    assert service._build_start_conditions_for_paths(dto) == {
        '_use_in_degree_zero': True}


def test_query_chunks_by_ids_all_blank_ids_short_circuits(monkeypatch):
    service = __import__('graph.service.graph_query_service',
                         fromlist=['GraphQueryService']).GraphQueryService()

    class _Pool:
        def pg_select_zip_values_operator_with_params(self, sql, params):
            raise AssertionError('不应触库')

    monkeypatch.setattr(
        __import__('graph.service.graph_query_service',
                   fromlist=['_db_pool']),
        '_db_pool', _Pool())
    assert service._query_chunks_by_ids('graph_demo', ['   ']) == {}


# ----------------------------------------------------------------------
# graph_import_api
# ----------------------------------------------------------------------


def test_as_business_converts_0004_to_0005():
    from graph.service import graph_import_api as api
    from shared.errors.api import KbApiError

    def bad(name):
        raise KbApiError('kbase.name.validation', code='0004')

    with pytest.raises(KbApiError) as caught:
        api._as_business(bad, 'x')
    assert caught.value.code == '0005'
    assert 'kbase.name.validation' in caught.value.key

    api._as_business(lambda *_: None)          # 通过则不抛


def test_unzip_entry_read_failure_is_zip_error(monkeypatch):
    from graph.service import graph_import_api as api
    from shared.errors.api import KbApiError

    def boom(self, info):
        raise RuntimeError('crc mismatch')

    monkeypatch.setattr(zipfile.ZipFile, 'read', boom)
    content = _zip({'desc.json': b'{}'})
    with pytest.raises(KbApiError) as caught:
        api._unzip(content)
    assert 'zip.decompress.error' in caught.value.key


def test_unzip_rejects_bad_zip():
    from graph.service import graph_import_api as api
    from shared.errors.api import KbApiError

    with pytest.raises(KbApiError) as caught:
        api._unzip(b'not-a-zip')
    assert 'zip.decompress.error' in caught.value.key


def _zip(entries):
    import io

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)
    return buffer.getvalue()


def test_write_temp_zip_uses_nested_when_root_absent(monkeypatch, tmp_path):
    from graph.service import graph_import_api as api
    from infrastructure.storage import kb_storage as storage

    monkeypatch.setattr(storage, 'scratch_root', lambda: tmp_path)
    path = api._write_temp_zip({'deep/dir/edges.jsonl': b'NESTED'})
    with zipfile.ZipFile(path) as archive:
        assert archive.namelist() == ['edges.jsonl']
        assert archive.read('edges.jsonl') == b'NESTED'


# ----------------------------------------------------------------------
# graph_extract_v2_api：更新链路的任务失败包装
# ----------------------------------------------------------------------


def test_update_graph_task_failure_is_generate_failed(monkeypatch, tmp_path):
    from graph import graph_extract_v2_api
    from graph.repository import graph_extract_store
    from knowledge_base.service import (directory_service, file_service,
                                        kbase_v2_service)
    from knowledge_base.service import kbase_service as kbase_store
    from shared.errors.api import KbApiError
    from graph.service import lifecycle as graph_lifecycle

    monkeypatch.setattr(graph_lifecycle, 'delete_graph_database', lambda kb: None)
    monkeypatch.setattr(kbase_v2_service, 'update_kbase', lambda *a, **k: None)
    monkeypatch.setattr(directory_service, 'query_or_create_directory',
                        lambda kb, title: 'dir-1')
    monkeypatch.setattr(file_service, 'upload_files', lambda *a, **k: None)
    from operators.service import operator_service
    monkeypatch.setattr(operator_service, 'get_operator_row',
                        lambda operator_id: {'id': 5})
    monkeypatch.setattr(operator_service, 'operator_python_path',
                        lambda operator_id: '/usr/bin/python3')
    row = {'kbase_id': 'kb1', 'category': 10, 'schema_id': 's-1', 'schema_obj': {}}
    monkeypatch.setattr(kbase_store, 'get_kbase_row', lambda kb_id: row)
    monkeypatch.setattr(graph_extract_store, 'insert_task',
                        lambda **kwargs: (_ for _ in ()).throw(RuntimeError('db down')))

    with pytest.raises(KbApiError) as caught:
        graph_extract_v2_api.update_graph(
            'kb1', [{'filename': 'a.md', 'content': b'x'}],
            json.dumps({'name': 'kb-name', 'props': {}, 'operatorId': 5}),
            '[]', '[]', 'en', 'emp', None)
    assert 'Retcode.generate.graph.schema.fail' in caught.value.key


# ----------------------------------------------------------------------
# graph_index_store：空表装载的并发写线程池
# ----------------------------------------------------------------------


def test_embed_and_write_fast_load_uses_write_pool(monkeypatch):
    from graph.repository import graph_index_store as store
    from infrastructure.db import ddl

    monkeypatch.setattr(ddl, 'table_exists', lambda name: False)
    written = {'rows': 0}

    def fake_upsert(base, key_type, rows, **kwargs):
        rows = list(rows)
        written['rows'] += len(rows)
        assert kwargs.get('on_conflict') is False
        return len(rows)

    monkeypatch.setattr(store, 'upsert_vectors', fake_upsert)

    class _Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            pass

        def fetchone(self):
            return None

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def cursor(self):
            return _Cursor()

    monkeypatch.setattr(store, 'connection', lambda: _Conn())

    records = [{'entity_id': f'P{i}', 'entity_type': 'Person',
                'properties': {'n': i}} for i in range(1100)]
    stats = {'skipped': 0, 'collisions': 0}
    count = store._embed_and_write(
        'g', store.KEY_TYPE_ENTITY, records, store.entity_key_id, store.entity_text,
        'm', lambda texts, model: [[0.0] * 4 for _ in texts], stats,
        label_fn=lambda record: ['Person'], bulk=True, fast_load=True)
    assert count == 1100
    assert written['rows'] == 1100


# ----------------------------------------------------------------------
# api.py：graph_download 的 form 体闸门
# ----------------------------------------------------------------------


def test_graph_download_rejects_form_encoded_body():
    from graph import api as graph_api
    from shared.prefixes import RKB_PREFIX

    app = FastAPI()

    @app.post(RKB_PREFIX + '/echo-export')
    async def route(request: Request):
        return await graph_api.graph_download(
            request, lambda payload: (b'data', 'x.zip'))

    client = TestClient(app)
    # form-urlencoded（体可读）→ UNSUPPORTED → 415
    response = client.post(RKB_PREFIX + '/echo-export',
                           content=b'kbId=kb1',
                           headers={'content-type':
                                    'application/x-www-form-urlencoded'})
    assert response.status_code == 415
