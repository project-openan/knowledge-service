"""查询引擎的装配与委托（`query_engine/*` + `primitives/components/query_engine.py`）。

只补既有测试没盖到的行：

* `SequentialQueryEngine` 的 websearch 合流分支、`BlendedQueryEngine` 全装配、
  `ConditionalQueryEngine` 的算子分类 → Router 装配；
* `load_rag_operator` 的 enableWebSearch 出口（本构建里 websearch 是显式报错的占位）；
* `SelectPromptQueryEngine._query`（base_name → update_llm_and_prompt → synthesize）；
* `TransformQueryEngine.retrieve/synthesize`、`RetrieverQueryEngine.synthesize`、
  `combine_responses` 的流式分支、Router 单选失败时的报错包装。

网关一律桩掉：`load_rag_operator` 在消费模块的命名空间里替换（它是
`from engine.query_engine import load_rag_operator` 的**模块级绑定**）。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from engine.common.exception.rag_exception import RagException
from engine.pre_retriever.query_selector.base import BaseRagSelector
from engine.pre_retriever.query_transform.base import BaseRagQueryTransform
from engine.primitives.components.fusion import FUSION_MODES, QueryFusionRetriever
from engine.primitives.components.query_engine import (
    RetrieverQueryEngine,
    RouterQueryEngine,
    TransformQueryEngine,
    combine_responses,
)
from engine.primitives.interfaces import RagNodePostprocessor, RagSynthesizer
from engine.primitives.models import (
    QueryBundle,
    QueryEngineTool,
    Response,
    SelectorResult,
    SingleSelection,
    StreamingResponse,
    TextNode,
)
from engine.query_engine import OperatorBean, load_rag_operator
from engine.query_engine.blended_query_engine import BlendedQueryEngine
from engine.query_engine.conditional_query_engine import ConditionalQueryEngine
from engine.query_engine.multi_transform_query_engine import MultiTransformQueryEngine
from engine.query_engine.sequential_query_engine import SequentialQueryEngine
from engine.query_engine.select_prompt_query_engine import SelectPromptQueryEngine
from engine.retriever import RagNodeWithScore
from engine.retriever.base import BaseRagRetriever
from engine.retriever.fusion_retriever import FusionRetriever


# ---------------------------------------------------------------------------
# 轻量桩算子：只为 isinstance 分类与装配断言服务，不出网
# ---------------------------------------------------------------------------
class _Transform(BaseRagQueryTransform):
    def __init__(self):
        super().__init__({})

    def _run(self, query_bundle, metadata=None):
        return query_bundle

    @classmethod
    def from_args(cls, config_dict):
        return cls()


class _Selector(BaseRagSelector):
    """绕开 SingleSelector.__init__ 的 prompt 校验（分类/装配用不到它）。"""

    def __init__(self, result=None):
        self._llm = None
        self._prompt = None
        self._result = result or SelectorResult(selections=[SingleSelection(index=0, reason='r')])

    def _select(self, choices, query):
        return self._result

    @classmethod
    def from_args(cls, config_dict):
        return cls()


class _Retriever(BaseRagRetriever):
    def __init__(self, desc='向量检索描述', nodes=None):
        self.desc = desc
        self.nodes = list(nodes or [])
        self.retrieved = []

    def _retrieve(self, query_bundle):
        self.retrieved.append(query_bundle.query_str)
        return list(self.nodes)

    def get_description(self):
        return self.desc

    @classmethod
    def from_args(cls, config_dict):
        return cls()


class _Post(RagNodePostprocessor):
    def _postprocess_nodes(self, nodes, query_bundle=None):
        return nodes

    @classmethod
    def from_args(cls, config_dict):
        return cls()


class _Synth(RagSynthesizer):
    def __init__(self):
        super().__init__(llm=None, streaming=False)
        self.updates = []
        self.synth_calls = []

    def update_llm_and_prompt(self, base_name):
        self.updates.append(base_name)

    def synthesize(self, query, nodes, additional_source_nodes=None, **kwargs):
        self.synth_calls.append({'query': query, 'nodes': nodes,
                                 'additional': additional_source_nodes})
        return Response(response='合成答案', source_nodes=nodes,
                        query_str=getattr(query, 'query_str', ''))

    @classmethod
    def from_args(cls, config_dict):
        return cls()


class _InnerEngine:
    """TransformQueryEngine 的内层引擎替身（记录 transform 后的 query）。"""

    def __init__(self):
        self.retrieved = []
        self.synthesized = []

    def retrieve(self, query_bundle):
        self.retrieved.append(query_bundle.query_str)
        return []

    def synthesize(self, query_bundle, nodes, additional_source_nodes=None):
        self.synthesized.append((query_bundle.query_str, nodes, additional_source_nodes))
        return Response(response='inner')

    def _query(self, query_bundle):
        return Response(response='inner')


class _FakeRagContext:
    """as_query_engine(rag_context) 只用这三个口子，按鸭子类型给。"""

    def __init__(self, workflow_nodes, chain_by_node=None, enable_web_search=False):
        self._workflow_nodes = workflow_nodes
        self._chain = chain_by_node or {}
        self.user_request = SimpleNamespace(enableWebSearch=enable_web_search, apiKey='sk-test')
        self.request_headers = SimpleNamespace()

    def get_operators(self):
        return []

    def get_workflow_nodes(self):
        return list(self._workflow_nodes)

    def get_chain_all_nodes(self, node):
        return list(self._chain.get(node, []))


def _node(text, base_name='kb-a'):
    return RagNodeWithScore(node=TextNode(text=text, metadata={}), score=1.0, base_name=base_name)


# ---------------------------------------------------------------------------
# load_rag_operator 的 websearch 出口
# ---------------------------------------------------------------------------
def test_load_rag_operator_rejects_web_search(monkeypatch):
    class _Req:
        enableWebSearch = True
        apiKey = 'sk-test'

    ctx = _FakeRagContext(workflow_nodes=[])
    ctx.user_request = _Req()
    with pytest.raises(RagException) as exc:
        load_rag_operator(ctx)
    assert exc.value.get_error_tag() == 'web-search-not-supported'


def test_operatorbean_first_synthesizer_is_none_when_absent():
    bean = OperatorBean({'r': _Retriever()}, ['r'])
    assert bean.get_first_response_synthesizer() is None


# ---------------------------------------------------------------------------
# Sequential / Blended
# ---------------------------------------------------------------------------
def test_sequential_engine_fuses_with_websearch(monkeypatch):
    import engine.query_engine.sequential_query_engine as seq

    retriever = _Retriever()
    websearch = _Retriever(desc='web')
    monkeypatch.setattr(seq, 'load_rag_operator', lambda ctx: {
        'r1': retriever, 'p1': _Post(), 's1': _Synth(), 'websearch': websearch})

    engine = SequentialQueryEngine.as_query_engine(_FakeRagContext(['r1', 'p1', 's1']))

    assert isinstance(engine, MultiTransformQueryEngine)
    inner = engine._query_engine
    assert isinstance(inner, SelectPromptQueryEngine)
    assert isinstance(inner._retriever, QueryFusionRetriever)
    assert inner._retriever._retrievers[0] is retriever
    assert inner._retriever._retrievers[1] is websearch
    assert len(inner._node_postprocessors) == 1
    assert inner._response_synthesizer.synth_calls == []


def test_blended_engine_assembles_fusion_pipeline(monkeypatch):
    import engine.query_engine.blended_query_engine as blended

    fusion = FusionRetriever(retrievers=[], similarity_top_k=500,
                             mode=FUSION_MODES.RELATIVE_SCORE, retriever_weights=[],
                             num_queries=1, llm=None, use_async=False)
    post, synth = _Post(), _Synth()
    monkeypatch.setattr(blended, 'load_rag_operator', lambda ctx: {
        'fusion': fusion, 'r1': _Retriever(), 'p1': post, 's1': synth})

    engine = BlendedQueryEngine.as_query_engine(_FakeRagContext(['fusion', 'r1', 'p1', 's1']))

    assert isinstance(engine, MultiTransformQueryEngine)
    inner = engine._query_engine
    assert inner._retriever is fusion
    # 空权重列表 → 归一后仍为空 → 回落 RRF 模式
    assert inner._retriever.mode.value == 'reciprocal_rerank'
    assert inner._node_postprocessors == [post]
    assert inner._response_synthesizer is synth


def test_blended_engine_appends_websearch_retriever(monkeypatch):
    import engine.query_engine.blended_query_engine as blended

    fusion = FusionRetriever(retrievers=[], similarity_top_k=500,
                             mode=FUSION_MODES.RELATIVE_SCORE, retriever_weights=[],
                             num_queries=1, llm=None, use_async=False)
    websearch = _Retriever(desc='web')
    monkeypatch.setattr(blended, 'load_rag_operator', lambda ctx: {
        'fusion': fusion, 'r1': _Retriever(), 'websearch': websearch})

    BlendedQueryEngine.as_query_engine(_FakeRagContext(['fusion', 'r1']))

    assert fusion._retrievers[0].desc == '向量检索描述'
    assert websearch in fusion._retrievers


# ---------------------------------------------------------------------------
# Conditional：算子分类 → Router 装配
# ---------------------------------------------------------------------------
def _install_conditional(monkeypatch, operators):
    import engine.query_engine.conditional_query_engine as conditional

    monkeypatch.setattr(conditional, 'load_rag_operator', lambda ctx: operators)
    return conditional


def test_conditional_engine_routes_retriever_chain(monkeypatch):
    transform = _Transform()
    selector = _Selector()
    retriever = _Retriever(desc='向量检索描述')
    post, synth = _Post(), _Synth()
    websearch = _Retriever(desc='web')
    _install_conditional(monkeypatch, {
        't1': transform, 'sel': selector, 'r1': retriever,
        'p1': post, 's1': synth, 'websearch': websearch,
    })

    engine = ConditionalQueryEngine.as_query_engine(
        _FakeRagContext(['t1', 'sel', 'r1'], chain_by_node={'r1': ['p1', 's1']}))

    assert isinstance(engine, MultiTransformQueryEngine)
    assert engine.query_transforms == [transform]
    router = engine._query_engine
    assert isinstance(router, RouterQueryEngine)
    assert router._selector is selector
    assert len(router._query_engines) == 1
    assert router._metadatas[0].description == '向量检索描述'  # fusion → 首个子检索器的描述


def test_conditional_engine_without_websearch_keeps_plain_retriever(monkeypatch):
    selector = _Selector()
    retriever = _Retriever(desc='标量检索描述')
    _install_conditional(monkeypatch, {'sel': selector, 'r1': retriever, 's1': _Synth()})

    engine = ConditionalQueryEngine.as_query_engine(
        _FakeRagContext(['sel', 'r1'], chain_by_node={'r1': ['s1']}))

    router = engine._query_engine
    assert router._selector is selector
    inner_engine = router._query_engines[0]
    # 非 fusion 检索器原样进工具，描述取自身
    assert inner_engine._retriever is retriever
    assert router._metadatas[0].description == '标量检索描述'
    assert router._summarizer is not None


# ---------------------------------------------------------------------------
# SelectPromptQueryEngine._query
# ---------------------------------------------------------------------------
def test_select_prompt_engine_updates_synthesizer_with_base_name():
    synth = _Synth()
    retriever = _Retriever(nodes=[_node('命中文本', base_name='kb-a')])
    engine = SelectPromptQueryEngine(retriever=retriever, response_synthesizer=synth)

    response = engine.query('问题')

    assert synth.updates == ['kb-a']
    assert synth.synth_calls[0]['nodes'] == retriever.nodes
    assert response.response == '合成答案'


def test_select_prompt_engine_handles_empty_retrieval():
    synth = _Synth()
    engine = SelectPromptQueryEngine(retriever=_Retriever(nodes=[]), response_synthesizer=synth)

    engine.query('问题')

    assert synth.updates == ['']


# ---------------------------------------------------------------------------
# components/query_engine.py 的缺口
# ---------------------------------------------------------------------------
def test_transform_engine_retrieve_and_synthesize_run_transform_first():
    transform = _Transform()
    inner = _InnerEngine()
    engine = TransformQueryEngine(query_engine=inner, query_transform=transform)

    assert engine.retrieve(QueryBundle(query_str='原始问')) == []
    assert inner.retrieved == ['原始问']

    nodes = [_node('文本')]
    extra = [_node('补充')]
    engine.synthesize(QueryBundle(query_str='原始问'), nodes, additional_source_nodes=extra)
    assert inner.synthesized == [('原始问', nodes, extra)]


def test_retriever_engine_synthesize_delegates_with_additional_nodes():
    synth = _Synth()
    engine = RetrieverQueryEngine(retriever=_Retriever(), response_synthesizer=synth)
    nodes = [_node('文本')]
    extra = [_node('补充')]

    result = engine.synthesize(QueryBundle(query_str='问题'), nodes, additional_source_nodes=extra)

    assert result.response == '合成答案'
    assert synth.synth_calls[0]['nodes'] == nodes
    assert synth.synth_calls[0]['additional'] == extra


def test_combine_responses_yields_streaming_response_when_summary_is_a_generator():
    streaming = StreamingResponse(response_gen=iter(['流式', '片段']),
                                  source_nodes=[_node('来源')], query_str='问题')
    # __str__ 会消费生成器并记忆：combine_responses 靠它取各子响应文本
    assert str(streaming) == '流式片段'
    summarizer = SimpleNamespace(get_response=lambda query_str, strs: iter(['分', '结']))

    result = combine_responses(summarizer, [streaming], QueryBundle(query_str='问题'))

    assert isinstance(result, StreamingResponse)
    assert result.query_str == '问题'
    assert [node.base_name for node in result.source_nodes] == ['kb-a']
    assert list(result.response_gen) == ['分', '结']


def test_router_engine_wraps_failed_single_selection(monkeypatch):
    selector = _Selector(result=SelectorResult(selections=[]))  # 0 命中 → .ind 抛 ValueError
    tool = QueryEngineTool.from_defaults(query_engine=_InnerEngine(), description='d')
    engine = RouterQueryEngine(selector=selector, query_engine_tools=[tool])

    with pytest.raises(ValueError, match='Failed to select query engine'):
        engine.query(QueryBundle(query_str='问题'))
