"""RagSimpleSummarizer 的分叉路径（`response_synthesizer/simple_summarizer.py`）。

补既有测试没盖到的三段：

* ``update_llm_and_prompt`` 的三路选择（默认配置 / 命中知识库名 / 命中 conversation_id）；
* ``synthesize`` 的 deepsearch 引用装配与零检索兜底（流式 / 非流式）；
* ``_select_prompt`` 的空 prompt 回落。

Qwen / get_custom_llm 全部桩掉：真实适配器只在 ``predict`` 时才出网，
但构造期会读模型注册表（可能探 DB），测试里没必要。
"""
from __future__ import annotations

import json

import pytest

from engine.common import const
from engine.common.beans.rag_request import RagRequest
from engine.common.beans.rag_request_headers import RagRequestHeaders
from engine.primitives.llm import LLMMetadata
from engine.primitives.models import QueryBundle, TextNode
from engine.response_synthesizer import simple_summarizer as ss
from engine.response_synthesizer.simple_summarizer import RagSimpleSummarizer, _select_prompt
from engine.retriever import RagNodeWithScore

PROMPT_A = '知识库A的提示词'
CONVERSATION_ID = 'd-synth-1'


class _StubLLM:
    instances = []

    def __init__(self, context_window=None, config_info=None):
        self.context_window = context_window
        self.config_info = config_info
        self.metadata = LLMMetadata(context_window=context_window or const.default_token,
                                    num_output=512, is_chat_model=True)
        self.predict_calls = []
        self.saved_history = []
        self.generate_answer_calls = []
        _StubLLM.instances.append(self)

    def predict(self, prompt, **kwargs):
        self.predict_calls.append(kwargs)
        return '合成答案'

    def stream(self, prompt, **kwargs):
        return iter(['流式', '答案'])

    def save_synthesis_history(self, question, answer, contexts=None):
        self.saved_history.append((question, answer, contexts))

    def generate_answer(self, question):
        self.generate_answer_calls.append(question)
        return '兜底答案'

    def generate_answer_stream(self, question):
        self.generate_answer_calls.append(question)
        yield '兜底'


@pytest.fixture(autouse=True)
def _stub_qwen(monkeypatch):
    _StubLLM.instances = []
    monkeypatch.setattr(ss, 'Qwen', _StubLLM)
    yield
    _StubLLM.instances = []


def _config(**overrides):
    config = {
        'generator-config': [{'llm': 'qwen-a', 'prompt': PROMPT_A,
                              'knowledge_base_name': ['kb-a|#|dev']}],
        'headers': RagRequestHeaders(),
        'user_request': RagRequest(question='问题', conversation_id=CONVERSATION_ID),
    }
    config.update(overrides)
    return config


def _summarizer(config=None, streaming=False):
    return RagSimpleSummarizer(streaming=streaming, config_info=config or _config())


def _node(text, source='文档A.docx', base_name='kb-a', with_metadata=True):
    metadata = {'source': const.source_format + source} if with_metadata else {}
    return RagNodeWithScore(node=TextNode(text=text, metadata=metadata),
                            score=1.0, base_name=base_name)


# ---------------------------------------------------------------------------
# update_llm_and_prompt 的三路选择
# ---------------------------------------------------------------------------
def test_update_with_empty_base_name_uses_canvas_defaults(monkeypatch):
    config = _config()
    calls = []
    monkeypatch.setattr(ss, 'get_custom_llm', lambda llm, params: calls.append((llm, params)))

    summarizer = _summarizer(config)
    summarizer.update_llm_and_prompt('')

    assert calls == [('qwen-a', config['generator-config'][0])]
    template = summarizer._text_qa_template.default_template.template
    assert template == PROMPT_A
    # headers / user_request 回填进参数（LLM 调用要用）
    assert config['generator-config'][0]['headers'] is config['headers']


def test_update_matches_kb_name_after_scope_suffix(monkeypatch):
    calls = []
    monkeypatch.setattr(ss, 'get_custom_llm', lambda llm, params: calls.append(llm))

    summarizer = _summarizer()
    summarizer.update_llm_and_prompt('kb-a')  # 画布里存的是 'kb-a|#|dev'，按 '|#|' 前缀命中

    assert calls == ['qwen-a']
    assert summarizer._text_qa_template.default_template.template == PROMPT_A


def test_update_matches_conversation_id(monkeypatch):
    calls = []
    monkeypatch.setattr(ss, 'get_custom_llm', lambda llm, params: calls.append(llm))

    summarizer = _summarizer()
    summarizer.update_llm_and_prompt(CONVERSATION_ID.replace('-', ''))

    assert calls == ['qwen-a']


def test_update_with_unrelated_base_name_selects_nothing(monkeypatch):
    calls = []
    monkeypatch.setattr(ss, 'get_custom_llm', lambda llm, params: calls.append(llm))

    summarizer = _summarizer()
    summarizer.update_llm_and_prompt('别的库')

    assert calls == []


# ---------------------------------------------------------------------------
# synthesize：deepsearch 引用装配
# ---------------------------------------------------------------------------
def test_deepsearch_synthesis_returns_citation_payload():
    summarizer = _summarizer(_config(headers=RagRequestHeaders(deepsearch=True)))

    response = summarizer.synthesize(QueryBundle(query_str='问题'), [_node('正文内容')])

    payload = json.loads(response.response)
    assert payload['conversation_id'] == CONVERSATION_ID
    citation = payload['citation']['引文-1']
    assert citation['type'] == 'text'
    assert citation['data']['source'] == '文档A.docx'      # 剥掉 source 标记
    assert citation['data']['content_expand'] == '正文内容'  # 剥掉 expand 标记
    assert citation['data']['node_id']


# ---------------------------------------------------------------------------
# synthesize：零检索兜底
# ---------------------------------------------------------------------------
def test_zero_nodes_non_streaming_falls_back_to_answer():
    summarizer = _summarizer()

    response = summarizer.synthesize(QueryBundle(query_str='改写后的问题'), [])

    assert response.response == '兜底答案'
    stub = _StubLLM.instances[0]
    assert stub.generate_answer_calls == ['改写后的问题']


def test_zero_nodes_streaming_falls_back_to_stream():
    summarizer = _summarizer(streaming=True)

    response = summarizer.synthesize(QueryBundle(query_str='改写后的问题'), [])

    assert response.response_txt is None or response.query_str == '改写后的问题'
    assert response.query_str == '改写后的问题'
    assert list(response.response_gen) == ['兜底']


# ---------------------------------------------------------------------------
# synthesize：正常合成（非流式）补记会话历史
# ---------------------------------------------------------------------------
def test_synthesis_saves_history_and_returns_query_str():
    summarizer = _summarizer()
    # 不带 metadata：LLM 模式的 get_content 就是裸文本，`|#|` 前缀才落在来源冒号上
    nodes = [_node('来源A:第一段', with_metadata=False)]

    response = summarizer.synthesize(QueryBundle(query_str='改写后的问题'), nodes)

    assert response.response == '合成答案'
    assert response.query_str == '改写后的问题'
    stub = _StubLLM.instances[0]
    # 每条 context 补 '|#|来源:' 前缀后交给生成提示词
    context_str = stub.predict_calls[0]['context_str']
    assert context_str[0].startswith('|#|来源A:')
    assert stub.saved_history == [('改写后的问题', '合成答案', context_str)]


# ---------------------------------------------------------------------------
# _select_prompt
# ---------------------------------------------------------------------------
def test_select_prompt_empty_returns_none():
    assert _select_prompt('') is None
    assert _select_prompt(None) is None


def test_select_prompt_wraps_template():
    template = _select_prompt('自定义提示词')
    assert template.default_template.template == '自定义提示词'
