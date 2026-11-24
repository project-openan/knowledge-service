"""对外 OpenAPI 契约生成器：路径/方法归并、响应状态、请求体补充与 schema 清洗。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from shared.prefixes import RKB_PREFIX

from infrastructure.http.openapi_contract import (
    API_VERSION,
    _collect_refs,
    _normalize_upload_schemas,
    _short_path,
    _tags_for,
    build_rkb_openapi,
    normalize_object_schemas,
)


class ChunkPayload:
    """带类型标注的请求体：FastAPI 会生成随后不再被引用的 ``Body_*`` schema。"""


try:                                                    # pydantic 模型让 FastAPI 推导出 Body_*
    from pydantic import BaseModel

    class _ChunkBody(BaseModel):
        documentId: str
        content: str

    ChunkPayload = _ChunkBody
except ImportError:                                     # pragma: no cover - 测试环境必有 pydantic
    pass


def _build_app():
    """造一个带代表性路由的 RKB 应用（覆盖 201/202/204、下载、SSE、公开操作）。"""
    from auth.sessions import COOKIE_NAME

    app = FastAPI()

    @app.get(RKB_PREFIX + '/health')
    def health():
        return {'ok': True}

    @app.post(RKB_PREFIX + '/auth/login')
    def login():
        return {'ok': True}

    @app.post(RKB_PREFIX + '/auth/logout')
    def logout():
        return {'ok': True}

    @app.post(RKB_PREFIX + '/knowledge-bases')
    def create_kb():
        return {'id': 'kb-1'}

    @app.patch(RKB_PREFIX + '/knowledge-bases/{kbase_id}')
    def update_kb(kbase_id: str):
        return {'id': kbase_id}

    @app.delete(RKB_PREFIX + '/knowledge-bases/{kbase_id}')
    def delete_kb(kbase_id: str):
        return None

    @app.post(RKB_PREFIX + '/knowledge-bases/{kbase_id}/documents')
    def upload(kbase_id: str):
        return {'id': 'doc-1'}

    @app.patch(RKB_PREFIX + '/knowledge-bases/{kbase_id}/documents')
    def move_documents(kbase_id: str):
        return {'moved': 1}

    @app.get(RKB_PREFIX + '/knowledge-bases/{kbase_id}/documents/{document_id}/content')
    def download(kbase_id: str, document_id: str):
        return StreamingResponse(content=b'bytes')

    @app.post(RKB_PREFIX + '/graph-extractions')
    def graph_extraction():
        return {'taskId': 't1'}

    @app.put(RKB_PREFIX + '/knowledge-bases/{kbase_id}/graph')
    def graph_update(kbase_id: str):
        return {'taskId': 't2'}

    @app.post(RKB_PREFIX + '/operators/{operator_id}/publish')
    def publish(operator_id: str):
        return None

    @app.put(RKB_PREFIX + '/operators/{operator_id}/visibility')
    def visibility(operator_id: str):
        return None

    @app.post(RKB_PREFIX + '/retrieval')
    def retrieval():
        return {'answer': 'x'}

    @app.post(RKB_PREFIX + '/query')
    def query():
        return {'answer': 'sse-or-json'}


    @app.post(RKB_PREFIX + '/models/{model_id}/test')
    def model_test(model_id: str):
        return {'ok': True}

    @app.post(RKB_PREFIX + '/misc-actions')
    def misc_action():
        return {'done': True}

    @app.post(RKB_PREFIX + '/knowledge-bases/{kbase_id}/chunks')
    def create_chunk(kbase_id: str, payload: ChunkPayload):
        return {'id': 'c1'}

    @app.get('/outside/health')
    def outside():
        return {'ok': True}

    @app.post(RKB_PREFIX + '/{unknown_path:path}')
    def fallback(unknown_path: str):
        return None

    return app, COOKIE_NAME


def test_build_rkb_openapi_shapes():
    app, cookie_name = _build_app()
    schema = build_rkb_openapi(app)

    assert schema['openapi'] == '3.0.3'
    assert schema['servers'] == [{'url': RKB_PREFIX}]
    assert schema['security'] == [{'cookieAuth': []}]
    assert schema['components']['securitySchemes']['cookieAuth']['name'] == cookie_name
    assert schema['components']['schemas']['Problem']['required'] == [
        'type', 'title', 'status', 'detail', 'code']
    assert 'HTTPValidationError' not in schema['components']['schemas']

    paths = schema['paths']
    # 兜底路由被剔除，其余路径剥掉全局前缀并排序
    assert '/{unknown_path}' not in paths
    assert '/knowledge-bases' in paths and '/health' in paths

    # 成功状态按登记表归位
    assert '201' in paths['/knowledge-bases']['post']['responses']
    assert paths['/knowledge-bases/{kbase_id}']['delete']['responses']['204'] == {
        'description': 'No Content'}
    assert '202' in paths['/graph-extractions']['post']['responses']
    assert paths['/knowledge-bases/{kbase_id}/documents/{document_id}/content'][
        'get']['responses']['200']['content']['application/octet-stream'][
            'schema'] == {'type': 'string', 'format': 'binary'}
    assert paths['/query']['post']['responses']['200']['content'][
        'text/event-stream']['description'].startswith('event:')

    # 4XX/5XX 引用 Problem 组件
    responses = paths['/knowledge-bases']['post']['responses']
    assert responses['4XX'] == {'$ref': '#/components/responses/Problem'}
    assert responses['5XX'] == {'$ref': '#/components/responses/Problem'}

    # 公开操作清空 security
    assert paths['/auth/login']['post']['security'] == []
    assert 'security' not in paths['/knowledge-bases']['post']

    # 显式请求体与 multipart 补充
    assert paths['/knowledge-bases']['post']['requestBody'][
        'content']['application/json']['schema']['$ref'].endswith('KbaseCreateRequest')
    assert paths['/knowledge-bases/{kbase_id}/documents']['post'][
        'requestBody']['content']['multipart/form-data']['schema'][
            '$ref'].endswith('DocumentUploadForm')
    assert paths['/graph-extractions']['post']['requestBody'][
        'content']['multipart/form-data']['schema'][
            '$ref'].endswith('GraphExtractionForm')
    # 动作类 POST 不补 requestBody
    assert 'requestBody' not in paths['/operators/{operator_id}/publish']['post']
    # 无声明体的 POST 补一个宽松对象（/retrieval 有显式 schema，不作此用）
    assert paths['/retrieval']['post']['requestBody']['content'][
        'application/json']['schema']['$ref'].endswith('RetrievalRequest')
    assert paths['/misc-actions']['post']['requestBody']['content'][
        'application/json']['schema'] == {
            'type': 'object', 'additionalProperties': True}
    assert paths['/knowledge-bases/{kbase_id}/documents/{document_id}/content'][
        'get'].get('requestBody') is None

    # 手工接口的显式 schema 全部落位 + tags 取路径首段
    assert paths['/knowledge-bases']['post']['tags'] == ['knowledge-bases']
    assert paths['/health']['get']['tags'] == ['health']


def test_build_rkb_openapi_strips_unreferenced_body_schemas():
    app, _cookie = _build_app()
    schema = build_rkb_openapi(app)
    schemas = schema['components']['schemas']
    leftovers = [name for name in schemas
                 if name.startswith('Body_') and name not in _collect_refs(schema)]
    assert leftovers == []


def test_normalize_object_schemas_adds_additional_properties():
    schema = {'type': 'object'}
    normalize_object_schemas(schema)
    assert schema['additionalProperties'] is True         # 自由对象补默认

    explicit = {'type': 'object', 'properties': {'a': {'type': 'string'}}}
    normalize_object_schemas(explicit)
    assert 'additionalProperties' not in explicit         # 有 properties 的不动

    nested = {'items': [{'type': 'object'}, {'type': 'string'}]}
    normalize_object_schemas(nested)
    assert nested['items'][0]['additionalProperties'] is True


def test_normalize_upload_schemas_converts_content_media_type():
    node = {
        'type': 'string',
        'contentMediaType': 'application/octet-stream',
        'title': 'file',
    }
    _normalize_upload_schemas(node)
    assert node == {'type': 'string', 'format': 'binary', 'title': 'file'}

    untouched = {'type': 'string', 'contentMediaType': 'text/plain'}
    _normalize_upload_schemas(untouched)
    assert untouched == {'type': 'string', 'contentMediaType': 'text/plain'}


def test_collect_refs_walks_dicts_and_lists():
    schema = {
        'a': {'$ref': '#/components/schemas/One'},
        'b': [{'$ref': '#/components/schemas/Two'},
              {'$ref': 'https://external/schema'}],
    }
    assert _collect_refs(schema) == ['One', 'Two']


def test_short_path_and_tags_helpers():
    assert _short_path(RKB_PREFIX + '/kbase') == '/kbase'
    assert _short_path(RKB_PREFIX) == '/'
    assert _short_path('/other') == '/other'
    assert _tags_for('/knowledge-bases/x') == ['knowledge-bases']
    assert _tags_for('/') == ['root']
    assert API_VERSION
