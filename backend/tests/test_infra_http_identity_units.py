"""HTTP 公共件：身份解析、Cookie、DT 头装配、出站代理策略。"""

from __future__ import annotations

import pytest
from starlette.requests import Request

from infrastructure.http import client as http_client
from infrastructure.http import cookies, egress, headers as httputil
from infrastructure.http import request_header_util
from infrastructure.http import request_headers as em_headers
from infrastructure.http.identity import (
    base_bundle,
    current_user,
    header_language,
    language,
)


def _request(headers=None, state=None, path='/x'):
    flat = []
    for name, value in (headers or {}).items():
        flat.append((name.lower().encode(), value.encode()))
    scope = {'type': 'http', 'method': 'GET', 'path': path,
             'headers': flat, 'query_string': b''}
    request = Request(scope)
    if state:
        for key, value in state.items():
            setattr(request.state, key, value)
    return request


# ---------------------------------------------------------------------------
# identity：当前用户与语言
# ---------------------------------------------------------------------------

def test_header_language_requires_org_id():
    assert header_language(_request({'language-option': 'zh-CN'})) == 'en-US'
    assert header_language(_request({'X-Org-Id': '', 'language-option': 'zh-CN'})) == 'en-US'
    assert header_language(_request({'X-Org-Id': '1', 'language-option': 'zh-CN'})) == 'zh-CN'
    assert header_language(_request({'X-Org-Id': '1'})) == 'en-US'


def test_current_user_prefers_session_principal():
    principal = type('P', (), {'username': 'session-user'})()
    request = _request({'X-Emp-No': 'forged'}, state={'auth_user': principal})
    assert current_user(request) == 'session-user'


def test_current_user_local_mode_without_session_returns_empty(monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'local')
    assert current_user(_request({'X-Emp-No': 'forged'})) == ''


def test_current_user_gateway_mode_uses_headers_then_default(monkeypatch):
    monkeypatch.setenv('AUTH_MODE', 'gateway')
    monkeypatch.delenv('AUTH_DEFAULT_USER', raising=False)
    assert current_user(_request({'X-Emp-No': ' 1001 '})) == '1001'
    assert current_user(_request({'username': 'web-user'})) == 'web-user'
    assert current_user(_request({})) == 'admin'

    monkeypatch.setenv('AUTH_DEFAULT_USER', 'fallback')
    assert current_user(_request({})) == 'fallback'


def test_language_and_base_bundle_normalization():
    assert language(_request({'Accept-Language': 'zh-CN'})) == 'zh'
    assert language(_request({'Accept-Language': 'zh'})) == 'en'
    assert language(_request()) == 'en'
    assert base_bundle(_request({'Accept-Language': '*'})) is True
    assert base_bundle(_request({'Accept-Language': 'zh-CN'})) is False


def test_preferred_tag_handles_bad_quality_values():
    from infrastructure.http.identity import _preferred_tag
    assert _preferred_tag('en;q=zz, zh-CN') == 'zh-CN'    # 坏 q 值按 0 处理
    assert _preferred_tag('en;q=0.5, zh-CN;q=0.5') == 'en'  # 同 q 先出现者优先
    assert _preferred_tag('') == ''
    assert _preferred_tag(None) == ''


# ---------------------------------------------------------------------------
# cookies：DT 两种 Cookie 布局
# ---------------------------------------------------------------------------

def test_get_cookie_value_exact_name_wins_over_suffixed():
    header = 'forgerydefense-28001=suffix; forgerydefense=exact'
    assert cookies.get_cookie_value(header, 'forgerydefense') == 'exact'
    assert cookies.get_cookie_value('forgerydefense-28001=suffix', 'forgerydefense') == 'suffix'
    assert cookies.get_cookie_value('a=1; b=2', 'missing') is None
    assert cookies.get_cookie_value('', 'a') is None
    assert cookies.get_cookie_value('a=1', '') is None
    assert cookies.get_cookie_value('noseparator', 'a') is None


# ---------------------------------------------------------------------------
# request_header_util：username 归属与 forgerydefense 防伪
# ---------------------------------------------------------------------------

def test_get_auth_name_reads_username_header():
    assert request_header_util.get_auth_name({'username': 'alice'}) == 'alice'
    with pytest.raises(Exception):
        request_header_util.get_auth_name({'username': ''})


def test_check_forgerydefense_rules():
    from fastapi import HTTPException

    def req(headers):
        return Request({'type': 'http', 'method': 'GET', 'path': '/',
                        'headers': headers, 'query_string': b''}).headers

    request_header_util._check_forgerydefense(req([]))          # 无 z-extent 放行

    with pytest.raises(HTTPException) as error:
        request_header_util._check_forgerydefense(req([(b'z-extent', b'1')]))
    assert error.value.status_code == 403                    # 有 z-extent 无防伪头

    mismatch = req([(b'z-extent', b'1'), (b'forgerydefense', b'head'),
                    (b'cookie', b'forgerydefense=cookie')])
    with pytest.raises(HTTPException):
        request_header_util._check_forgerydefense(mismatch)

    matching = req([(b'z-extent', b'1'), (b'forgerydefense', b'same'),
                    (b'cookie', b'forgerydefense=same')])
    request_header_util._check_forgerydefense(matching)      # 头与 Cookie 一致 → 放行


# ---------------------------------------------------------------------------
# headers / request_headers / client：DT 头装配
# ---------------------------------------------------------------------------

def _em():
    return em_headers.EMRequestHeaders()


def test_build_http_headers_maps_dt_headers():
    raw = {
        'username': '%E5%BC%A0%E4%B8%89',                # URL 编码的中文
        'tenant-id': 't1',
        'language-option': 'zh-CN',
        'X-Forwarded-For': '10.0.0.1',
        'Z-CONNECT-MODE': '1',
        'TransactionID': 'tx-9',
        'Cookie': 'z-auth-code=abc',
    }
    built = httputil.build_http_headers(raw)
    assert built.username == '张三'
    assert built.tenant_id == 't1'
    assert built.language_option == 'zh'
    assert built.client_ip == '10.0.0.1'
    assert built.connect_mode == '1'
    assert built.transaction_id == 'tx-9'
    assert built.mode == '0'                              # 缺 mode 回落
    assert built.cookie == 'z-auth-code=abc'

    payload = http_client.build_headers(built)
    assert payload['TransactionID'] == 'tx-9'
    assert payload['language-option'] == 'zh'


def test_header_helpers_fallbacks():
    assert httputil.get_mode({}) == '0'
    assert httputil.get_mode({'mode': '1'}) == '1'
    assert httputil.get_language_option({}) == 'en'
    assert httputil.get_language_option({'language-option': 'en-US'}) == 'en'
    assert httputil.get_client_ip({}) == ''
    assert httputil.get_client_ip({'client-ip': '1.2.3.4'}) == '1.2.3.4'
    assert httputil.is_success(200) and httputil.is_success('201')
    assert not httputil.is_success(499)

    empty_tenant = httputil.get_tenant_id({'Cookie': 'tenantId=from-cookie'})
    assert empty_tenant == 'from-cookie'
    assert httputil.get_tenant_id({}) == ''
    assert httputil.decode_url_unicode('plain') == 'plain'


def test_em_request_headers_setters_and_mode_guard():
    headers = _em()
    headers.set_username('u')
    headers.set_tenant_id('t')
    headers.set_language_option('zh-CN')
    headers.set_client_ip('ip')
    headers.set_connect_mode('cm')
    headers.set_timezone_info('tz')
    headers.set_mode('1')
    headers.set_cookie('c')
    headers.set_transaction_id('custom')
    assert (headers.get_username(), headers.get_language_option()) == ('u', 'zh-CN')
    assert (headers.get_client_ip(), headers.get_connect_mode()) == ('ip', 'cm')
    assert (headers.get_transaction_id(), headers.get_mode()) == ('custom', '1')
    assert headers.get_timezone_info() == 'tz'
    headers.set_transaction_id('')                        # 空值不覆盖
    assert headers.get_transaction_id() == 'custom'
    with pytest.raises(Exception):
        headers.mode = '9'
        headers.check_param()


def test_client_check_status_code_raises_on_bad_status():
    http_client.check_status_code(200, 'svc')
    with pytest.raises(Exception):
        http_client.check_status_code(503, 'svc')


# ---------------------------------------------------------------------------
# egress：私网直连
# ---------------------------------------------------------------------------

def test_is_private_host_classification():
    assert egress.is_private_host('localhost')
    assert egress.is_private_host('a.localhost.')
    assert egress.is_private_host('model-gateway')        # 单标签 compose 服务名
    assert egress.is_private_host('10.1.2.3')
    assert egress.is_private_host('192.168.1.1')
    assert egress.is_private_host('172.16.0.9')
    assert egress.is_private_host('127.0.0.1')
    assert egress.is_private_host('169.254.1.1')
    assert egress.is_private_host('fd00::1')
    assert egress.is_private_host('[::1]')
    assert not egress.is_private_host('example.com')
    assert not egress.is_private_host('')
    assert not egress.is_private_host('8.8.8.8')


def test_request_proxies_disables_for_private_only():
    assert egress.request_proxies('http://10.0.0.5:8080/v1') == {'http': None, 'https': None}
    assert egress.request_proxies('https://api.example.com') == {}


def test_egress_get_post_inject_proxies(monkeypatch):
    seen = {}

    def fake_get(url, **kwargs):
        seen['get'] = (url, kwargs.get('proxies'))
        return 'get-result'

    def fake_post(url, **kwargs):
        seen['post'] = (url, kwargs.get('proxies'))
        return 'post-result'

    monkeypatch.setattr(egress.requests, 'get', fake_get)
    monkeypatch.setattr(egress.requests, 'post', fake_post)

    assert egress.get('http://127.0.0.1:9200') == 'get-result'
    assert egress.post('https://api.example.com', timeout=1) == 'post-result'
    assert seen['get'][1] == {'http': None, 'https': None}
    assert seen['post'][1] == {}                          # 公网交给环境代理
