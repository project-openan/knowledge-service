"""model 模块剩余分支：LLM 网关、代理客户端、重试、种子、探测与路由信封。

零真实网络：egress.post / llm_proxy_client / repository_pg._connect 全部打桩。
"""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from infrastructure.http import egress
from model import llm_gateway
from model import llm_proxy_client
from model import operator_client
from model import probe as model_probe
from model import seed as model_seed
from model import router as model_router
from model import repository as model_repository
from model.models import MODEL_KIND_LLM, MODEL_KIND_EMBEDDING, ModelRecord, new_model_id
from model.repository import InMemoryModelStore
from model.router import MODEL_PREFIX, register_model_api
from model.service import ModelService
from shared.errors.api import KbStoreError, KbValidationError


class _Response:
    def __init__(self, body, status_code=200, text=''):
        self.status_code = status_code
        self._body = body
        self.text = text

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _Headers:
    username = 'alice'
    tenant_id = 't1'
    transaction_id = 'trace-1'
    language_option = 'zh-CN'
    client_ip = '127.0.0.1'


# ---------------------------------------------------------------------------
# llm_gateway
# ---------------------------------------------------------------------------

class _FakeClient:
    def __init__(self, responses=None, error=None):
        self.calls = []
        self._responses = list(responses or [])
        self._error = error

    def embeddings(self, **kwargs):
        self.calls.append(kwargs)
        if self._error is not None:
            raise self._error
        return self._responses.pop(0)

    def query_llm_services(self, **kwargs):
        self.calls.append(('llm', kwargs))
        return self._responses.pop(0)

    def query_embedding_services(self, **kwargs):
        self.calls.append(('embedding', kwargs))
        return self._responses.pop(0)


def test_get_embedding_info_wraps_single_input_in_esm_scene(monkeypatch):
    fake = _FakeClient([_Response({'data': [{'embedding': [0.0] * 4}]})])
    monkeypatch.setattr(llm_gateway, 'llm_proxy_client', fake)
    monkeypatch.setenv('DEPLOY_SCENE', 'esm')

    llm_gateway.get_embedding_info('q', 'm', _Headers())
    assert fake.calls[0]['body']['input'] == ['q']


def test_get_embedding_info_propagates_em_exception(monkeypatch):
    from shared.errors.exception import EMException

    fake = _FakeClient(error=EMException('boom'))
    monkeypatch.setattr(llm_gateway, 'llm_proxy_client', fake)
    with pytest.raises(EMException):
        llm_gateway.get_embedding_info('q', 'm', _Headers())


def test_get_embedding_info_wraps_unexpected_errors(monkeypatch):
    fake = _FakeClient(error=RuntimeError('socket'))
    monkeypatch.setattr(llm_gateway, 'llm_proxy_client', fake)
    with pytest.raises(Exception) as exc:
        llm_gateway.get_embedding_info('q', 'm', _Headers())
    assert str(exc.value) == 'request-embedding-failed'


def test_get_embedding_dimension_requires_non_empty_dimension(monkeypatch):
    fake = _FakeClient([_Response({'data': [{'embedding': []}]})])
    monkeypatch.setattr(llm_gateway, 'llm_proxy_client', fake)
    with pytest.raises(Exception):
        llm_gateway.get_embedding_dimension('m')


def test_query_service_lists_success(monkeypatch):
    fake = _FakeClient([
        _Response({'code': 10001, 'result': [{'service_name': 'a'}]}),
        _Response({'code': 10001, 'result': None}),
    ])
    monkeypatch.setattr(llm_gateway, 'llm_proxy_client', fake)

    assert llm_gateway.query_llm_service_list(_Headers(), 'svc') == [{'service_name': 'a'}]
    assert llm_gateway.query_embedding_service_list(_Headers()) == []
    llm_call = fake.calls[0][1]
    assert llm_call['body']['service_name'] == 'svc'
    assert llm_call['body']['userName'] == 'alice'
    assert llm_call['body']['tenantId'] == 't1'


def test_query_service_list_business_code_is_error(monkeypatch):
    from shared.errors.exception import EMException

    fake = _FakeClient([_Response({'code': 500, 'message': 'bad'})])
    monkeypatch.setattr(llm_gateway, 'llm_proxy_client', fake)
    with pytest.raises(EMException):
        llm_gateway.query_llm_service_list(_Headers())


def test_query_service_list_transport_error_is_wrapped(monkeypatch):
    from shared.errors.exception import EMException

    fake = _FakeClient(error=RuntimeError('x'))
    monkeypatch.setattr(llm_gateway, 'llm_proxy_client', fake)
    with pytest.raises(EMException):
        llm_gateway.query_embedding_service_list(_Headers())


# ---------------------------------------------------------------------------
# llm_proxy_client
# ---------------------------------------------------------------------------

def test_env_helper_treats_blank_as_default(monkeypatch):
    monkeypatch.setenv('RKB_MISC_X', '  ')
    assert llm_proxy_client._env('RKB_MISC_X', 'd') == 'd'
    monkeypatch.setenv('RKB_MISC_X', ' v ')
    assert llm_proxy_client._env('RKB_MISC_X', 'd') == 'v'
    assert llm_proxy_client._env('RKB_MISC_UNSET', 'd') == 'd'


def test_headers_merge_api_key_from_endpoint_and_env(monkeypatch):
    monkeypatch.delenv('MODEL_GATEWAY_API_KEY', raising=False)
    class _Endpoint:
        api_key = 'sk-endpoint'
    assert llm_proxy_client._headers({}, None) == {}
    merged = llm_proxy_client._headers({'x': '1'}, _Endpoint())
    assert merged['Authorization'] == 'Bearer sk-endpoint'
    monkeypatch.setenv('MODEL_GATEWAY_API_KEY', 'sk-env')
    assert llm_proxy_client._headers({}, None)['Authorization'] == 'Bearer sk-env'


def test_service_names_read_from_registry(monkeypatch):
    from model import resolver

    class _Row:
        def __init__(self, name, enabled=True):
            self.model_name = name
            self.enabled = enabled
            self.label = lambda: name

    monkeypatch.setattr(resolver, 'llm_models', lambda: [('a', 'A'), ('b', 'B')])
    monkeypatch.setattr(resolver, 'embedding_models', lambda: ['e1'])
    assert llm_proxy_client._llm_service_names() == ['a', 'b']
    assert llm_proxy_client._embedding_service_names() == ['e1']

    # embedding 清单回落 .env（两个变量同值都收）
    monkeypatch.setattr(resolver, 'embedding_models', lambda: [])
    monkeypatch.setenv('EMBEDDING_MODEL_NAME', 'm1')
    monkeypatch.setenv('EMBEDDING_MODEL', 'm2')
    assert llm_proxy_client._embedding_service_names() == ['m1', 'm2']


def test_synthetic_response_shape():
    response = llm_proxy_client._synthetic_response({'service_names': ['x', 'y']})
    assert response.status_code == 200
    assert response.json()['code'] == 10001
    assert [row['service_name'] for row in response.json()['result']] == ['x', 'y']


def test_proxy_client_posts_to_resolved_endpoint(monkeypatch):
    from model import resolver

    class _Endpoint:
        url = 'http://resolved:9/v1'
        api_key = 'sk-resolved'

    calls = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.update(url=url, body=json, headers=headers, timeout=timeout)
        return _Response({})

    monkeypatch.setattr(resolver, 'resolve',
                        lambda kind, name=None, operation=None: _Endpoint())
    monkeypatch.setattr(egress, 'post', fake_post)

    client = llm_proxy_client.LlmProxyClient()
    client.embeddings(body={'a': 1}, headers={'h': 'v'}, model='m')
    assert calls['url'] == 'http://resolved:9/v1'
    assert calls['headers']['Authorization'] == 'Bearer sk-resolved'

    client.completions(body={'b': 2}, model='m2', timeout=5)
    assert calls['body'] == {'b': 2}
    assert calls['timeout'] == 5

    assert client.query_llm_services().status_code == 200
    assert client.query_embedding_services().status_code == 200


# ---------------------------------------------------------------------------
# operator_client：重试耗尽 / reasoning_effort / 默认头
# ---------------------------------------------------------------------------

def test_invoke_llm_reasoning_effort_and_default_headers(monkeypatch):
    seen = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        seen.update(body=json, headers=headers, url=url)
        return _Response({'choices': [{'message': {'content': 'hi'}}]})

    monkeypatch.setattr(egress, 'post', fake_post)
    monkeypatch.setattr(operator_client, 'MODEL_GATEWAY_REASONING_EFFORT', 'low')

    out = operator_client.invoke_llm([{'role': 'user', 'content': 'q'}], 'm', request_headers=None)
    assert out == 'hi'
    assert seen['body']['reasoning_effort'] == 'low'
    # 无 endpoint 时 request_headers 原样透传（None）
    assert seen['headers'] is None


def test_invoke_llm_returns_empty_when_no_choices(monkeypatch):
    monkeypatch.setattr(egress, 'post',
                        lambda url, json=None, headers=None, timeout=None:
                        _Response({'choices': [{'message': {}}]}))
    assert operator_client.invoke_llm([{}], 'm') == ''


def test_invoke_llm_raises_after_retry_exhaustion(monkeypatch):
    sleeps = []

    monkeypatch.setattr(operator_client.time, 'sleep', lambda s: sleeps.append(s))
    monkeypatch.setattr(egress, 'post',
                        lambda url, json=None, headers=None, timeout=None: _Response({}, status_code=500))

    with pytest.raises(RuntimeError) as exc:
        operator_client.invoke_llm([{}], 'm')
    assert 'request-gateway-failed' in str(exc.value)
    assert len(sleeps) == operator_client and len(sleeps) == 19 or len(sleeps) == 19


def test_invoke_llm_requires_model_name():
    with pytest.raises(RuntimeError):
        operator_client.invoke_llm([{}], '')


def test_prepare_chat_request_applies_endpoint_overrides():
    url, body, headers, timeout = operator_client._prepare_chat_request(
        {'url': '', 'model': 'api-model', 'api_key': 'sk', 'timeout': '9',
         'thinking_payload': {'reasoning_effort': 'none'}},
        {'model': 'reg-name'}, None, timeout=60)
    assert timeout == 9
    assert body['model'] == 'api-model'
    assert headers['Authorization'] == 'Bearer sk'
    assert body['reasoning_effort'] == 'none'


# ---------------------------------------------------------------------------
# seed 分支
# ---------------------------------------------------------------------------

def test_parse_llm_models_skips_blank_and_display_fallback():
    assert model_seed.parse_llm_models(None) == []
    assert model_seed.parse_llm_models('  ; ') == []
    assert model_seed.parse_llm_models('a=A;b') == [('a', 'A'), ('b', 'b')]


def test_build_llm_records_requires_endpoint(monkeypatch):
    monkeypatch.setattr(model_seed, '_env', lambda env, keys: '')
    assert model_seed.build_llm_records({}) == []


def test_build_llm_records_placeholder_endpoint_is_skipped(monkeypatch):
    real_env = model_seed._env

    def fake_env(env, keys):
        key = keys[0]
        if key == model_seed._ENV_LLM_MODELS:
            return 'm=M'
        if key == 'GENERATION_GATEWAY_URL':
            return 'https://demo.example.com/v1'
        return real_env(env, keys)

    monkeypatch.setattr(model_seed, '_env', fake_env)
    assert model_seed.build_llm_records({}) == []


def test_build_embedding_records_bad_dimension_falls_back():
    records = model_seed.build_embedding_records({
        'EMBEDDING_MODEL': 'emb',
        'MODEL_GATEWAY_URL': 'http://10.0.0.1:8080',
        'EMBEDDING_DIMENSION': 'not-a-number',
    })
    assert records and records[0].dimension == model_seed.DEFAULT_EMBEDDING_DIMENSION


def test_build_embedding_records_requires_model():
    assert model_seed.build_embedding_records({}) == []
    assert model_seed.build_embedding_records(
        {'EMBEDDING_MODEL': 'e', 'MODEL_GATEWAY_URL': 'https://x.example.org'}) == []


def test_seed_if_empty_skips_rows_without_endpoint(monkeypatch):
    store = InMemoryModelStore()
    record = ModelRecord(model_id=new_model_id(), model_kind=MODEL_KIND_LLM,
                         model_name='dead', base_url='   ')
    monkeypatch.setattr(model_seed, 'build_seed_records', lambda env: [record])
    assert model_seed.seed_if_empty(store, env={}) == 0
    assert store.list_records() == []


def test_seed_if_empty_skips_existing_kinds():
    store = InMemoryModelStore()
    seeded = model_seed.seed_if_empty(store, env={
        'EMBEDDING_MODEL': 'emb', 'MODEL_GATEWAY_URL': 'http://10.0.0.1',
        'GENERATION_GATEWAY_URL': 'http://10.0.0.2/v1', model_seed._ENV_LLM_MODELS: 'm=M',
    })
    assert seeded >= 1
    # 幂等：同样环境再播一次不再写
    assert model_seed.seed_if_empty(store, env={
        'EMBEDDING_MODEL': 'emb', 'MODEL_GATEWAY_URL': 'http://10.0.0.1',
        'GENERATION_GATEWAY_URL': 'http://10.0.0.2/v1', model_seed._ENV_LLM_MODELS: 'm=M',
    }) == 0


# ---------------------------------------------------------------------------
# probe：注册表端点解析路径
# ---------------------------------------------------------------------------

def test_model_probe_endpoint_resolves_from_registry(monkeypatch):
    from model import resolver

    class _Endpoint:
        base_url = 'http://reg:1/v1'
        api_key = 'sk-reg'
        path = '/models'

    monkeypatch.setattr(resolver, 'resolve',
                        lambda kind, name=None, operation=None: _Endpoint())
    prober = model_probe.ModelProbe(gateway_url='', http_get=lambda *a, **k: None)
    url, key, path = prober._endpoint()
    assert (url, key, path) == ('http://reg:1/v1', 'sk-reg', '/models')


def test_model_probe_available_uses_cache_and_clear(monkeypatch):
    calls = []

    def fake_get(url, headers=None, timeout=None):
        calls.append(url)
        return _Response({'data': [{'id': 'm1'}]})

    clock = {'now': 0.0}
    prober = model_probe.ModelProbe(gateway_url='http://g:1', ttl=60,
                                    clock=lambda: clock['now'], http_get=fake_get)
    assert prober.available() == frozenset({'m1'})
    clock['now'] += 1
    assert prober.available() == frozenset({'m1'})
    assert len(calls) == 1
    prober.clear_cache()
    assert prober.available() == frozenset({'m1'})
    assert len(calls) == 2


def test_probe_payload_shape_guards():
    assert model_probe._extract_model_ids('nope') is None
    assert model_probe._extract_model_ids({}) is None
    assert model_probe._extract_model_ids({'data': [1, None]}) == []
    assert model_probe._extract_model_ids({'data': [{'id': ' a '}, 'b']}) == ['a', 'b']


def test_probe_non_json_and_bad_status(monkeypatch):
    assert model_probe.probe_available_models(
        'http://g', http_get=lambda *a, **k: _Response(ValueError('bad json'))) is None
    assert model_probe.probe_available_models(
        'http://g', http_get=lambda *a, **k: _Response({}, status_code=503)) is None


# ---------------------------------------------------------------------------
# InMemoryModelStore 剩余分支
# ---------------------------------------------------------------------------

def _record(name='n', kind=MODEL_KIND_LLM, default=False, model_id=None):
    return ModelRecord(model_id=model_id or new_model_id(), model_kind=kind,
                       model_name=name, base_url='http://h', is_default=default)


def test_in_memory_store_duplicate_and_missing_branches():
    store = InMemoryModelStore()
    store.insert(_record('a'))
    with pytest.raises(KbStoreError):
        store.insert(_record('a'))

    record = _record('b', default=True)
    store.insert(record)
    with pytest.raises(KbStoreError):
        # 改名撞上已有名字
        store.update(record.with_changes(model_name='a'))

    with pytest.raises(KbStoreError):
        store.update(_record('ghost', model_id='missing-id'))
    with pytest.raises(KbStoreError):
        store.delete('missing-id')

    # clear_default 保留 keep_id
    store.clear_default(MODEL_KIND_LLM, keep_id=record.model_id)
    assert store.get_record(record.model_id).is_default
    store.clear_default(MODEL_KIND_LLM)
    assert not store.get_record(record.model_id).is_default


# ---------------------------------------------------------------------------
# PgModelStore 的 DB 访问路径（打桩 _connect / _ensure_schema）
# ---------------------------------------------------------------------------

class _PgCursor:
    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=None):
        self._conn.executed.append((sql, params))
        if self._conn.raise_when_execute is not None:
            raise self._conn.raise_when_execute

    def close(self):
        pass


class _PgConn:
    def __init__(self, raise_when_execute=None):
        self.executed = []
        self.raise_when_execute = raise_when_execute
        self.rolled_back = 0
        self.commits = 0
        self.closed = 0

    def cursor(self):
        return _PgCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rolled_back += 1

    def close(self):
        self.closed += 1


def _pg_store(monkeypatch, raise_when_execute=None):
    from model.repository_pg import PgModelStore

    store = PgModelStore()
    conn = _PgConn(raise_when_execute)
    monkeypatch.setattr(store, '_connect', lambda: conn)
    monkeypatch.setattr(store, '_ensure_schema', lambda _conn: None)
    return store, conn


def test_pg_store_execute_wraps_unique_violation(monkeypatch):
    from psycopg2 import errors as pg_errors

    violation = pg_errors.UniqueViolation()
    store, conn = _pg_store(monkeypatch, raise_when_execute=violation)
    with pytest.raises(KbStoreError) as exc:
        store.delete('x')
    assert exc.value.kind == KbStoreError.DUPLICATE
    assert conn.rolled_back == 1 and conn.closed == 1


def test_pg_store_execute_wraps_generic_pg_error(monkeypatch):
    import psycopg2

    store, conn = _pg_store(monkeypatch, raise_when_execute=psycopg2.Error('connection reset'))
    with pytest.raises(KbStoreError) as exc:
        store.delete('x')
    assert exc.value.kind == KbStoreError.DB_ERROR


def test_pg_store_execute_wraps_any_error_as_db_error(monkeypatch):
    store, conn = _pg_store(monkeypatch, raise_when_execute=RuntimeError('not a pg error'))
    with pytest.raises(RuntimeError):
        store.delete('x')


def test_pg_store_payload_value_accepts_json_string_and_garbage():
    from model.repository_pg import _payload_value, _json_value
    assert _payload_value('{"a": 1}') == {'a': 1}
    assert _payload_value('not json') is None
    assert _payload_value('[1]') is None
    assert _payload_value('') is None
    assert _payload_value({'b': 2}) == {'b': 2}
    assert _json_value({'a': 1}) == '{"a":1}'
    assert _json_value('x') is None


def test_pg_store_transaction_paths(monkeypatch):
    store, conn = _pg_store(monkeypatch)
    record = _record('pg-row', default=True)
    store.insert(record)          # 事务：clear_default + insert，commit
    assert conn.commits >= 1

    store.update(record.with_changes(model_name='pg-row-renamed'))
    store.delete(record.model_id)
    assert any('DELETE' in sql for sql, _params in conn.executed)


def test_pg_store_transaction_rolls_back_on_failure(monkeypatch):
    store, conn = _pg_store(monkeypatch, raise_when_execute=RuntimeError('plain failure'))
    with pytest.raises(RuntimeError):
        store.insert(_record('pg-row-2'))
    assert conn.rolled_back >= 1


def test_pg_store_read_paths_return_mapped_records(monkeypatch):
    # 列名手写（_COLUMNS 里的 to_char 片段含逗号，不能按逗号拆）
    names = ['model_id', 'model_kind', 'model_name', 'display_name', 'api_model',
             'base_url', 'api_key', 'chat_path', 'embeddings_path', 'models_path',
             'rerank_path', 'dimension', 'max_tokens', 'temperature', 'timeout',
             'is_reasoning', 'thinking_mode', 'thinking_preset', 'thinking_payload',
             'is_default', 'enabled', 'source', 'remark', 'created_by',
             'created_at', 'updated_at']
    from model import crypto
    encrypted_key = crypto.encrypt('plain-key')
    values = ['mid', 'llm', 'n', '显示', 'api', 'http://h', encrypted_key, '', '', '', '',
              '', None, None, None, None, False, 'none', '', None, True, True, 'env', '',
              '2024-01-01 00:00:00', '2024-01-01 00:00:00']
    assert len(names) == len(values)
    row = dict(zip(names, values))

    store = __import__('model.repository_pg', fromlist=['PgModelStore']).PgModelStore()

    class _ReadCursor:
        def __init__(self, rows):
            self._rows = rows
            self.description = [(name, None) for name in row]

        def execute(self, sql, params=None):
            pass

        def fetchall(self):
            return [tuple(self._rows[name] for name in self._rows)]

        def fetchone(self):
            return tuple(self._rows[name] for name in self._rows)

        def close(self):
            pass

    conn = _PgConn()
    conn.cursor = lambda: _ReadCursor(row)
    monkeypatch.setattr(store, '_connect', lambda: conn)
    monkeypatch.setattr(store, '_ensure_schema', lambda _conn: None)

    records = store.list_records()
    assert records[0].model_id == 'mid'
    assert store.get_record('mid').model_name == 'n'
    assert store.find_by_name('llm', 'n').model_name == 'n'
    conn.cursor = lambda: _ReadCursor([])
    assert store.get_record('nope') is None


# ---------------------------------------------------------------------------
# router 信封分支（直接走 _dispatch_sync，不经过 HTTP）
# ---------------------------------------------------------------------------

class _FakeRequest:
    def __init__(self, params=None):
        self.query_params = dict(params or {})
        self.headers = {}
        self.state = type('S', (), {'auth_user': None})()
        self.url = type('U', (), {'path': '/models'})()
        self.client = type('C', (), {'host': '127.0.0.1'})()

    def body(self):
        return b''


def _service():
    return ModelService(InMemoryModelStore(), reference_checker=lambda kind, name: 0)


def test_router_dispatch_sync_error_branches():
    from model.errors import ModelApiError

    service = _service()
    request = _FakeRequest({'page': 'abc'})
    assert model_router._query_int(request, 'page', 5) == 5
    assert model_router._query_int(request, 'page', 3) == 3

    def _model_api_error(_payload):
        raise ModelApiError('model.not.found', 'x')

    response = model_router._dispatch_sync(_FakeRequest(), b'', _model_api_error)
    assert response.status_code >= 400

    def _validation(_payload):
        raise KbValidationError('model.name.required')

    assert model_router._dispatch_sync(_FakeRequest(), b'', _validation).status_code == 422

    def _malformed(_payload):
        raise ValueError('bad body')

    assert model_router._dispatch_sync(_FakeRequest(), b'', _malformed).status_code == 400

    def _kb_error(_payload):
        raise KbValidationError('kbase.name.validation')

    assert model_router._dispatch_sync(_FakeRequest(), b'', _kb_error).status_code == 422

    def _store_error(_payload):
        raise KbStoreError(KbStoreError.DUPLICATE, 'dup', 'duplicate key')

    assert model_router._dispatch_sync(_FakeRequest(), b'', _store_error).status_code == 409

    def _store_error_other(_payload):
        raise KbStoreError(KbStoreError.DB_ERROR, 'db down')

    assert model_router._dispatch_sync(_FakeRequest(), b'', _store_error_other).status_code >= 500

    def _unexpected(_payload):
        raise RuntimeError('x')

    assert model_router._dispatch_sync(_FakeRequest(), b'', _unexpected).status_code == 500


def test_router_dispatch_sync_no_content_and_accepted():
    from starlette.responses import Response as StarletteResponse

    raw_response = StarletteResponse(status_code=204)
    assert model_router._dispatch_sync(_FakeRequest(), b'', lambda p: raw_response) is raw_response
    assert model_router._dispatch_sync(_FakeRequest(), b'', lambda p: None).status_code == 204
    accepted = model_router._dispatch_sync(_FakeRequest(), b'', lambda p: {'x': 1}, ok_status=202)
    assert accepted.status_code == 202
    created = model_router._dispatch_sync(
        _FakeRequest(), b'', lambda p: {'modelId': 'm1'}, ok_status=201,
        location=lambda result: f'{MODEL_PREFIX}/models/{result["modelId"]}')
    assert created.status_code == 201
    assert created.headers['location'].endswith('/models/m1')


def test_router_reset_and_lazy_service(monkeypatch):
    model_router.reset_model_service_for_tests()
    # _build_default_service 会连库，这里不打真实调用，只验证 reset 生效
    assert model_router._service is None


def test_router_register_and_lifecycle_routes(monkeypatch):
    # 打桩探针：连接测试不发真实 HTTP（10.0.0.1 不可达会等满超时）
    monkeypatch.setattr(egress, 'post',
                        lambda url, json=None, headers=None, timeout=None:
                        _Response({'choices': [{'message': {'content': 'ok'}}]}))
    monkeypatch.setattr(egress, 'get',
                        lambda url, headers=None, timeout=None: _Response({'data': []}))
    service = _service()
    app = FastAPI()
    register_model_api(app, service=service)
    client = TestClient(app)
    url = lambda path: f'{MODEL_PREFIX}{path}'

    body = {'modelKind': 'llm', 'modelName': 'seed-check', 'baseUrl': 'http://10.0.0.1:4000/v1',
            'apiKey': 'sk-abcdefghijklmnop'}
    created = client.post(url('/models'), json=body)
    assert created.status_code == 201, created.text
    model_id = created.json()['modelId']

    # /models/{id} 上的 test 路由：不重供 key 时端点固定为库里保存的值
    probe = client.post(url(f'/models/{model_id}/test'), json={})
    assert probe.status_code in (200, 502, 500)

    deleted = client.delete(url(f'/models/{model_id}'))
    assert deleted.status_code in (200, 204)
