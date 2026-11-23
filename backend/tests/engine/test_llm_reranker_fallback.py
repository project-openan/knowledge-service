"""LLMReranker 的重排执行路径（`post_retriever/llm_reranker.py`）。

既有 `test_llm_reranker_model.py` 钉住了 ``from_args`` 的模型选择；本文件钉
``_postprocess_nodes`` 本体：

* query_bundle 缺失 / 空节点的前置短路；
* 正常分批重排：按 relevance 降序、``top_n`` 截断、``base_name`` 透传；
* 自定义解析函数不吐相关性时的 1.0 兜底；
* LLM 调用失败 → 回落「前 top_n 个原始节点」（重排失败不能吞掉检索结果）。
"""
from __future__ import annotations

import pytest

from engine.post_retriever.llm_reranker import LLMReranker
from engine.primitives.models import QueryBundle, TextNode
from engine.retriever import RagNodeWithScore


class _StubLLM:
    def __init__(self, responses=None, error=None):
        self.responses = list(responses or [])
        self.error = error
        self.calls = []

    def predict(self, prompt, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.responses.pop(0)


def _node(text, score, base_name):
    return RagNodeWithScore(node=TextNode(text=text, metadata={}), score=score, base_name=base_name)


def _reranker(llm, top_n=2, choice_batch_size=10, parse_fn=None):
    return LLMReranker(llm=llm, top_n=top_n, choice_batch_size=choice_batch_size,
                       parse_choice_select_answer_fn=parse_fn)


def test_missing_query_bundle_is_rejected():
    reranker = _reranker(_StubLLM())
    with pytest.raises(ValueError, match='Query bundle must be provided.'):
        reranker._postprocess_nodes([_node('文本', 1.0, 'kb')])


def test_empty_nodes_short_circuits_without_llm_call():
    llm = _StubLLM()
    reranker = _reranker(llm)

    assert reranker._postprocess_nodes([], query_bundle=QueryBundle(query_str='q')) == []
    assert llm.calls == []


def test_rerank_orders_by_relevance_and_keeps_base_name():
    llm = _StubLLM(responses=['Doc 1: 1, relevance: 9\nDoc 2: 2, relevance: 7'])
    nodes = [_node('第一段', 0.9, 'kb-1'), _node('第二段', 0.8, 'kb-2')]
    reranker = _reranker(llm, top_n=2)

    kept = reranker._postprocess_nodes(nodes, query_bundle=QueryBundle(query_str='问题'))

    assert [node.base_name for node in kept] == ['kb-1', 'kb-2']
    assert [node.score for node in kept] == [9.0, 7.0]
    assert kept[0].text == '第一段'
    # 提示词携带批次文本与原始问句
    assert llm.calls[0]['query_str'] == '问题'
    assert '第一段' in llm.calls[0]['context_str']


def test_top_n_truncates_after_sorting():
    llm = _StubLLM(responses=['Doc 1: 1, relevance: 9\nDoc 2: 2, relevance: 7'])
    nodes = [_node('第一段', 0.9, 'kb-1'), _node('第二段', 0.8, 'kb-2')]

    kept = _reranker(llm, top_n=1)._postprocess_nodes(nodes, query_bundle=QueryBundle(query_str='q'))

    assert [node.base_name for node in kept] == ['kb-1']


def test_multiple_batches_call_llm_per_batch():
    llm = _StubLLM(responses=['Doc: 1, relevance: 5', 'Doc: 1, relevance: 9'])
    nodes = [_node('第一段', 0.9, 'kb-1'), _node('第二段', 0.8, 'kb-2')]
    reranker = _reranker(llm, top_n=2, choice_batch_size=1)

    kept = reranker._postprocess_nodes(nodes, query_bundle=QueryBundle(query_str='q'))

    assert len(llm.calls) == 2
    # 按 relevance 降序：第二批（9 分）在前
    assert [(node.base_name, node.score) for node in kept] == [('kb-2', 9.0), ('kb-1', 5.0)]


def test_missing_relevances_default_to_one():
    llm = _StubLLM(responses=['随便'])
    parse_fn = lambda answer, num_choices: ([1], [])  # noqa: E731  (桩：只有选择，没有相关性)
    nodes = [_node('第一段', 0.9, 'kb-1')]

    kept = _reranker(llm, top_n=1, parse_fn=parse_fn)._postprocess_nodes(
        nodes, query_bundle=QueryBundle(query_str='q'))

    assert [(node.base_name, node.score) for node in kept] == [('kb-1', 1.0)]


def test_llm_failure_falls_back_to_head_of_original_nodes(caplog):
    llm = _StubLLM(error=RuntimeError('模型网关超时'))
    nodes = [_node('第一段', 0.9, 'kb-1'), _node('第二段', 0.8, 'kb-2')]
    reranker = _reranker(llm, top_n=1)

    kept = reranker._postprocess_nodes(nodes, query_bundle=QueryBundle(query_str='q'))

    # 原始节点按检索顺序原样返回（截到 top_n），不丢检索结果
    assert kept == nodes[:1]
    assert '[reranker] failed' in caplog.text
