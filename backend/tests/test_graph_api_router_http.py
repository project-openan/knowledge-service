"""graph.api 路由的 HTTP 行为（TestClient + 桩服务函数）。

钉的是**接口层**那几条：

* ``graph_db_id`` 的前缀规则与导出下载的 RFC 5987 文件名、错误回 JSON 信封；
* ``POST /graph-extractions`` 非 multipart 显式挡 415、缺 file 400、缺 data 422；
* ``PUT /knowledge-bases/{id}/graph`` 三个必填表单字段；
* 实体/边六端点把路径参数并进 payload、导出下载的异常阶梯。

跑法::

    python -m pytest tests/test_graph_api_router_http.py -q
"""

from __future__ import annotations

import json
import zipfile
from io import BytesIO

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from graph import api as graph_api
from shared.errors.api import KbApiError, KbStoreError, KbValidationError
from shared.prefixes import RKB_PREFIX


@pytest.fixture()
def http(monkeypatch):
    app = FastAPI()
    app.include_router(graph_api.build_router(), prefix=RKB_PREFIX)
    client = TestClient(app)

    calls = {}

    def record(name, result=None):
        def fn(*args, **kwargs):
            calls[name] = {'args': args, 'kwargs': kwargs}
            if isinstance(result, Exception):
                raise result
            return result
        return fn

    from graph.service import (graph_export_service, graph_import_api,
                               graph_query_api, graph_schema_service,
                               graph_write_service)
    from graph import graph_extract_v2_api
    from graph.service import graph_retrieve_gateway as gateway

    monkeypatch.setattr(graph_schema_service, 'list_schemas',
                        record('list', [{'schemaId': 's-1'}]))
    monkeypatch.setattr(graph_schema_service, 'create_schema',
                        record('create', {'schema_name': 'n'}))
    monkeypatch.setattr(graph_schema_service, 'import_schema',
                        record('import', {'successCount': 1}))
    monkeypatch.setattr(graph_schema_service, 'schema_detail',
                        record('detail', {'schema_id': 's-1'}))
    monkeypatch.setattr(graph_schema_service, 'update_schema',
                        record('update', {'schema_name': 'n'}))
    monkeypatch.setattr(graph_schema_service, 'delete_schema',
                        record('delete', {'deleted': True}))
    monkeypatch.setattr(graph_extract_v2_api, 'extract_graph',
                        record('extract', {'id': 'kb-new', 'name': 'n'}))
    monkeypatch.setattr(graph_extract_v2_api, 'update_graph', record('update', None))
    monkeypatch.setattr(graph_import_api, 'import_graph', record('import_graph', None))
    monkeypatch.setattr(graph_query_api, 'query',
                        record('query', {'entities': [], 'edges': []}))
    monkeypatch.setattr(graph_write_service, 'create_entity',
                        record('entity_create', {'success': True}))
    monkeypatch.setattr(graph_write_service, 'update_entity',
                        record('entity_update', {'success': True}))
    monkeypatch.setattr(graph_write_service, 'delete_entity',
                        record('entity_delete', {'success': True}))
    monkeypatch.setattr(graph_write_service, 'create_edge',
                        record('edge_create', {'success': True}))
    monkeypatch.setattr(graph_write_service, 'update_edge',
                        record('edge_update', {'success': True}))
    monkeypatch.setattr(graph_write_service, 'delete_edge',
                        record('edge_delete', {'success': True}))

    zip_payload = b'zip-bytes'
    monkeypatch.setattr(graph_export_service, 'export_graph',
                        record('export', (zip_payload, 'graph_kb1_20240101.zip')))
    monkeypatch.setattr(gateway, 'retrieve_result',
                        record('retrieve', {'base_results': []}))
    return client, calls, zip_payload


def _zip_bytes():
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('a.txt', 'x')
    return buffer.getvalue()


# ----------------------------------------------------------------------
# schema 端点
# ----------------------------------------------------------------------


def test_schema_crud_routes(http):
    client, calls, _zip = http
    assert client.get(f'{RKB_PREFIX}/graph-schemas').status_code == 200
    assert calls['list']['args'][0] is not None          # current_user

    response = client.post(f'{RKB_PREFIX}/graph-schemas', json={'schema_name': 'n'})
    assert response.status_code == 201
    assert calls['create']['args'][0]['schema_name'] == 'n'

    response = client.post(f'{RKB_PREFIX}/graph-schemas/import',
                           files={'schema_file': ('a.zip', _zip_bytes())})
    assert response.status_code == 200
    assert calls['import']

    assert client.get(f'{RKB_PREFIX}/graph-schemas/s-1').status_code == 200
    assert 's-1' in calls['detail']['args']

    response = client.patch(f'{RKB_PREFIX}/graph-schemas/s-9', json={'schema_name': 'n'})
    assert response.status_code == 200
    assert calls['update']['args'][0]['schema_id'] == 's-9'

    assert client.delete(f'{RKB_PREFIX}/graph-schemas/s-1').status_code == 200
    assert calls['delete']


# ----------------------------------------------------------------------
# 抽取 / 导入
# ----------------------------------------------------------------------


def test_graph_extract_requires_multipart(http):
    client, calls, _zip = http
    response = client.post(f'{RKB_PREFIX}/graph-extractions', json={})
    assert response.status_code == 415
    assert 'extract' not in calls


def test_graph_extract_requires_file_and_data(http):
    client, calls, _zip = http
    # multipart 但缺 ``file`` part → 400
    response = client.post(f'{RKB_PREFIX}/graph-extractions',
                           files={'stub': ('', b'')},
                           data={'data': json.dumps({'name': 'kb'})})
    assert response.status_code == 400
    assert 'extract' not in calls

    response = client.post(f'{RKB_PREFIX}/graph-extractions',
                           files={'file': ('a.md', b'x')}, data={})
    assert response.status_code == 422           # 缺 data
    assert 'extract' not in calls

    response = client.post(f'{RKB_PREFIX}/graph-extractions',
                           files={'file': ('a.md', b'x')},
                           data={'data': json.dumps({'name': 'kb'})})
    assert response.status_code == 202
    files, data_json, language, emp_no, org_id = calls['extract']['args']
    assert files and json.loads(data_json)['name'] == 'kb'


def test_graph_extract_update_requires_three_form_fields(http):
    client, calls, _zip = http
    response = client.put(f'{RKB_PREFIX}/knowledge-bases/kb1/graph', data={})
    assert response.status_code == 422

    response = client.put(f'{RKB_PREFIX}/knowledge-bases/kb1/graph', data={
        'data': '{}', 'deleteFiles': '[]', 'localFiles': '[]'})
    assert response.status_code == 202
    kb_id, files, data_json, delete_files, local_files, title_language, emp_no, org_id = \
        calls['update']['args']
    assert kb_id == 'kb1'
    assert json.loads(delete_files) == []
    assert files == []


def test_graph_import_route_reads_upload(http):
    client, calls, _zip = http
    response = client.post(f'{RKB_PREFIX}/graph-imports',
                           files={'file': ('graph.zip', _zip_bytes())})
    assert response.status_code == 202
    filename, content, emp_no, org_id, base_bundle = calls['import_graph']['args']
    assert filename == 'graph.zip' and content


# ----------------------------------------------------------------------
# 单库图内容
# ----------------------------------------------------------------------


def test_graph_db_id_prefix_rules():
    assert graph_api.graph_db_id('kb1') == 'graph_kb1'
    assert graph_api.graph_db_id('graph_kb1') == 'graph_kb1'


def test_graph_query_route_injects_prefixed_kb_id(http):
    client, calls, _zip = http
    response = client.post(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/query',
                           json={'query_type': 'entity'})
    assert response.status_code == 200
    payload = calls['query']['args'][0]
    assert payload['kb_id'] == 'graph_kb1'
    assert payload['query_type'] == 'entity'


def test_entity_and_edge_routes_merge_path_params(http):
    client, calls, _zip = http
    assert client.post(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/entities',
                       json={'entityType': 'Person'}).status_code == 201
    payload = calls['entity_create']['args'][0]
    assert payload['kbId'] == 'kb1' and payload['entityType'] == 'Person'

    assert client.patch(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/entities/P_1',
                        json={}).status_code == 200
    assert calls['entity_update']['args'][0]['entityId'] == 'P_1'

    assert client.delete(
        f'{RKB_PREFIX}/knowledge-bases/kb1/graph/entities/P_1',
        params={'entityType': 'Person'}).status_code == 200
    assert calls['entity_delete']['args'][0]['entityType'] == 'Person'

    assert client.post(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/edges',
                       json={}).status_code == 201
    assert client.patch(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/edges/K_1',
                        json={}).status_code == 200
    assert client.delete(
        f'{RKB_PREFIX}/knowledge-bases/kb1/graph/edges/K_1',
        params={'edgeType': 'Knows'}).status_code == 200
    assert calls['edge_delete']['args'][0]['edgeType'] == 'Knows'


# ----------------------------------------------------------------------
# 导出下载
# ----------------------------------------------------------------------


def test_export_download_streams_zip_with_rfc5987_filename(http):
    client, calls, zip_payload = http
    response = client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/export')
    assert response.status_code == 200
    assert response.headers['content-type'].startswith('application/octet-stream')
    assert "filename*=utf-8''graph_kb1_20240101.zip" in \
        response.headers['content-disposition']
    assert response.content == zip_payload
    # payload 由路径参数直接给出，不走 body 解析
    assert calls['export']['args'][0] == {'kbId': 'kb1'}


def test_export_download_error_ladder(http, monkeypatch):
    client, calls, _zip = http
    from graph.service import graph_export_service

    monkeypatch.setattr(graph_export_service, 'export_graph',
                        lambda payload: (_ for _ in ()).throw(
                            KbValidationError('graph.extract.taskid.empty')))
    response = client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/export')
    assert response.status_code == 422

    monkeypatch.setattr(graph_export_service, 'export_graph',
                        lambda payload: (_ for _ in ()).throw(ValueError('bad')))
    response = client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/export')
    assert response.status_code == 400

    monkeypatch.setattr(graph_export_service, 'export_graph',
                        lambda payload: (_ for _ in ()).throw(
                            KbApiError('graph.export.failed')))
    response = client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/export')
    assert response.status_code == 500

    monkeypatch.setattr(graph_export_service, 'export_graph',
                        lambda payload: (_ for _ in ()).throw(
                            KbStoreError(KbStoreError.IO, 'disk broken')))
    response = client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/export')
    assert response.status_code in (500, 502, 503)

    monkeypatch.setattr(graph_export_service, 'export_graph',
                        lambda payload: (_ for _ in ()).throw(
                            RuntimeError('unexpected')))
    response = client.get(f'{RKB_PREFIX}/knowledge-bases/kb1/graph/export')
    assert response.status_code == 500


def test_graph_retrieve_route_success_and_problem(http):
    client, calls, _zip = http
    response = client.post(f'{RKB_PREFIX}/retrieval/graph', json={
        'query': 'who', 'embedding': 'm', 'bases': ['graph_kb1']})
    assert response.status_code == 200
    assert response.json() == {'base_results': []}
    assert 'x-request-id' in {key.lower() for key in response.headers}

    from graph.service import graph_retrieve_gateway as gateway
    from shared.problem import INTERNAL_ERROR

    def boom(dto, headers):
        raise gateway.GraphRetrieveError(INTERNAL_ERROR, 'retrieval failed')

    original = gateway.retrieve_result
    gateway.retrieve_result = boom
    try:
        response = client.post(f'{RKB_PREFIX}/retrieval/graph', json={
            'query': 'who', 'embedding': 'm', 'bases': ['graph_kb1']})
    finally:
        gateway.retrieve_result = original
    assert response.status_code == 500
    assert response.headers['content-type'].startswith('application/problem+json')
