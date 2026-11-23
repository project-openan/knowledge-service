"""ES RESTful 客户端：认证头、错误分类、批量协议与 ik 插件探测（requests 全部打桩）。"""

from __future__ import annotations

import logging

import pytest
import requests

from infrastructure.search import elasticsearch as es_module
from infrastructure.search import es_restful
from infrastructure.search.es_restful import (
    CatNamespace,
    ESRestfulClient,
    ESRestfulClientWrapper,
    IndicesNamespace,
)


class FakeHttpResponse:
    def __init__(self, payload=None, text='', status_code=200):
        self._payload = payload
        self.text = text
        self.status_code = status_code

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            error = requests.exceptions.HTTPError('418 I am a teapot')
            error.response = self
            raise error


@pytest.fixture()
def http_calls(monkeypatch):
    calls = []

    def install(responder):
        def fake_request(method=None, url=None, headers=None, json=None,
                         params=None, timeout=None, **kwargs):
            calls.append({'method': method, 'url': url, 'headers': headers,
                          'json': json, 'params': params, 'timeout': timeout})
            return responder(calls[-1])

        def fake_post(url=None, headers=None, data=None, timeout=None, **kwargs):
            calls.append({'method': 'POST', 'url': url, 'headers': headers,
                          'json': None, 'data': data, 'params': None,
                          'timeout': timeout})
            return responder(calls[-1])

        def fake_head(url=None, headers=None, timeout=None, **kwargs):
            calls.append({'method': 'HEAD', 'url': url, 'headers': headers,
                          'json': None, 'params': None, 'timeout': timeout})
            return responder(calls[-1])

        monkeypatch.setattr(requests, 'request', fake_request)
        monkeypatch.setattr(requests, 'post', fake_post)
        monkeypatch.setattr(requests, 'head', fake_head)

    return install, calls


# ---------------------------------------------------------------------------
# 认证头
# ---------------------------------------------------------------------------

def test_api_key_auth_takes_priority():
    client = ESRestfulClient('es', 9200, user='u', password='p', api_key='KEY')
    assert client.base_url == 'http://es:9200'
    assert client.headers['Authorization'] == 'ApiKey KEY'
    assert client.headers['Content-Type'] == 'application/json'


def test_basic_auth_over_http_warns(caplog):
    with caplog.at_level(logging.WARNING):
        client = ESRestfulClient('es', 9200, user='u', password='p')
    assert client.headers['Authorization'].startswith('Basic ')
    assert 'insecure' in caplog.text.lower()

    caplog.clear()                                        # 只看 https 这一段
    with caplog.at_level(logging.WARNING):
        client_https = ESRestfulClient('es', 9200, user='u', password='p',
                                       scheme='https')
    assert client_https.base_url == 'https://es:9200'
    assert 'insecure' not in caplog.text.lower()


def test_no_auth_client():
    client = ESRestfulClient('es', 9200)
    assert 'Authorization' not in client.headers


# ---------------------------------------------------------------------------
# 请求与端点
# ---------------------------------------------------------------------------

def test_request_returns_json_and_copies_headers(http_calls):
    install, calls = http_calls
    install(lambda call: FakeHttpResponse(payload={'ok': 1}, text='{"ok": 1}'))
    client = ESRestfulClient('es', 9200, api_key='K')

    assert client._request('GET', 'idx/_search', data={'q': 1}, params={'size': 5}) == {'ok': 1}
    call = calls[0]
    assert call['url'] == 'http://es:9200/idx/_search'
    assert call['headers'] == client.headers              # 每次请求用副本
    assert call['headers'] is not client.headers
    assert call['timeout'] == 30 and call['params'] == {'size': 5}


def test_request_empty_response_returns_none(http_calls):
    install, _ = http_calls
    install(lambda call: FakeHttpResponse(payload=None, text=''))
    client = ESRestfulClient('es', 9200)
    assert client._request('DELETE', 'idx') is None


def test_request_error_logs_detail_and_reraises(http_calls):
    install, calls = http_calls

    def responder(call):
        response = FakeHttpResponse(payload={'error': 'detail'}, status_code=418)
        response.raise_for_status()
        return response

    install(responder)
    client = ESRestfulClient('es', 9200)
    with pytest.raises(requests.exceptions.RequestException):
        client._request('GET', 'idx')
    assert calls[0]['method'] == 'GET'


def test_request_error_logs_raw_text_when_body_is_not_json(http_calls):
    install, _ = http_calls

    def responder(call):
        response = FakeHttpResponse(payload=ValueError('not json'),
                                    text='<html>oops</html>', status_code=500)
        response.raise_for_status()
        return response

    install(responder)
    client = ESRestfulClient('es', 9200)
    with pytest.raises(requests.exceptions.RequestException):
        client._request('GET', 'idx')


def test_index_operations_choose_put_or_post(http_calls):
    install, calls = http_calls
    install(lambda call: FakeHttpResponse(payload={'result': 'created'}, text='{}'))
    client = ESRestfulClient('es', 9200)

    assert client.index('idx', {'a': 1}, id='7') == {'result': 'created'}
    assert calls[-1]['method'] == 'PUT'
    client.index('idx', {'a': 1})
    assert calls[-1]['method'] == 'POST'
    assert calls[-1]['url'].endswith('/idx/_doc')
    client.get('idx', '7')
    assert calls[-1]['method'] == 'GET'
    client.delete('idx', '7')
    assert calls[-1]['method'] == 'DELETE'


def test_search_joins_multi_index(http_calls):
    install, calls = http_calls
    install(lambda call: FakeHttpResponse(payload={'hits': []}, text='{}'))
    client = ESRestfulClient('es', 9200)
    assert client.search(['a', 'b'], body={'query': {}}) == {'hits': []}
    assert calls[-1]['url'].endswith('/a,b/_search')


def test_by_query_operations_send_conflicts_param(http_calls):
    install, calls = http_calls
    install(lambda call: FakeHttpResponse(payload={'deleted': 1}, text='{}'))
    client = ESRestfulClient('es', 9200)
    assert client.delete_by_query('idx', {'query': {}}) == {'deleted': 1}
    assert calls[-1]['params'] == {'conflicts': 'abort'}
    assert client.update_by_query('idx', {'query': {}}, conflicts='proceed') == {'deleted': 1}
    assert calls[-1]['params'] == {'conflicts': 'proceed'}


def test_bulk_sends_ndjson(http_calls):
    install, calls = http_calls
    install(lambda call: FakeHttpResponse(payload={'errors': False}, text='{}'))
    client = ESRestfulClient('es', 9200, api_key='K')

    assert client.bulk(['{"index":{}}', '{"a":1}']) == {'errors': False}
    assert calls[-1]['data'] == b'{"index":{}}\n{"a":1}\n'
    assert calls[-1]['headers']['Content-Type'] == 'application/x-ndjson'
    assert calls[-1]['headers']['Authorization'] == 'ApiKey K'
    assert calls[-1]['timeout'] == 60

    assert client.bulk('{"index":{}}\n') == {'errors': False}   # 字符串体原样发


def test_bulk_reraises_request_errors(http_calls):
    install, _ = http_calls
    install(lambda call: (_ for _ in ()).throw(requests.exceptions.ConnectTimeout('down')))
    client = ESRestfulClient('es', 9200)
    with pytest.raises(requests.exceptions.RequestException):
        client.bulk(['{}'])


def test_indices_exists_maps_status_codes(http_calls):
    install, calls = http_calls
    client = ESRestfulClient('es', 9200)

    install(lambda call: FakeHttpResponse(status_code=200))
    assert client.indices_exists('idx') is True
    install(lambda call: FakeHttpResponse(status_code=404))
    assert client.indices_exists('idx') is False
    install(lambda call: (_ for _ in ()).throw(requests.exceptions.ConnectionError('down')))
    assert client.indices_exists('idx') is False
    assert calls[-1]['method'] == 'HEAD'


def test_indices_helpers_default_empty_results(http_calls):
    install, _ = http_calls
    install(lambda call: FakeHttpResponse(text=''))
    client = ESRestfulClient('es', 9200)
    assert client.indices_create('idx') == {}
    assert client.indices_delete('idx') == {}
    assert client.indices_get_settings('idx') == {}
    assert client.indices_get_mapping('idx') == {}


def test_cat_plugins_only_accepts_lists(http_calls):
    install, _ = http_calls
    client = ESRestfulClient('es', 9200)

    install(lambda call: FakeHttpResponse(payload=[{'component': 'analysis-ik'}],
                                          text='[]'))
    assert client.cat_plugins() == [{'component': 'analysis-ik'}]
    install(lambda call: FakeHttpResponse(text=''))
    assert client.cat_plugins() == []
    install(lambda call: FakeHttpResponse(payload={'unexpected': 1}, text='{}'))
    assert client.cat_plugins() == []


# ---------------------------------------------------------------------------
# 兼容包装器
# ---------------------------------------------------------------------------

def test_wrapper_namespaces_delegate(http_calls):
    install, calls = http_calls

    def respond(call):
        payload = [{'component': 'analysis-ik'}] if '_cat/plugins' in call['url'] \
            else {'ok': 1}
        return FakeHttpResponse(payload=payload, text='{}')

    install(respond)
    wrapper = ESRestfulClientWrapper('es', 9200, api_key='K')

    assert isinstance(wrapper.indices, IndicesNamespace)
    assert isinstance(wrapper.cat, CatNamespace)
    assert wrapper.indices.exists('idx') is True
    assert wrapper.indices.create('idx') == {'ok': 1}
    assert wrapper.indices.delete('idx') == {'ok': 1}
    assert wrapper.indices.get_settings('idx') == {'ok': 1}
    assert wrapper.indices.get_mapping('idx') == {'ok': 1}
    assert wrapper.cat.plugins() == [{'component': 'analysis-ik'}]
    assert wrapper.search('idx') == {'ok': 1}
    assert wrapper.get('idx', '1') == {'ok': 1}
    assert wrapper.delete('idx', '1') == {'ok': 1}
    assert wrapper.delete_by_query('idx', {}) == {'ok': 1}
    assert wrapper.update_by_query('idx', {}) == {'ok': 1}
    assert wrapper.bulk(['{}']) == {'ok': 1}

    wrapper.index('idx', document={'doc': 1}, id='9')     # document 参数别名
    assert calls[-1]['json'] == {'doc': 1}
    wrapper.index('idx', body={'body': 1}, id='10')
    assert calls[-1]['json'] == {'body': 1}


# ---------------------------------------------------------------------------
# ik 插件探测与单例
# ---------------------------------------------------------------------------

class FakeCatNS:
    def __init__(self, client):
        self._client = client

    def plugins(self, format='json'):
        return self._client.cat_plugins(format)


class FakeEsClient:
    def __init__(self, plugins=None, error=None):
        self._plugins = plugins or []
        self._error = error
        self.cat = FakeCatNS(self)

    def cat_plugins(self, format='json'):
        if self._error is not None:
            raise self._error
        return self._plugins


def test_get_ik_analyzer_status():
    assert es_module.get_ik_analyzer_status(
        FakeEsClient([{'component': 'analysis-ik'}])) is True
    assert es_module.get_ik_analyzer_status(
        FakeEsClient([{'component': 'standard'}])) is False
    assert es_module.get_ik_analyzer_status(
        FakeEsClient(error=RuntimeError('es down'))) is False


def test_es_client_singleton_rebuilds_on_password_change(monkeypatch):
    monkeypatch.setattr(es_module, 'ES_DICT', {'host': 'es', 'port': '9200',
                                               'user': '', 'password': 'p1'})
    monkeypatch.setattr(es_module, 'get_ik_analyzer_status', lambda client: True)
    monkeypatch.setattr(es_module, 'ESRestfulClientWrapper',
                        lambda **kwargs: ('built', kwargs))
    monkeypatch.setattr(es_module.ESClientSingleton, '_instance', None, raising=False)

    singleton = es_module.ESClientSingleton()
    again = es_module.ESClientSingleton()
    assert again is singleton                             # 单例

    client = singleton.get_client()
    assert client == ('built', {'host': 'es', 'port': '9200', 'user': '',
                                'password': 'p1', 'scheme': 'http'})
    assert singleton.get_analysis_ik() is True
    assert singleton.get_client() is client              # 密码没变 → 复用

    monkeypatch.setattr(es_module, 'ES_DICT', {'host': 'es', 'port': '9200',
                                               'user': '', 'password': 'p2'})
    rebuilt = singleton.get_client()
    assert rebuilt != client                             # 密码变了 → 重建


def test_cat_plugins_response_is_iterable():
    from infrastructure.search.es_restful import CatPluginsResponse
    response = CatPluginsResponse([{'component': 'a'}, {'component': 'b'}])
    assert list(response) == [{'component': 'a'}, {'component': 'b'}]
