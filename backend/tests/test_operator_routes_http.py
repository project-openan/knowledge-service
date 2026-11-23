"""算子注册 HTTP 层（``operators.api``）的路由测试。

不连库：``operator_service`` 的入口函数全部用假的替换，这一层钉的是
**路由行为**——query 参数映射、状态码（201/204/403/415）、Location 头、
下载端点出错回信封而不是文件流，以及「导入即执行代码」的管理员门禁。

测试 app 与生产装配同构：路由挂在 ``RKB_PREFIX`` 下、problem+json 异常
处理器齐全（multipart/媒体类型闸门按**全路径**判定，缺一样行为就走样）。

跑法（服务目录下）::

    python -m pytest tests/test_operator_routes_http.py -q
"""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from infrastructure.http.rkb_support import (http_exception_handler, kb_error_handler,
                                             validation_handler)
from operators import api as operators_api
from operators.service import operator_service
from shared.errors.api import KbApiError
from shared.prefixes import RKB_PREFIX


class _PrincipalMiddleware(BaseHTTPMiddleware):
    """把会话身份塞进 ``request.state``（``AuthMiddleware`` 在 local 模式的行为）。

    测试用参数控制角色，默认无会话（gateway/none 模式的形状）。
    """

    def __init__(self, app, role=None):
        super().__init__(app)
        self._role = role

    async def dispatch(self, request: Request, call_next):
        if self._role is not None:
            request.state.auth_user = SimpleNamespace(role=self._role, username='admin')
        return await call_next(request)


def _app(role=None) -> FastAPI:
    """与生产装配同构的最小 app：前缀与异常处理器一个不少。

    管理路由在生产里**没有**挂（``enable_management=False``），但它的异常
    一样要走 problem+json 阶梯，所以照 ``http_api.register_rkb_api`` 挂处理器。
    """
    app = FastAPI()
    app.add_middleware(_PrincipalMiddleware, role=role)
    app.include_router(operators_api.build_router(enable_management=True), prefix=RKB_PREFIX)
    app.add_exception_handler(RequestValidationError, validation_handler)
    app.add_exception_handler(KbApiError, kb_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    return app


def _url(path: str) -> str:
    return f'{RKB_PREFIX}{path}'


@pytest.fixture()
def client():
    return TestClient(_app())


@pytest.fixture()
def admin_client():
    """本地账号模式下的管理员会话。"""
    return TestClient(_app(role='admin'))


@pytest.fixture()
def user_client():
    """本地账号模式下的普通用户（非管理员）。"""
    return TestClient(_app(role='user'))


# ----------------------------------------------------------------------
# 读端点
# ----------------------------------------------------------------------


def test_list_operators_maps_query_params(client, monkeypatch):
    seen = {}

    def _fake(payload, emp_no, org_id):
        seen.update(payload=payload, emp_no=emp_no, org_id=org_id)
        return {'items': [], 'total': 0, 'page': 2, 'pageSize': 5}

    monkeypatch.setattr(operator_service, 'list_operators', _fake)

    response = client.get(_url('/operators'), params={
        'page': '2', 'size': '5', 'keyword': '甲', 'module': 'text_split',
        'visibility': 'public', 'format': 'md',
    }, headers={'X-Emp-No': 'me', 'X-Org-Id': 'org-1'})

    assert response.status_code == 200
    # ``operator_query`` 的字段映射：page→currentPage、size→pageSize、
    # visibility→visibleRange；缺省 keyword/module 是**空串**（不是 null）
    assert seen['payload'] == {
        'currentPage': 2, 'pageSize': 5, 'keyword': '甲', 'module': 'text_split',
        'visibleRange': 'public', 'format': 'md'}
    assert seen['emp_no'] == 'me'
    assert seen['org_id'] == 'org-1'


def test_list_operators_defaults_when_query_absent(client, monkeypatch):
    seen = {}

    def _fake(payload, emp_no, org_id):
        seen['payload'] = payload
        return {'items': [], 'total': 0, 'page': 1, 'pageSize': 20}

    monkeypatch.setattr(operator_service, 'list_operators', _fake)

    response = client.get(_url('/operators'))

    assert response.status_code == 200
    assert seen['payload'] == {'currentPage': 1, 'pageSize': 20, 'keyword': '',
                               'module': '', 'visibleRange': None, 'format': None}


def test_operator_types_is_static_enum(client):
    response = client.get(_url('/operators/types'))

    assert response.status_code == 200
    values = [item['value'] for item in response.json()]
    assert values == ['file_parse', 'text_split', 'graph_extract', 'rag_operator']


def test_template_requires_type(client):
    """``type`` 缺席不是 422，而是 kb 信封的 400 ``malformed_request``。"""
    response = client.get(_url('/operators/template'))

    assert response.status_code == 400
    assert response.headers['content-type'].startswith('application/problem+json')


def test_template_download_streams_zip(client):
    response = client.get(_url('/operators/template'), params={'type': 'text_split'})

    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/octet-stream'
    assert 'text_split.zip' in response.headers['content-disposition']
    assert response.content[:2] == b'PK'


def test_template_download_unknown_type_returns_problem_envelope(client):
    """下载端点出错走**信封**（problem+json），绝不能回一个 0 字节的「成功」流。"""
    response = client.get(_url('/operators/template'), params={'type': 'nope'})

    assert response.status_code == 400
    assert response.headers['content-type'].startswith('application/problem+json')


def test_available_requires_module_and_format(client):
    missing_module = client.get(_url('/operators/available'))
    assert missing_module.status_code == 400

    missing_format = client.get(_url('/operators/available'), params={'module': 'text_split'})
    assert missing_format.status_code == 400


def test_available_passes_formats_and_keyword(client, monkeypatch):
    seen = {}

    def _fake(payload, emp_no, org_id):
        seen.update(payload=payload, emp_no=emp_no, org_id=org_id)
        return {'md': []}

    monkeypatch.setattr(operator_service, 'support', _fake)

    response = client.get(_url('/operators/available'),
                          params=[('module', 'text_split'), ('format', 'md'),
                                  ('format', 'pdf'), ('keyword', '甲')])

    assert response.status_code == 200
    assert response.json() == {'md': []}
    # format 是多值参数，多个值都收进来
    assert seen['payload'] == {'module': 'text_split', 'formats': ['md', 'pdf'], 'keyword': '甲'}


def test_supported_requires_module(client):
    assert client.get(_url('/operators/supported')).status_code == 400


def test_supported_returns_canvas_entries(client, monkeypatch):
    monkeypatch.setattr(operator_service, 'rag_workflow_supported',
                        lambda module, org_id: [
                            {'id': 3, 'position': 'null', 'operator': 'null',
                             'operatorName': '甲', 'defaultArgs': {}}])

    response = client.get(_url('/operators/supported'), params={'module': 'retriever'})

    assert response.status_code == 200
    assert response.json()[0]['position'] == 'null'


def test_operator_detail_happy_and_bad_path_variable(client, monkeypatch):
    monkeypatch.setattr(operator_service, 'get_operator', lambda operator_id: {'id': operator_id})

    ok = client.get(_url('/operators/7'))
    assert ok.status_code == 200
    assert ok.json() == {'id': 7}

    bad = client.get(_url('/operators/not-a-number'))
    assert bad.status_code == 400
    assert bad.json()['code'] == 'malformed_request'


def test_operator_export_streams_stored_zip(client, monkeypatch):
    monkeypatch.setattr(operator_service, 'export_operator',
                        lambda operator_id, org_id: (b'PKzip', '1-retriever-x.zip'))

    response = client.get(_url('/operators/1/export'), headers={'X-Org-Id': 'org-1'})

    assert response.status_code == 200
    assert response.headers['content-type'] == 'application/octet-stream'
    assert '1-retriever-x.zip' in response.headers['content-disposition']
    assert response.content == b'PKzip'


def test_operator_export_missing_file_is_404_envelope(client, monkeypatch):
    """库里的 zip 路径在、盘上文件缺失 → 0005「文件(夹)不存在」→ 404 problem，
    绝不能回一个 0 字节的下载。"""
    def _boom(operator_id, org_id):
        raise KbApiError('RetCode.file.not.exist')

    monkeypatch.setattr(operator_service, 'export_operator', _boom)

    response = client.get(_url('/operators/1/export'))

    assert response.status_code == 404
    assert response.headers['content-type'].startswith('application/problem+json')
    assert response.json()['code'] == 'file_not_found'


# ----------------------------------------------------------------------
# 管理端点（导入 / 删除 / 发布 / 可见性）
# ----------------------------------------------------------------------


def _fake_import(monkeypatch, result=None, error=None):
    seen = {}

    def _fake(filename, content, emp_no, org_id, lang):
        seen.update(filename=filename, size=len(content), emp_no=emp_no,
                    org_id=org_id, lang=lang)
        if error is not None:
            raise error
        return result

    monkeypatch.setattr(operator_service, 'import_operator', _fake)
    return seen


def test_import_requires_admin_session(user_client, monkeypatch):
    """本地账号模式下非管理员导入 → 403（导入等同于在服务端执行代码）。"""
    seen = _fake_import(monkeypatch, result={'id': 9})

    response = user_client.post(
        _url('/operators'),
        files={'file': ('op.zip', b'PK', 'application/zip')})

    assert response.status_code == 403
    assert response.json()['code'] == 'forbidden'
    assert seen == {}, '被门禁拦下后服务层不该被执行'


def test_import_allows_gateway_mode_without_principal(monkeypatch):
    """gateway/none 没有本地会话：由网关/部署边界负责，这里放行。"""
    seen = _fake_import(monkeypatch, result={'id': 9})
    client = TestClient(_app(role=None))

    response = client.post(
        _url('/operators'),
        files={'file': ('op.zip', b'PKdata', 'application/zip')},
        headers={'X-Emp-No': 'me', 'X-Org-Id': 'org-3', 'Accept-Language': 'zh-CN'})

    assert response.status_code == 201
    # ``language()`` 的口径是 Accept-Language 的主语言（zh-CN → zh）
    assert seen == {'filename': 'op.zip', 'size': 6, 'emp_no': 'me',
                    'org_id': 'org-3', 'lang': 'zh'}


def test_import_returns_201_with_location(admin_client, monkeypatch):
    _fake_import(monkeypatch, result={'id': 9, 'name': '甲'})

    response = admin_client.post(
        _url('/operators'),
        files={'file': ('op.zip', b'PKdata', 'application/zip')})

    assert response.status_code == 201
    assert response.json()['id'] == 9
    assert response.headers['Location'] == f'{RKB_PREFIX}/operators/9'


def test_import_without_id_has_no_location(admin_client, monkeypatch):
    """返回值没有 ``id`` 时不得拼出一个指向 ``None`` 的 Location。"""
    _fake_import(monkeypatch, result={'name': '甲'})

    response = admin_client.post(
        _url('/operators'),
        files={'file': ('op.zip', b'PKdata', 'application/zip')})

    assert response.status_code == 201
    assert 'Location' not in response.headers


def test_import_malformed_body_is_bind_error(admin_client, monkeypatch):
    """multipart 端点缺 ``file`` 部件 → 400 malformed_request（不是 422）。"""
    response = admin_client.post(_url('/operators'))

    assert response.status_code == 400


def test_import_requires_multipart_content_type(admin_client, monkeypatch):
    """multipart 端点被 text/plain 调 → 读体阶段就拦成 400 malformed_request。"""
    monkeypatch.setattr(operator_service, 'import_operator',
                        lambda *a, **k: pytest.fail('不该进服务层'))

    response = admin_client.post(_url('/operators'), content=b'x',
                                 headers={'Content-Type': 'text/plain'})

    assert response.status_code == 400


def test_delete_operator_returns_204(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(operator_service, 'delete_operator',
                        lambda operator_id, org_id: seen.update(id=operator_id, org=org_id))

    response = client.delete(_url('/operators/5'), headers={'X-Org-Id': 'org-1'})

    assert response.status_code == 204
    assert response.content == b''
    assert seen == {'id': 5, 'org': 'org-1'}


@pytest.mark.parametrize('method, target, expected_flag', [
    ('post', '/operators/5/publish', operator_service.PUBLISH),
    ('delete', '/operators/5/publish', operator_service.UN_PUBLISH),
])
def test_flip_publish_routes(client, monkeypatch, method, target, expected_flag):
    seen = {}
    monkeypatch.setattr(operator_service, 'flip_publish',
                        lambda operator_id, emp, flag: seen.update(
                            id=operator_id, emp=emp, flag=flag))

    response = getattr(client, method)(_url(target), headers={'X-Emp-No': 'me'})

    assert response.status_code == 204
    assert seen == {'id': 5, 'emp': 'me', 'flag': expected_flag}


def test_visibility_update_happy(admin_client, monkeypatch):
    seen = {}
    monkeypatch.setattr(operator_service, 'flip_public',
                        lambda operator_id, emp, target: seen.update(
                            id=operator_id, emp=emp, target=target))

    response = admin_client.put(_url('/operators/5/visibility'), json={'public': True},
                                headers={'X-Emp-No': 'me'})

    assert response.status_code == 204
    # local 模式只认会话身份：X-Emp-No 是客户端可伪造的，这里落地的是 principal.username
    assert seen == {'id': 5, 'emp': 'admin', 'target': 'public'}


def test_visibility_update_private(admin_client, monkeypatch):
    seen = {}
    monkeypatch.setattr(operator_service, 'flip_public',
                        lambda operator_id, emp, target: seen.update(target=target))

    response = admin_client.put(_url('/operators/5/visibility'), json={'public': False})

    assert response.status_code == 204
    assert seen['target'] == 'private'


def test_visibility_update_rejects_non_bool_public(admin_client, monkeypatch):
    monkeypatch.setattr(operator_service, 'flip_public',
                        lambda *a: pytest.fail('不该翻状态'))

    response = admin_client.put(_url('/operators/5/visibility'), json={'public': 'yes'})

    assert response.status_code == 422
    assert response.json()['code'] == 'validation_failed'


def test_visibility_update_requires_json_media_type(admin_client, monkeypatch):
    """声明了 JSON 体的端点带 text/plain 体 → 415（媒体类型闸门）。"""
    monkeypatch.setattr(operator_service, 'flip_public',
                        lambda *a: pytest.fail('不该翻状态'))

    response = admin_client.put(_url('/operators/5/visibility'), content=b'public=true',
                                headers={'Content-Type': 'text/plain'})

    assert response.status_code == 415


def test_visibility_update_bad_path_variable(admin_client, monkeypatch):
    monkeypatch.setattr(operator_service, 'flip_public', lambda *a: None)

    response = admin_client.put(_url('/operators/abc/visibility'), json={'public': True})

    assert response.status_code == 400
    assert response.json()['code'] == 'malformed_request'
