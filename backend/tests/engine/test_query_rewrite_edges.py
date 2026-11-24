"""问题改写的边界行为（`pre_retriever/query_transform/query_rewrite.py`）。

既有 `test_query_rewrite_history.py` 钉住了多轮历史的**主路径**；本文件补边角：

* LLM 输出解析失败 → 原样返回原问题、不落缓存；
* ``multi_chat_limit`` 的非法值归一（``0`` 由既有文件钉住，这里钉其余非法形状）；
* 相关性判定（``is_same_sequence``）与意图问题拼接的空值路径；
* ``ask_llm_get_content`` 的 ``</think>`` 剥壳；限流取历史的三条路。

LLM 一律桩掉（``qr.get_custom_llm`` 是模块级绑定，替换它即可）。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from engine.cache import chat_memory
from engine.common.beans.rag_request import RagRequest
from engine.common.const import default_max_multi_chat_limit
from engine.pre_retriever.query_transform import query_rewrite as qr
from engine.primitives.models import QueryBundle

CONVERSATION_ID = 'd-rewrite-edges'
RAW = '那它的缺点呢'
REWRITTEN = '向量检索的缺点是什么？'


@pytest.fixture(autouse=True)
def _clean_caches():
    chat_memory.user_chat_question_cache.clear()
    chat_memory.user_chat_question_history_cache.clear()
    yield
    chat_memory.user_chat_question_cache.clear()
    chat_memory.user_chat_question_history_cache.clear()


@pytest.fixture
def make_rewriter(monkeypatch):
    monkeypatch.setattr(qr, 'get_custom_llm', lambda llm, config: SimpleNamespace())

    def make(chat_history=None, limit=0):
        config = {
            'llm': '',
            'multi_chat_limit': limit,
            'user_request': RagRequest(
                question=RAW, conversation_id=CONVERSATION_ID,
                chat_history=chat_history if chat_history is not None else []),
        }
        return qr.LLMQueryRewriter(config), config

    return make


def _pairs(count):
    return [{'question': f'历史问题{i}', 'answer': f'历史答案{i}'} for i in range(count)]


class _AskLLM:
    """ask_llm_get_content 的桩：resp.json() 形状对齐 OpenAI 兼容响应。"""

    def __init__(self, content):
        self._payload = {'choices': [{'message': {'content': content}}]}

    def ask_llm(self, prompt, stream=False, use_kwargs=False):
        return SimpleNamespace(json=lambda: self._payload)


# ---------------------------------------------------------------------------
# _run 的失败兜底
# ---------------------------------------------------------------------------
def test_unparseable_llm_output_keeps_original_query(make_rewriter):
    rewriter, config = make_rewriter()
    rewriter.ask_llm_get_content = lambda prompt: '模型没按格式作答'

    bundle = rewriter._run(QueryBundle(query_str=RAW), {})

    assert bundle.query_str == RAW
    assert 'is_multi_chat' not in config['user_request'].kwargs
    # 失败时不能把坏改写写进多轮缓存
    assert chat_memory.get_chat_question_history(CONVERSATION_ID) is None


def test_llm_content_without_braces_fails_the_slice(make_rewriter):
    """content 里没有 '{'：index('{') 抛 ValueError，走同一兜底。"""
    rewriter, _ = make_rewriter()
    rewriter.ask_llm_get_content = lambda prompt: '纯文本回答'

    assert rewriter._run(QueryBundle(query_str=RAW), {}).query_str == RAW


# ---------------------------------------------------------------------------
# get_args 的非法上限
# ---------------------------------------------------------------------------
@pytest.mark.parametrize('limit', ['3', True, -1, None, 3.5])
def test_invalid_multi_chat_limit_falls_back_to_default(make_rewriter, limit):
    rewriter, _ = make_rewriter(_pairs(2), limit=limit)
    _, normalized = rewriter.get_args()
    assert normalized == default_max_multi_chat_limit


# ---------------------------------------------------------------------------
# is_same_sequence / build_intention_question
# ---------------------------------------------------------------------------
def test_same_sequence_without_history_is_false(make_rewriter):
    rewriter, _ = make_rewriter()
    assert rewriter.is_same_sequence([], RAW) is False


def test_same_sequence_related_history_is_true(make_rewriter):
    rewriter, _ = make_rewriter()
    rewriter.ask_llm_get_content = lambda prompt: '相关'
    prompts = []
    original = rewriter.ask_llm_get_content

    def capture(prompt):
        prompts.append(prompt)
        return original(prompt)

    rewriter.ask_llm_get_content = capture
    assert rewriter.is_same_sequence(_pairs(2), RAW) is True
    assert '历史问题0' in prompts[0] and '历史问题1' in prompts[0]
    assert RAW in prompts[0]


def test_same_sequence_unrelated_history_is_false(make_rewriter):
    rewriter, _ = make_rewriter()
    rewriter.ask_llm_get_content = lambda prompt: '不相关'
    assert rewriter.is_same_sequence(_pairs(2), RAW) is False


def test_intention_question_empty_histories(make_rewriter):
    rewriter, _ = make_rewriter()
    assert rewriter.build_intention_question([]) == ''
    # 条目里没有 question 键 → 拼不出任何问题 → 空串
    assert rewriter.build_intention_question([{'answer': 'a'}, {'question': None}]) == ''


def test_intention_question_joins_questions(make_rewriter):
    rewriter, _ = make_rewriter()
    joined = rewriter.build_intention_question(_pairs(2))
    assert joined == '历史问题0\n历史问题1'


# ---------------------------------------------------------------------------
# ask_llm_get_content 的 </think> 剥壳
# ---------------------------------------------------------------------------
def test_ask_llm_strips_think_prefix_with_json(make_rewriter, monkeypatch):
    rewriter, _ = make_rewriter()
    monkeypatch.setattr(rewriter, 'llm', _AskLLM('先想一想</think>\n{"question": "%s"}' % REWRITTEN))

    assert rewriter.ask_llm_get_content('提示词') == '{"question": "%s"}' % REWRITTEN


def test_ask_llm_keeps_original_when_think_tail_has_no_json(make_rewriter, monkeypatch):
    rewriter, _ = make_rewriter()
    monkeypatch.setattr(rewriter, 'llm', _AskLLM('想一想</think>没有括号的尾巴'))

    assert rewriter.ask_llm_get_content('提示词') == '想一想</think>没有括号的尾巴'


def test_ask_llm_plain_content_passes_through(make_rewriter, monkeypatch):
    rewriter, _ = make_rewriter()
    monkeypatch.setattr(rewriter, 'llm', _AskLLM('{"question": "直接给"}'))

    assert rewriter.ask_llm_get_content('提示词') == '{"question": "直接给"}'


# ---------------------------------------------------------------------------
# 限流取历史
# ---------------------------------------------------------------------------
def test_get_limit_chat_history_disabled(make_rewriter):
    rewriter, _ = make_rewriter(_pairs(3), limit=0)
    # 先把 limit 归一回默认，再用 0 直接验证关闭语义
    assert rewriter.get_limit_chat_history(_pairs(3), 0) == []


def test_get_limit_chat_question_history_from_memory(make_rewriter):
    rewriter, _ = make_rewriter()
    for q in ['问1', '问2', '问3']:
        chat_memory.save_chat_question_history(CONVERSATION_ID, q)

    wrapped = rewriter.get_limit_chat_question_history(_pairs(3), 2, CONVERSATION_ID)
    assert wrapped == [{'question': '问2'}, {'question': '问3'}]


def test_get_limit_chat_question_history_falls_back_to_request_history(make_rewriter):
    rewriter, _ = make_rewriter()
    history = _pairs(3)

    assert rewriter.get_limit_chat_question_history(history, 2, CONVERSATION_ID) == history[-2:]


def test_get_limit_paths_disabled_by_zero(make_rewriter):
    rewriter, _ = make_rewriter()
    assert rewriter.get_limit_chat_question_history(_pairs(3), 0, CONVERSATION_ID) == []
