"""RKB 前缀的公共 HTTP 管道：查询参数解析、分发器归宿、验证处理器与中间件边界。"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient

from infrastructure.http import binding, content_type, kb_responses
from infrastructure.http import rkb_support
from infrastructure.http.middleware.content_type_validation import (
    ContentTypeValidationMiddleware,
)
from infrastructure.http.middleware.rate_limit import RateLimitMiddleware
from infrastructure.http.middleware.request_id import RequestIdMiddleware
from infrastructure.logging import trace
from shared.errors.api import (KbApiError, KbMalformedRequestError,
                               KbStoreError, KbValidationError)
from shared.errors.exception import EMException


# ---------------------------------------------------------------------------
# 查询参数与排序解析
# ---------------------------------------------------------------------------

def test_csv_query_reads_both_forms():
    scope = {'type': 'http', 'method': 'GET', 'path': '/',
             'query_string': b'ids=a,b&ids=c',
             'headers': []}
    request = Request(scope)
    assert rkb_support.csv_query(request, 'ids') == ['a', 'b', 'c']
    assert rkb_support.csv_query(request, 'absent') == []


def test_int_list_parses_and_rejects():
    assert rkb_support.int_list('1, 2,,3') == [1, 2, 3]
    assert rkb_support.int_list(None) is None
    assert rkb_support.int_list('') is None
    with pytest.raises(ValueError):
        rkb_support.int_list('1,x')


def test_order_list_splits_key_and_direction():
    assert rkb_support.order_list(['createdDate:desc', 'name']) == [
        {'key': 'createdDate', 'ascending': False},
        {'key': 'name', 'ascending': True},
    ]
    assert rkb_support.order_list([]) == []


# ---------------------------------------------------------------------------
# 下载与分发器
# ---------------------------------------------------------------------------

def _client_app():
    app = FastAPI()
    client = TestClient(app)
    return client


def _request_for_path(path='/api/knowledge-service/v1/x'):
    return Request({'type': 'http', 'method': 'GET', 'path': path,
                    'headers': [], 'query_string': b''})


def test_stream_download_maps_error_ladder():
    import asyncio
    asyncio.run(_stream_download_error_ladder())


async def _stream_download_error_ladder():
    from shared.errors.api import KbStoreError

    request = _request_for_path()

    class FakeStoreError(KbStoreError):
        def __init__(self):
            self.kind = 'duplicate'
            self.detail = 'dup'

    def validation():
        raise KbValidationError('bad')

    def api_error():
        raise KbApiError('file.save.error')

    def store_error():
        raise FakeStoreError()

    def unexpected():
        raise RuntimeError('boom')

    response = await rkb_support.stream_download(request, validation)
    assert response.status_code == 422                    # 具体校验文案
    assert (await rkb_support.stream_download(
        request, api_error)).status_code == 500           # 业务错误默认 500 信封
    assert (await rkb_support.stream_download(request, store_error)).status_code == 409
    assert (await rkb_support.stream_download(request, unexpected)).status_code == 500

    def build():
        return b'file-bytes', 'a.bin'                    # 业务层在线程池里同步跑

    response = await rkb_support.stream_download(request, build)
    assert response.status_code == 200
    assert response.headers['content-length'] == '10'
    assert 'a.bin' in response.headers['content-disposition']


def test_missing_param_uses_illegal_argument_message():
    response = rkb_support.missing_param('kbId', _request_for_path())
    assert response.status_code == 400


def test_localize_and_not_found():
    localize = rkb_support.localize(_request_for_path())
    assert localize('no-such-key') == 'no-such-key'      # 键缺席时回键名

    response = rkb_support.not_found(_request_for_path('/nope'))
    assert response.status_code == 404


def test_path_long_maps_non_integer_to_malformed():
    assert rkb_support.path_long('42') == 42
    with pytest.raises(KbMalformedRequestError):
        rkb_support.path_long('abc')


def test_enforce_body_content_type_verdicts():
    json_request = _request_for_path()
    json_request._headers = type('H', (), {'get': lambda self, k: 'application/json'})()
    rkb_support.enforce_body_content_type(json_request, b'{}')     # JSON 放行

    form_request = Request({'type': 'http', 'method': 'POST', 'path': '/x',
                            'headers': [(b'content-type',
                                         b'application/x-www-form-urlencoded; charset=gibberish')],
                            'query_string': b''})
    with pytest.raises(KbApiError):                    # form 一律 415（未知 charset 回 utf-8）
        rkb_support.enforce_body_content_type(form_request, b'a=1')

    with pytest.raises(KbMalformedRequestError):                   # form 体解不出
        rkb_support.enforce_body_content_type(form_request, b'%E4%B')

    bad_ct = Request({'type': 'http', 'method': 'POST', 'path': '/x',
                      'headers': [(b'content-type', b'text/plain')],
                      'query_string': b''})
    with pytest.raises(KbApiError):
        rkb_support.enforce_body_content_type(bad_ct, b'{}')


def test_kb_error_handler_reraises_outside_rkb_prefix():
    import asyncio
    asyncio.run(_kb_error_handler_reraises())


async def _kb_error_handler_reraises():
    outside = _request_for_path('/other/path')
    with pytest.raises(KbApiError):
        await rkb_support.kb_error_handler(outside, KbApiError('x'))


def test_dispatch_sync_ok_status_variants():
    request = _request_for_path()
    download = rkb_support.dispatch_sync(
        request, b'', lambda payload: None, ok_status=200,
        location=lambda result: '/x') if False else None
    from fastapi.responses import JSONResponse

    marker = JSONResponse({'raw': True})

    assert rkb_support.dispatch_sync(request, b'', lambda p: marker).status_code == 200
    assert rkb_support.dispatch_sync(request, b'', lambda p: None, ok_status=204).status_code == 204
    assert rkb_support.dispatch_sync(request, b'', lambda p: None,
                                     ok_status=202).status_code == 202
    assert rkb_support.dispatch_sync(request, b'', lambda p: {'id': 1},
                                     ok_status=201, location='/there').headers['Location'] == '/there'
    assert rkb_support.dispatch_sync(request, b'', lambda p: {'id': 1},
                                     ok_status=201,
                                     location=lambda result: f"/items/{result['id']}").headers['Location'] == '/items/1'


def test_dispatch_sync_translates_every_error_family():
    request = _request_for_path()

    def validation(_payload):
        raise KbValidationError('Type must be 0 or 1')

    response = rkb_support.dispatch_sync(request, b'', validation)
    assert response.status_code == 422

    def malformed(_payload):
        raise ValueError('body not object')

    assert rkb_support.dispatch_sync(request, b'', malformed).status_code == 400

    def unexpected(_payload):
        raise RuntimeError('boom')

    assert rkb_support.dispatch_sync(request, b'', unexpected).status_code == 500

    class FakeStoreError(KbStoreError):
        def __init__(self):
            self.kind = 'not_found'
            self.detail = 'table demo'

    def store_failure(_payload):
        raise FakeStoreError()

    response = rkb_support.dispatch_sync(request, b'', store_failure)
    assert response.status_code == 404                   # 存储层细节只进日志


def test_validation_handler_defaults_for_non_rkb_prefix():
    import asyncio
    asyncio.run(_validation_handler_defaults())


async def _validation_handler_defaults():
    from fastapi.exception_handlers import request_validation_exception_handler

    exc = RequestValidationError([])
    request = _request_for_path('/mcp/tools')
    default = await request_validation_exception_handler(request, exc)
    handled = await rkb_support.validation_handler(request, exc)
    assert handled.status_code == default.status_code == 422


# ---------------------------------------------------------------------------
# multipart 判定的两个守门分支
# ---------------------------------------------------------------------------

def test_multipart_body_path_detection():
    assert rkb_support.is_multipart_body_path('/api/knowledge-service/v1/operators')
    assert rkb_support.is_multipart_body_path(
        '/api/knowledge-service/v1/knowledge-bases/kb-1/documents')
    assert not rkb_support.is_multipart_body_path('/api/knowledge-service/v1/kbase')
    assert not rkb_support.is_multipart_body_path('/api/knowledge-service/v1')


def _validation_error(loc, type_='missing'):
    return RequestValidationError(
        [{'loc': loc, 'type': type_, 'msg': 'field required'}])


def test_multipart_gates_map_to_malformed_request():
    import asyncio
    asyncio.run(_multipart_gates())


async def _multipart_gates():
    multipart_path = '/api/knowledge-service/v1/operators'
    request = Request({'type': 'http', 'method': 'POST', 'path': multipart_path,
                       'headers': [(b'content-type',
                                    b'multipart/form-data; boundary=xyz')],
                       'query_string': b''})
    response = await rkb_support.validation_handler(
        request, _validation_error(('body', 'files')))
    assert response.status_code == 400                    # 空 multipart → 0001

    request_plain = Request({'type': 'http', 'method': 'POST', 'path': multipart_path,
                             'headers': [(b'content-type', b'text/plain')],
                             'query_string': b''})
    response = await rkb_support.validation_handler(
        request_plain, _validation_error(('body',)))
    assert response.status_code == 400                    # 非 multipart 上传 → 0001

    response = await rkb_support.validation_handler(
        request_plain, _validation_error(('query', 'kbId')))
    assert response.status_code == 400                    # query 绑定错误先炸 → 0004

    multipart_ct = Request({'type': 'http', 'method': 'POST', 'path': multipart_path,
                            'headers': [(b'content-type',
                                         b'multipart/form-data; boundary=xyz')],
                            'query_string': b''})
    response = await rkb_support.validation_handler(
        multipart_ct, _validation_error(('body', 'files'), type_='value_error'))
    assert response.status_code == 422                    # multipart 但 body 错误非 missing → 0004


# ---------------------------------------------------------------------------
# kb_responses 与 content_type 补充分支
# ---------------------------------------------------------------------------

def test_kb_responses_store_error_mapping():
    request = _request_for_path()

    class StoreError(KbStoreError):
        def __init__(self, kind):
            self.kind = kind
            self.detail = 'table demo'

    assert kb_responses.store_error(StoreError('duplicate'), 'zh').status_code == 409
    assert kb_responses.store_error(StoreError('not_found'), 'zh').status_code == 404
    assert kb_responses.store_error(StoreError('other'), 'zh').status_code == 500


def test_parse_json_body_semantics():
    assert kb_responses.parse_json_body(b'') == {}
    assert kb_responses.parse_json_body(b'null') == {}
    with pytest.raises(KbApiError):
        kb_responses.parse_json_body(b'', required=True)
    with pytest.raises(ValueError):
        kb_responses.parse_json_body(b'[1]')
    with pytest.raises(ValueError):
        kb_responses.parse_json_body(b'{bad')
    assert kb_responses.parse_json_body(b'{"a": 1}') == {'a': 1}


def test_multipart_gate_helpers_false_branches():
    plain_path = '/api/knowledge-service/v1/kbase'
    request_off_path = Request({'type': 'http', 'method': 'POST', 'path': plain_path,
                                'headers': [(b'content-type', b'text/plain')],
                                'query_string': b''})
    assert rkb_support.multipart_without_files(
        request_off_path, _validation_error(('body', 'files'))) is False

    multipart_path = '/api/knowledge-service/v1/operators'
    request_multipart = Request({'type': 'http', 'method': 'POST', 'path': multipart_path,
                                 'headers': [(b'content-type',
                                              b'multipart/form-data; boundary=x')],
                                 'query_string': b''})
    assert rkb_support.multipart_without_files(
        request_multipart, RequestValidationError([])) is False
    request_plain = Request({'type': 'http', 'method': 'POST', 'path': multipart_path,
                             'headers': [(b'content-type', b'text/plain')],
                             'query_string': b''})
    assert rkb_support.multipart_without_files(
        request_plain, RequestValidationError([])) is False
    assert rkb_support.multipart_content_type_missing(
        request_plain, RequestValidationError([])) is False


def test_content_type_params_without_separator_are_ignored():
    from infrastructure.http.content_type import _params_of
    assert _params_of('multipart/form-data; boundary') == {}
    assert content_type.classify(
        'multipart/form-data; boundary', b'x') == content_type.BAD_FORM


def test_content_type_validation_middleware_boundaries(monkeypatch):
    assert content_type.classify(
        'application/x-www-form-urlencoded; charset=unknown-charset', b'a=1'
    ) == content_type.UNSUPPORTED                         # 未知编码回落 utf-8
    # GBK 字节按 utf-8 严格解码失败 → BAD_FORM
    assert content_type.classify(
        'application/x-www-form-urlencoded', 'a=中文'.encode('gbk')) == content_type.BAD_FORM


# ---------------------------------------------------------------------------
# binding 补充分支
# ---------------------------------------------------------------------------

def test_bind_rejects_non_object_payload():
    with pytest.raises(ValueError):
        binding.bind([1, 2], {})


def test_bind_primitive_integer_null_rejected():
    with pytest.raises(ValueError):
        binding.bind({'pageNO': None}, {'pageNO': binding.PRIMITIVE_INTEGER})
    assert binding.bind({'pageNO': 5}, {'pageNO': binding.PRIMITIVE_INTEGER}) == {
        'pageNO': 5}
    assert binding.as_integer('page', None) is None       # 可空整数显式 null 放行


def test_bind_object_field_kinds():
    bound = binding.bind({'edgeInfo': None}, {'edgeInfo': binding.OBJECT})
    assert bound['edgeInfo'] is None
    with pytest.raises(ValueError):
        binding.bind({'edgeInfo': [1]}, {'edgeInfo': binding.OBJECT})
    nested = binding.bind({'edgeInfo': {'edgeId': 'e1'}}, {'edgeInfo': binding.OBJECT})
    assert nested['edgeInfo'] == {'edgeId': 'e1'}
    with pytest.raises(AssertionError):
        binding._coerce('x', 1, 'mystery-kind')


def test_bind_float_and_list_element_errors():
    assert binding.as_float('f', 1) == 1.0
    assert binding.as_float('f', '1.5') == 1.5
    assert binding.as_float('f', None) is None
    with pytest.raises(ValueError):
        binding.as_float('f', True)
    with pytest.raises(ValueError):
        binding.as_float('f', 'abc')
    with pytest.raises(ValueError):
        binding.as_float('f', [1])

    assert binding.as_list_of_objects('x', [{'a': 1}, None]) == [{'a': 1}, None]
    with pytest.raises(ValueError):
        binding.as_list_of_objects('x', 'str')
    with pytest.raises(ValueError):
        binding.as_list_of_objects('x', [1])

    with pytest.raises(ValueError):
        binding.as_string_list('x', [{'a': 1}])
    with pytest.raises(ValueError):
        binding.as_filters('not-a-list')
    assert binding.as_filters(None) is None
    assert binding.as_string_list('x', None) is None
    assert binding.as_list_of_integers('x', None) is None
    assert binding.as_list_of_integers('x', ['2', 3]) == [2, 3]

    assert binding.bind_objects('not-a-list', {}) == 'not-a-list'
    assert binding.bind_objects([None, {'kbId': 'kb-1'}],
                                {'kbId': binding.STRING}) == [None, {'kbId': 'kb-1'}]


def test_bind_filter_alias_precedence():
    bound = binding.as_filters([
        {'entity_type': ['Company'], 'entityType': ['Person'], 'properties': {'a': 1}},
        {'start_entity_rid': 'rid-1', 'unknown': 'drop'},
    ])
    assert bound[0]['entity_type'] == ['Person']          # 后出现的键赢
    assert bound[0]['properties'] == {'a': 1}
    assert bound[1] == {'start_entity_rid': 'rid-1'}      # 未知键丢弃


# ---------------------------------------------------------------------------
# 中间件边界
# ---------------------------------------------------------------------------

def test_content_type_middleware_boundaries(monkeypatch):
    from httpx import Response as HttpxResponse  # noqa: F401  (仅说明 TestClient 依赖)

    middleware = ContentTypeValidationMiddleware(app=None)
    assert middleware._is_content_type_allowed(
        'application/json; charset=utf-8', middleware.ALLOWED_CONTENT_TYPES['POST'])
    assert not middleware._is_content_type_allowed('text/csv',
                                                   middleware.ALLOWED_CONTENT_TYPES['POST'])


def test_content_type_middleware_http_gate(monkeypatch):
    """非 RKB 前缀的 Content-Type 闸门：参数剥离、GET 无体放行。"""
    app = FastAPI()

    @app.get('/api/native/ping')
    def ping():
        return {'ok': True}

    @app.post('/api/native/echo')
    def echo():
        return {'ok': True}

    app.add_middleware(ContentTypeValidationMiddleware)
    client = TestClient(app)

    # Content-Type 带参数 → 剥掉再比对（参数版合法类型不误杀）
    ok = client.post('/api/native/echo', content=b'{}',
                     headers={'Content-Type': 'application/json; charset=utf-8'})
    assert ok.status_code == 200
    blocked = client.post('/api/native/echo', content=b'{}',
                          headers={'Content-Type': 'text/csv'})
    assert blocked.status_code == 415
    assert blocked.json()['code'] == -1
    # GET/HEAD 没有 Content-Type → 直接放行
    assert client.get('/api/native/ping').status_code == 200

    from infrastructure.http.middleware.content_type_validation import (
        get_content_type_validation_middleware,
    )
    assert get_content_type_validation_middleware() is ContentTypeValidationMiddleware


def _rate_limit_app(limits, slow_ms=None):
    app = FastAPI()

    @app.get('/ping')
    def ping():
        return {'ok': True}

    @app.get('/other')
    def other():
        return {'ok': True}

    app.add_middleware(RateLimitMiddleware, limits=limits, slow_ms=slow_ms)
    return app


def test_rate_limit_blocks_after_window_limit():
    client = TestClient(_rate_limit_app({'/ping': {'limit': 2, 'window': 60}}))
    assert client.get('/ping').status_code == 200
    assert client.get('/ping').status_code == 200
    limited = client.get('/ping')
    assert limited.status_code == 429
    assert limited.headers['retry-after'] == '60'
    assert client.get('/other').status_code == 200        # 未配置的路径不限


def test_rate_limit_without_client_ip_skips_limiting():
    import asyncio

    middleware = RateLimitMiddleware(lambda *a: None, limits={'/graph': {'limit': 1,
                                                                        'window': 1}})
    scope = {'type': 'http', 'path': '/graph', 'headers': []}   # 没有 client
    assert middleware._enforce_limit(scope, '/graph', None) is None


def test_rate_limit_non_http_scope_passthrough():
    passthrough_calls = []

    async def downstream(scope, receive, send):
        passthrough_calls.append(scope['type'])

    middleware = RateLimitMiddleware(downstream, limits={})
    scope = {'type': 'lifespan'}
    import asyncio
    asyncio.run(middleware(scope, None, None))
    assert passthrough_calls == ['lifespan']

    request_middleware = RequestIdMiddleware(downstream)
    asyncio.run(request_middleware(scope, None, None))
    assert passthrough_calls == ['lifespan', 'lifespan']


def test_rate_limit_logs_slow_requests(caplog):
    import logging

    client = TestClient(_rate_limit_app({}, slow_ms=0))
    with caplog.at_level(logging.WARNING):
        client.get('/ping')
    assert 'slow request' in caplog.text


def test_trace_helpers_round_trip():
    token = trace.set_trace_id('custom-id')
    assert trace.get_trace_id() == 'custom-id'
    trace.reset_trace_id(token)
    bad_token = object()
    trace.reset_trace_id(bad_token)                       # 跨线程误用 → 清成默认
    assert trace.get_trace_id() == '-'
    assert trace.normalize('valid-id.1_2') == 'valid-id.1_2'
    generated = trace.normalize('invalid id!')
    assert len(generated) == 16
    assert trace.normalize('') == generated or len(trace.normalize('')) == 16
    assert trace.request_id_from(_request_for_path()) is None
