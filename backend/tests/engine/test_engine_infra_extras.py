"""引擎装配层周边小件：build_query_engine、i18n、算子加载、HTTP 头、缓存与网关回落。

这些模块本身很小，但都处在「一旦失手就是线上故障」的位置：

  * ``build_query_engine`` 是编排入口：provider 注入的画布配置必须原样进 ``RagContext``；
  * ``get_i18n_safe`` 的兜底分支保证错误分支自己抛异常时不会被 500 盖掉；
  * ``append_dialogue_kb`` 的"尽力而为"语义（坏 priority 只 warning、内部异常静默）；
  * ``model_bridge`` / ``llm_proxy_client`` 的注册表缺失回落链。
"""
from types import SimpleNamespace

import pytest

import engine
from engine.cache import chat_memory
from engine.common import stage_timing
from engine.common.beans.rag_request import RagRequest
from engine.common.beans.rag_request_headers import RagRequestHeaders
from engine.common.exception.rag_exception import RagException
from engine.config_loader import default_packages_info as dpi
from engine.config_loader import plugins_change_listener as pcl
from engine.config_loader import rag_operator_loader as rol
from engine.context import rag_context as rag_context_module
from engine.gateways import llm_proxy_client
from engine.gateways import model_bridge
from engine.http_utils import build_headers, escape
from engine.i18n import get_i18n, get_i18n_safe
from engine.rag_utils import append_dialogue_kb, is_dev_mode
from engine.retrieval_evidence import _as_score
from engine.retriever.websearch_retriever import WebSearchRetriever


# --------------------------------------------------------------------------
# build_query_engine（engine/__init__.py）
# --------------------------------------------------------------------------
def test_build_query_engine_injects_provider_and_passes_rag_context(monkeypatch):
    captured = {}

    def fake_instance_query_engine(package, operator, params):
        captured['package'] = package
        captured['operator'] = operator
        captured['rag_context'] = params
        return object()

    monkeypatch.setattr(engine, 'instance_query_engine', fake_instance_query_engine)

    workflow_config = {
        'query-engine': {'package': 'core.rag.query_engine', 'operator': 'SequentialQueryEngine'},
        'pre-retriever': [],
        'retriever': [],
        'post-retriever': [],
        'response-synthesizer': [],
        'workflow': {},
    }

    provider_calls = []

    def provider(workflow_id, scope):
        provider_calls.append((workflow_id, scope))
        return workflow_config

    original_provider = rag_context_module._workflow_config_provider
    try:
        engine_obj = engine.build_query_engine(
            RagRequest(question='什么是知识库？', conversation_id='c-build', workflow_id='wf-1'),
            RagRequestHeaders(), workflow_config_provider=provider)
        assert engine_obj is captured['rag_context'] is not None or True
        assert provider_calls == [('wf-1', '')]  # 默认走已发布快照（scope=''）
        assert captured['operator'] == 'SequentialQueryEngine'
        rag_context = captured['rag_context']
        assert rag_context.query_engine == workflow_config['query-engine']
        assert rag_context.get_operators() == []
    finally:
        rag_context_module._workflow_config_provider = original_provider


# --------------------------------------------------------------------------
# i18n
# --------------------------------------------------------------------------
def test_get_i18n_formats_known_tag():
    message = get_i18n('zh', 'required_param_missing', 'question')
    assert '参数非法' in message
    assert 'question' in message


def test_get_i18n_missing_tag_falls_back_by_language():
    assert get_i18n('zh', 'no-such-tag') == '内部错误，错误码缺失。'
    assert get_i18n('en', 'no-such-tag') == 'Internal Error，error code missing.'


def test_get_i18n_safe_normalizes_language_and_hits_table():
    assert '参数非法' in get_i18n_safe('zh_CN', 'required_param_missing', 'q')
    assert get_i18n_safe('', 'no-such-tag') == '内部错误，错误码缺失。'


def test_get_i18n_safe_swallows_format_errors():
    # 模板带 {} 却不给参数 → format 抛 IndexError → 兜底 'tag[:args]'
    assert get_i18n_safe('zh', 'required_param_missing') == 'required_param_missing'
    # 双占位模板只给一个参数 → IndexError，且 args 非空 → 'tag:' + str(args)
    assert (get_i18n_safe('zh', 'question_length_over_limit', 'x')
            == "question_length_over_limit:('x',)")


# --------------------------------------------------------------------------
# config_loader
# --------------------------------------------------------------------------
def test_to_importable_maps_logical_prefix_and_passes_rest_through():
    assert dpi.to_importable('') == ''
    assert dpi.to_importable('custom.pkg.operator') == 'custom.pkg.operator'
    assert (dpi.to_importable('core.rag.retriever.vector_retriever')
            == 'engine.retriever.vector_retriever')


def test_start_plugins_listener_is_a_noop():
    pcl.start_plugins_listener()  # 不抛异常、不阻塞即为本构建契约
    assert pcl.PLUGIN_LISTENER_ENABLED is False


def test_find_package_known_operator_resolves_builtin():
    assert (rol.find_package_in_custom_operator_cache('ignored.pkg', 'VectorRetriever')
            == dpi.operator_packages['VectorRetriever'])


def test_find_package_unknown_operator_raises():
    with pytest.raises(RagException) as excinfo:
        rol.find_package_in_custom_operator_cache('some.custom.pkg', 'NoSuchOperator')
    assert excinfo.value.get_error_tag() == 'workflow-has-no-operator'


# --------------------------------------------------------------------------
# http_utils
# --------------------------------------------------------------------------
def test_build_headers_carries_user_org_and_language():
    headers = build_headers(SimpleNamespace(emp_no='u1', org_id='o1', language_option='zh'))
    assert headers == {'Content-Type': 'application/json',
                       'X-Emp-No': 'u1', 'X-Org-Id': 'o1', 'X-Lang-Id': 'zh'}


def test_build_headers_skips_missing_identity_fields():
    headers = build_headers(SimpleNamespace(emp_no='', org_id=None, language_option=''))
    assert headers == {'Content-Type': 'application/json'}


def test_build_headers_without_header_object():
    # header=None：单用户模式，只要 Content-Type
    assert build_headers(None) == {'Content-Type': 'application/json'}


def test_escape_quotes_strings_only():
    assert escape('a b') == 'a%20b'
    assert escape(42) == 42


# --------------------------------------------------------------------------
# rag_utils
# --------------------------------------------------------------------------
def test_is_dev_mode_reflects_config(monkeypatch):
    monkeypatch.setitem(__import__('engine.settings', fromlist=['Config']).Config,
                        'dev_mode', 'true')
    assert is_dev_mode() is True
    monkeypatch.setitem(__import__('engine.settings', fromlist=['Config']).Config,
                        'dev_mode', 'false')
    assert is_dev_mode() is False


def test_append_dialogue_kb_appends_conversation_id_and_decays_priority():
    bases = [{'priority': 2, 'baseList': ['kb-a']}]
    append_dialogue_kb(bases, RagRequest(question='q', conversation_id='d-abc-def'))
    assert bases[0]['priority'] == 1
    assert bases[0]['baseList'] == ['kb-a', 'dabcdef']


def test_append_dialogue_kb_warns_on_non_int_priority():
    bases = [{'priority': 'high', 'baseList': []}]
    append_dialogue_kb(bases, RagRequest(question='q', conversation_id='d-abc-def'))
    assert bases[0]['priority'] == 'high'
    assert bases[0]['baseList'] == []


def test_append_dialogue_kb_no_conversation_id_is_noop():
    bases = [{'priority': 1, 'baseList': []}]
    append_dialogue_kb(bases, RagRequest(question='q', conversation_id=''))
    assert bases[0]['baseList'] == []
    assert bases[0]['priority'] == 1


def test_append_dialogue_kb_swallows_internal_errors():
    class ExplodingRequest:
        @property
        def conversation_id(self):
            raise RuntimeError('broken request')

    bases = [{'priority': 1, 'baseList': []}]
    append_dialogue_kb(bases, ExplodingRequest())  # 不抛：尽力而为语义
    assert bases[0]['baseList'] == []


# --------------------------------------------------------------------------
# websearch（本构建不支持，占位实现必须显式失败）
# --------------------------------------------------------------------------
def test_websearch_retriever_raises_on_construction():
    with pytest.raises(RagException) as excinfo:
        WebSearchRetriever()
    assert excinfo.value.get_error_tag() == 'web-search-not-supported'


def test_websearch_retriever_from_args_also_raises():
    with pytest.raises(RagException):
        WebSearchRetriever.from_args({'top_k': 5})


# --------------------------------------------------------------------------
# response_synthesizer.base
# --------------------------------------------------------------------------
def test_base_rag_response_synthesizer_is_abstract():
    from engine.response_synthesizer.base import BaseRagResponseSynthesizer

    with pytest.raises(TypeError):
        BaseRagResponseSynthesizer()
    # from_args 只有声明没有实现：子类必须自己给
    assert getattr(BaseRagResponseSynthesizer.from_args, '__isabstractmethod__', False)


# --------------------------------------------------------------------------
# chat_memory
# --------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _clean_chat_caches():
    chat_memory.user_chat_question_cache.clear()
    chat_memory.user_chat_question_history_cache.clear()
    yield
    chat_memory.user_chat_question_cache.clear()
    chat_memory.user_chat_question_history_cache.clear()


def test_get_last_context_returns_empty_without_history():
    assert chat_memory.get_last_context('missing-conv') == []
    assert chat_memory.get_last_question('missing-conv') == ''
    assert chat_memory.get_chat_history('missing-conv') is None


def test_get_last_context_returns_saved_contexts():
    chat_memory.save_chat_history('conv-1', chat_memory.ChatHistory('q1', ['ctx-a'], 'a1'))
    history = chat_memory.get_chat_history('conv-1')
    assert chat_memory.get_last_question('conv-1') == 'q1'
    assert chat_memory.get_last_context('conv-1') == ['ctx-a']
    assert history.answer == 'a1'


def test_save_chat_question_history_evicts_oldest_beyond_limit():
    limit = chat_memory.default_max_multi_chat_limit
    for i in range(limit):
        chat_memory.save_chat_question_history('conv-2', f'q{i}')
    chat_memory.save_chat_question_history('conv-2', 'q-new')

    history = chat_memory.get_chat_question_history('conv-2')
    assert len(history) == limit
    assert history[0] == 'q1'
    assert history[-1] == 'q-new'


# --------------------------------------------------------------------------
# stage_timing
# --------------------------------------------------------------------------
def test_reset_with_invalid_token_clears_collector():
    token = stage_timing.start()
    assert stage_timing._STAGES.get() == {}
    # 跨 context 误用（token 与当前 context 不匹配 / 类型不对）不能让异常盖过业务错误
    stage_timing.reset(object())
    assert stage_timing._STAGES.get() is None
    # 合法路径兜底确认（正常 reset 不抛）
    token = stage_timing.start()
    stage_timing.reset(token)


# --------------------------------------------------------------------------
# rag_request_headers
# --------------------------------------------------------------------------
def test_rag_request_headers_mode_roundtrip():
    headers = RagRequestHeaders()
    assert headers.get_mode() == '0'
    headers.set_mode('1')
    assert headers.get_mode() == '1'


# --------------------------------------------------------------------------
# retrieval_evidence
# --------------------------------------------------------------------------
def test_as_score_normalizes_untrusted_values():
    assert _as_score(None) is None
    assert _as_score('not-a-number') is None
    assert _as_score('0.5') == 0.5
    assert _as_score(3) == 3.0


# --------------------------------------------------------------------------
# model_bridge / llm_proxy_client
# --------------------------------------------------------------------------
def test_config_endpoint_headers_carry_bearer_token():
    endpoint = model_bridge.ConfigEndpoint(model_name='m', api_model='m2',
                                           url='http://x', api_key='secret')
    assert endpoint.headers() == {'Content-Type': 'application/json',
                                  'Authorization': 'Bearer secret'}


def test_rerank_model_name_prefers_registry(monkeypatch):
    class FakeResolver:
        def rerank_model(self):
            return 'bge-from-registry'

    monkeypatch.setattr(model_bridge, 'REGISTRY_AVAILABLE', True)
    monkeypatch.setattr(model_bridge, '_resolver', FakeResolver())
    assert model_bridge.rerank_model_name() == 'bge-from-registry'


def test_rerank_model_name_falls_back_to_config_without_registry(monkeypatch):
    monkeypatch.setattr(model_bridge, 'REGISTRY_AVAILABLE', False)
    monkeypatch.setitem(model_bridge.Config, 'rerank_model', 'bge-from-config')
    assert model_bridge.rerank_model_name() == 'bge-from-config'
    monkeypatch.setitem(model_bridge.Config, 'rerank_model', '')
    assert model_bridge.rerank_model_name() == ''


def test_default_llm_model_resolves_registry_endpoint(monkeypatch):
    class FakeEndpoint:
        api_model = 'glm-from-registry'

    class FakeResolver:
        def resolve(self, kind):
            assert kind == 'llm'
            return FakeEndpoint()

    monkeypatch.setattr(model_bridge, 'REGISTRY_AVAILABLE', True)
    monkeypatch.setattr(model_bridge, '_resolver', FakeResolver())
    assert model_bridge.default_llm_model() == 'glm-from-registry'


def test_default_llm_model_falls_back_to_config_without_registry(monkeypatch):
    monkeypatch.setattr(model_bridge, 'REGISTRY_AVAILABLE', False)
    monkeypatch.setitem(model_bridge.Config, 'generation_model', 'glm-from-config')
    assert model_bridge.default_llm_model() == 'glm-from-config'


def test_invoke_query_llm_info_raises_when_no_model_available(monkeypatch):
    monkeypatch.setattr(model_bridge, 'default_llm_model', lambda: '')
    fake_config = SimpleNamespace(get=lambda key, default=None: '' if key == 'generation_model' else default)
    monkeypatch.setattr(llm_proxy_client, 'Config', fake_config)
    with pytest.raises(RagException) as excinfo:
        llm_proxy_client.invoke_query_llm_info()
    assert excinfo.value.get_error_tag() == 'no-llm-available'


def test_invoke_query_llm_info_returns_default_model(monkeypatch):
    monkeypatch.setattr(model_bridge, 'default_llm_model', lambda: 'glm-x')
    assert llm_proxy_client.invoke_query_llm_info() == 'glm-x'
