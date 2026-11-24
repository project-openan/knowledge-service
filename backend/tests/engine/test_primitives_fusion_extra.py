"""自研原语层：融合检索的分支补齐（`primitives/components/fusion.py` 与
`retriever/fusion_retriever.py`）。

既有测试只盖到装配路径；这里钉住四种融合模式的**算术本身**与两个显式拒绝：
  * 权重归一化发生在构造期（缺省 1/n、显式权重按总和归一）；
  * `use_async=True` 必须显式报错（不悄悄退化成同步）；
  * 未知 mode 报 ValueError；
  * RELATIVE_SCORE 的 MinMax / 均值±3σ / 空结果 / 同分组同分四个角落；
  * `FusionRetriever` 子类覆盖的 RRF：重复文本时优先带 `related_chunk_ids` 的代表节点，
    `update_retrievers` 在权重数对不上时把模式扳回 RECIPROCAL_RANK。

LLM/子检索器一律打桩，不出网。
"""
from types import SimpleNamespace

import pytest

from engine.primitives.components.fusion import (
    DEFAULT_SIMILARITY_TOP_K,
    FUSION_MODES,
    QUERY_GEN_PROMPT,
    QueryFusionRetriever,
)
from engine.primitives.interfaces import RagRetriever
from engine.primitives.models import Node, NodeWithScore, QueryBundle
from engine.retriever.fusion_retriever import FusionRetriever


class _StubRetriever(RagRetriever):
    """按检索器编号返回固定节点的桩。"""

    def __init__(self, nodes, name='stub'):
        self._nodes = nodes
        self.name = name
        self.calls = []

    def _retrieve(self, query_bundle):
        self.calls.append(query_bundle.query_str)
        return [NodeWithScore(node=Node(text=t), score=s)
                for t, s in self._nodes]

    def get_description(self):
        return self.name


class _StubLLM:
    """`complete()` 返回固定多行文本的桩（query 生成用）。"""

    def __init__(self, text):
        self.text = text
        self.prompts = []

    def complete(self, prompt):
        self.prompts.append(prompt)
        return SimpleNamespace(text=self.text)


def _nws(text, score):
    return NodeWithScore(node=Node(text=text), score=score)


# ==========================================================================
# QueryFusionRetriever：构造与取数
# ==========================================================================

def test_default_similarity_top_k_and_weights_are_uniform():
    r1 = _StubRetriever([])
    r2 = _StubRetriever([])
    fusion = QueryFusionRetriever(retrievers=[r1, r2], use_async=False)
    assert fusion.similarity_top_k == DEFAULT_SIMILARITY_TOP_K
    assert fusion.query_gen_prompt == QUERY_GEN_PROMPT
    assert fusion._retriever_weights == [0.5, 0.5]


def test_retriever_weights_are_normalized_at_construction():
    fusion = QueryFusionRetriever(
        retrievers=[_StubRetriever([]), _StubRetriever([]), _StubRetriever([])],
        retriever_weights=[1, 3, 4], use_async=False)
    assert fusion._retriever_weights == [0.125, 0.375, 0.5]


def test_num_queries_over_one_generates_queries_via_llm():
    llm = _StubLLM('q-a\nq-b\nq-c\nq-d')
    r1 = _StubRetriever([('a', 1.0)])
    fusion = QueryFusionRetriever(retrievers=[r1], llm=llm, num_queries=3,
                                  use_async=False)
    queries = fusion._get_queries('原始问题')
    assert [q.query_str for q in queries] == ['q-a', 'q-b']   # 截到 num_queries-1
    assert '原始问题' in llm.prompts[0]
    # 完整链路：原始 query + 生成的 query 都被下发到子检索器
    fusion._retrieve(QueryBundle('原始问题'))
    assert r1.calls == ['原始问题', 'q-a', 'q-b']


def test_use_async_true_is_rejected_loudly():
    fusion = QueryFusionRetriever(retrievers=[_StubRetriever([])], num_queries=1,
                                  use_async=True)
    with pytest.raises(NotImplementedError):
        fusion.retrieve(QueryBundle('q'))


def test_unknown_mode_raises_value_error():
    fusion = QueryFusionRetriever(retrievers=[_StubRetriever([('a', 1.0)])],
                                  mode='no-such-mode', num_queries=1, use_async=False)
    with pytest.raises(ValueError, match='Invalid fusion mode'):
        fusion.retrieve(QueryBundle('q'))


# ==========================================================================
# 四种融合的算术
# ==========================================================================

def _fusion(mode, retriever_nodes, weights=None, top_k=10):
    retrievers = [_StubRetriever(nodes) for nodes in retriever_nodes]
    return QueryFusionRetriever(retrievers=retrievers, mode=mode,
                                similarity_top_k=top_k, num_queries=1,
                                use_async=False, retriever_weights=weights)


def test_reciprocal_rank_fusion_sums_rank_scores():
    """基础 RRF：同一文本在两个检索器都排第 0 → 2/(0+60)。"""
    fusion = _fusion(FUSION_MODES.RECIPROCAL_RANK,
                     [[('共享', 0.9), ('独有', 0.8)], [('共享', 0.7)]])
    nodes = fusion.retrieve(QueryBundle('q'))
    by_text = {n.node.get_content(): n for n in nodes}
    assert by_text['共享'].score == pytest.approx(2 / 60.0)
    assert by_text['独有'].score == pytest.approx(1 / 61.0)
    assert nodes[0].node.get_content() == '共享'


def test_relative_score_fusion_normalizes_dedups_and_applies_weights():
    """不同分组各自 MinMax → 乘权重 → 除 num_queries → 按文本求和。"""
    fusion = _fusion(FUSION_MODES.RELATIVE_SCORE,
                     [[('a', 1.0), ('b', 0.0)], [('a', 0.0), ('c', 1.0)]],
                     weights=[3, 1], top_k=5)
    nodes = fusion.retrieve(QueryBundle('q'))
    by_text = {n.node.get_content(): n for n in nodes}
    # 'a'：第一组归一 1.0 * 0.75 / 1 + 第二组归一 0.0 * 0.25 / 1
    assert by_text['a'].score == pytest.approx(0.75)
    assert by_text['c'].score == pytest.approx(0.25)
    assert by_text['b'].score == pytest.approx(0.0)
    assert [n.node.get_content() for n in nodes][:1] == ['a']


def test_relative_score_fusion_handles_empty_group_and_identical_scores():
    fusion = QueryFusionRetriever(
        retrievers=[_StubRetriever([]), _StubRetriever([('x', 0.5), ('y', 0.5)]),
                    _StubRetriever([('zero', 0.0), ('z2', 0.0)])],
        mode=FUSION_MODES.RELATIVE_SCORE, similarity_top_k=10, num_queries=2,
        use_async=False, llm=_StubLLM(''))
    nodes = {n.node.get_content(): n for n in fusion.retrieve(QueryBundle('q'))}
    # 空组 → (0,0)；同分组同分且 >0 → 全 1.0；同分且 ==0 → 0.0
    # （num_queries=2 → 原始 query + 生成的一个空 query，'x' 被 1.0*权重/2 累加两次）
    assert nodes['x'].score == pytest.approx(1.0 / 3)
    assert nodes['zero'].score == 0.0


def test_dist_based_score_fusion_uses_mean_plus_minus_3_sigma():
    # 同分组等差分布：mean=0.5, σ≈0.4714 → min/max 覆盖全范围 → 归一后 0 与 1
    fusion = _fusion(FUSION_MODES.DIST_BASED_SCORE,
                     [[('low', 0.0), ('high', 1.0)], [('low', 0.0), ('high', 1.0)]],
                     weights=[1, 1])
    nodes = {n.node.get_content(): n for n in fusion.retrieve(QueryBundle('q'))}
    assert nodes['high'].score > nodes['low'].score


def test_simple_fusion_keeps_max_score_per_text():
    fusion = _fusion(FUSION_MODES.SIMPLE,
                     [[('a', 0.3), ('b', 0.9)], [('a', 0.8)]], top_k=2)
    nodes = fusion.retrieve(QueryBundle('q'))
    by_text = {n.node.get_content(): n for n in nodes}
    assert by_text['a'].score == pytest.approx(0.8)
    assert [n.node.get_content() for n in nodes] == ['b', 'a']   # top_k=2 截断


# ==========================================================================
# FusionRetriever（vendored 子类）
# ==========================================================================

def _fusion_retriever(weights):
    return FusionRetriever.from_args(config_dict={'weights': weights})


def test_from_args_defaults_to_relative_score_with_empty_weights():
    fusion = _fusion_retriever([])
    assert fusion.mode == FUSION_MODES.RELATIVE_SCORE
    assert fusion.similarity_top_k == 500
    assert fusion.num_queries == 1
    assert fusion.use_async is False


def test_update_retrievers_flips_to_rrf_on_weight_mismatch():
    fusion = _fusion_retriever([1, 3])
    fusion.update_retrievers([_StubRetriever([])])            # 权重 2 个、检索器 1 个
    assert fusion.mode == FUSION_MODES.RECIPROCAL_RANK
    # 修正后不回切：update_retrievers 只会把模式扳向 RECIPROCAL_RANK（单向保险丝）
    fusion.update_retrievers([_StubRetriever([]), _StubRetriever([])])
    assert fusion.mode == FUSION_MODES.RECIPROCAL_RANK


def test_vendored_rrf_prefers_nodes_with_related_chunk_ids():
    """重复文本出现两次：代表节点让给带 related_chunk_ids 的那份。"""
    fusion = _fusion_retriever([])
    plain = _nws('同文', 0.9)
    related = NodeWithScore(
        node=Node(text='同文', metadata={'related_chunk_ids': ['c-1']}), score=0.1)
    results = {('q', 0): [plain], ('q', 1): [related]}
    nodes = fusion._reciprocal_rerank_fusion(results)
    assert len(nodes) == 1
    assert nodes[0].node.metadata.get('related_chunk_ids') == ['c-1']
    assert nodes[0].score == pytest.approx(2 / 60.0)


def test_vendored_rrf_keeps_first_node_when_none_has_related_ids():
    fusion = _fusion_retriever([])
    first = _nws('同文', 0.9)
    results = {('q', 0): [first], ('q', 1): [_nws('同文', 0.1)]}
    nodes = fusion._reciprocal_rerank_fusion(results)
    assert nodes[0] is first


def test_fusion_retriever_end_to_end_rrf_retrieval():
    r1 = _StubRetriever([('共享', 0.9), ('独有', 0.8)])
    r2 = _StubRetriever([('共享', 0.7)])
    fusion = _fusion_retriever([])
    fusion.update_retrievers([r1, r2])                        # 权重数不匹配 → RRF
    nodes = fusion.retrieve(QueryBundle('q'))
    assert [n.node.get_content() for n in nodes] == ['共享', '独有']
    assert r1.calls == ['q'] and r2.calls == ['q']
