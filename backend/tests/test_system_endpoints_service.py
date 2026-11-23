"""系统域端点（``system.service`` + ``system.api``）。

这些是「少数纯本地的兼容端点」：评测下拉框、数据集大小限制、dataset-manager
探活。钉的是契约形状（字段、键序、恒 ``error`` 的探活）与错误信封的码。

外部依赖全部用桩：``urllib.request.urlopen``、模型清单、知识库清单都不真连。

跑法（服务目录下）::

    python -m pytest tests/test_system_endpoints_service.py -q
"""

import json
import urllib.request

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from knowledge_base.service import file_service, kbase_service
from system import api as system_api
from system import service as surviving_endpoints
from shared.errors.api import KbApiError
from shared.prefixes import RKB_PREFIX
from workflow import runtime_config


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(system_api.build_router(), prefix=RKB_PREFIX)
    return TestClient(app)


# ----------------------------------------------------------------------
# 评测指标与数据集大小（纯静态）
# ----------------------------------------------------------------------


def test_metrics_order_and_shape():
    metrics = surviving_endpoints.metrics('zh')

    # 顺序就是前端下拉框的渲染顺序，不能动
    assert [m['value'] for m in metrics] == [
        'faithfulness', 'answer_relevancy', 'answer_similarity', 'answer_correctness',
        'context_precision', 'context_recall', 'answer_recall', 'answer_precision']
    assert metrics[0] == {'desc': None, 'label': '忠实性', 'value': 'faithfulness'}


def test_metrics_labels_fall_back_to_the_key_itself():
    """只有 zh 有译文：en 回落键名本身（文案源里刻意不补 en）。"""
    assert surviving_endpoints.metrics('en')[0]['label'] == 'faithfulness'


def test_dataset_size_shape_and_key_order():
    size = surviving_endpoints.dataset_size()

    assert list(size.keys()) == ['file', 'flow', 'kbase']
    assert size['file'] == {'max': 100, 'min': 1}
    # kbase 与 flow 取值恒等（历史口径，前端靠它置灰）
    assert size['kbase'] == size['flow'] == {'max': 100, 'min': 1}


# ----------------------------------------------------------------------
# dataset-manager 探活
# ----------------------------------------------------------------------


def test_dataset_health_without_endpoint_is_always_error(monkeypatch):
    monkeypatch.delenv('DATASET_MANAGER_URL', raising=False)

    assert surviving_endpoints.dataset_manager_health() == 'error'


def test_dataset_health_reports_normal_when_endpoint_answers(monkeypatch):
    seen = {}
    responses = []

    class _FakeResponse:
        def read(self):
            return b'{}'

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def _fake_urlopen(request, timeout=None):
        seen['url'] = request.full_url
        seen['body'] = request.data
        seen['method'] = request.get_method()
        seen['timeout'] = timeout
        response = _FakeResponse()
        responses.append(response)
        return response

    monkeypatch.setenv('DATASET_MANAGER_URL', 'http://dataset-manager:8000/root/')
    monkeypatch.setattr(urllib.request, 'urlopen', _fake_urlopen)

    assert surviving_endpoints.dataset_manager_health() == 'normal'
    assert seen['url'] == 'http://dataset-manager:8000/root/version/list'
    assert seen['method'] == 'POST'
    assert json.loads(seen['body']) == {'pageNo': 1, 'pageSize': 1}


def test_dataset_health_stays_error_when_probe_fails(monkeypatch, caplog):
    """探不通仍然是 ``error``：前端据此把数据集入口置灰。"""
    def _boom(request, timeout=None):
        raise OSError('connection refused')

    monkeypatch.setenv('DATASET_MANAGER_URL', 'http://127.0.0.1:1/never')
    monkeypatch.setattr(urllib.request, 'urlopen', _boom)
    caplog.set_level('WARNING')

    assert surviving_endpoints.dataset_manager_health() == 'error'
    assert 'dataset-manager health check failed' in caplog.text


# ----------------------------------------------------------------------
# 模型下拉清单
# ----------------------------------------------------------------------


def test_llm_list_comes_from_runtime_capabilities(monkeypatch):
    class _Capabilities:
        llm_models = (('deepseek-chat', 'DeepSeek Chat'), ('qwen3-32b', 'Qwen3 32B'))

    monkeypatch.setattr(runtime_config, 'capabilities', lambda: _Capabilities())

    assert surviving_endpoints.llm_list() == [
        {'value': 'deepseek-chat', 'label': 'DeepSeek Chat'},
        {'value': 'qwen3-32b', 'label': 'Qwen3 32B'}]


def test_embedding_list_uses_the_same_source_as_embedding_all(monkeypatch):
    """取法与 ``/embedding/all`` 同一函数 —— 不另起一套口径。"""
    import knowledge_base.service.kbase_service as kbase

    monkeypatch.setattr(kbase, 'list_embedding_model_names', lambda: ['bge-base-zh-v1.5'])

    assert surviving_endpoints.embedding_list() == [
        {'value': 'bge-base-zh-v1.5', 'label': 'bge-base-zh-v1.5'}]


def test_rerank_list_delegates_to_resolver(monkeypatch):
    from model import resolver

    options = [{'value': 'bge-reranker', 'label': 'BGE Reranker', 'isDefault': True}]
    monkeypatch.setattr(resolver, 'rerank_model_options', lambda: options)

    assert surviving_endpoints.rerank_list() is options


# ----------------------------------------------------------------------
# 固定失败响应
# ----------------------------------------------------------------------


def test_workflow_list_fails_with_the_contract_message():
    with pytest.raises(KbApiError) as excinfo:
        surviving_endpoints.workflow_list()
    assert excinfo.value.key == 'RetCode.zae.get.workflow.fail'


def test_query_task_list_fails_without_message():
    with pytest.raises(KbApiError) as excinfo:
        surviving_endpoints.query_task_list()
    assert excinfo.value.key is None                  # msg=null


# ----------------------------------------------------------------------
# HTTP 路由
# ----------------------------------------------------------------------


def test_health_is_public_plain_text(client):
    response = client.get(f'{RKB_PREFIX}/health')

    assert response.status_code == 200
    assert response.text == 'ok'


def test_system_info_reports_deployer_and_ais(client, monkeypatch):
    monkeypatch.setenv('DEPLOYED_BY', 'studio')
    monkeypatch.setenv('DEPLOY_PLAT_TYPE', 'ais')

    response = client.get(f'{RKB_PREFIX}/system/info')

    assert response.status_code == 200
    assert response.json() == {'deployedBy': 'studio', 'ais': True}


def test_system_info_ais_is_case_insensitive_and_off_by_default(client, monkeypatch):
    monkeypatch.delenv('DEPLOYED_BY', raising=False)
    monkeypatch.setenv('DEPLOY_PLAT_TYPE', 'Local')

    payload = client.get(f'{RKB_PREFIX}/system/info').json()

    assert payload['deployedBy'] is None
    assert payload['ais'] is False


def test_llm_models_endpoint(client, monkeypatch):
    class _Capabilities:
        llm_models = (('deepseek-chat', 'DeepSeek Chat'),)

    monkeypatch.setattr(runtime_config, 'capabilities', lambda: _Capabilities())

    response = client.get(f'{RKB_PREFIX}/system/llm-models')

    assert response.status_code == 200
    assert response.json() == [{'value': 'deepseek-chat', 'label': 'DeepSeek Chat'}]


def test_embedding_models_endpoint(client, monkeypatch):
    monkeypatch.setattr(kbase_service, 'list_embedding_models', lambda: ['bge-base-zh-v1.5'])

    response = client.get(f'{RKB_PREFIX}/system/embedding-models')

    assert response.json() == ['bge-base-zh-v1.5']


def test_rerank_models_endpoint(client, monkeypatch):
    from model import resolver

    monkeypatch.setattr(resolver, 'rerank_model_options',
                        lambda: [{'value': 'bge', 'label': 'BGE', 'isDefault': False}])

    response = client.get(f'{RKB_PREFIX}/system/rerank-models')

    assert response.json()[0]['value'] == 'bge'


def test_file_size_limits_endpoint(client, monkeypatch):
    monkeypatch.setattr(file_service, 'file_size_limit', lambda category: {'number': 1})

    response = client.get(f'{RKB_PREFIX}/system/file-size-limits')

    assert response.json() == {'number': 1}


def test_file_size_limits_rejects_non_numeric_category(client):
    """``category`` 是 ``Long`` 路径语义：非数字 → 400 malformed_request。"""
    response = client.get(f'{RKB_PREFIX}/system/file-size-limits',
                          params={'category': 'abc'})

    assert response.status_code == 400
    assert response.json()['code'] == 'malformed_request'
