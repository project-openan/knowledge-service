"""自研原语层：LLM 重排与合成器的分支补齐
（`primitives/components/rerank.py`、`primitives/components/summarizer.py`）。

钉住：
  * 默认解析函数的坏行处理（`raise_error` 跳行 vs 抛错、`> num_choices` 丢弃）；
  * `LLMRerank` 构造期对 `top_n=None` 的显式拒绝与 `_postprocess_nodes` 全流程
    （分批、空相关性补 1.0、按分降序截 top_n）；
  * `_SynthesizerBase.synthesize` 的零节点哨兵（"Empty Response"）、流式/非流式装配、
    非法响应类型拒绝；
  * `SimpleSummarize.get_response` 的空串替换与流式透传；
  * `TreeSummarize.get_response` 的单块直答与多块递归归并。

LLM 一律打桩。
"""
from types import SimpleNamespace
from typing import List

import pytest

from engine.primitives.components.rerank import (
    LLMRerank,
    default_format_node_batch_fn,
    default_parse_choice_select_answer_fn,
)
from engine.primitives.components.summarizer import (
    SimpleSummarize,
    TreeSummarize,
    _SynthesizerBase,
    empty_response_generator,
)
from engine.primitives.components.token_split import PromptHelper
from engine.primitives.llm import LLMMetadata
from engine.primitives.models import (
    MetadataMode,
    Node,
    NodeWithScore,
    QueryBundle,
    Response,
    StreamingResponse,
)


class _StubLLM:
    """predict 返回固定作答；stream 返回逐帧生成器；metadata 可控。"""

    def __init__(self, answer='1: 9, 9\n2: 7, 7', is_chat_model=True):
        self.answer = answer
        self.calls: List[dict] = []
        self._metadata = LLMMetadata(context_window=8000, num_output=100,
                                     is_chat_model=is_chat_model)
        self.stream_answer = ['答', '案']

    @property
    def metadata(self):
        return self._metadata

    def predict(self, prompt, **kwargs):
        self.calls.append(kwargs)
        return self.answer

    def stream(self, prompt, **kwargs):
        self.calls.append(kwargs)
        yield from self.stream_answer

    def complete(self, prompt, formatted=False, **kwargs):
        self.calls.append({'prompt': prompt})
        return SimpleNamespace(text=self.answer)


def _nodes(*texts):
    return [NodeWithScore(node=Node(text=t, metadata={'source': 'a.docx'}), score=1.0)
            for t in texts]


# ==========================================================================
# rerank：默认函数
# ==========================================================================

def test_format_node_batch_numbers_documents_from_one():
    batch = default_format_node_batch_fn(
        [NodeWithScore(node=Node(text='甲'), score=1.0),
         NodeWithScore(node=Node(text='乙'), score=1.0)])
    assert batch == 'Document 1:\n甲\n\nDocument 2:\n乙'


def test_parse_answer_pairs():
    nums, rels = default_parse_choice_select_answer_fn(
        'Doc: 1, Relevance: 9\nDoc: 2, Relevance: 0', num_choices=2)
    assert nums == [1, 2]
    assert rels == [9.0, 0.0]


def test_parse_skips_malformed_line_by_default():
    nums, rels = default_parse_choice_select_answer_fn(
        '没有逗号的一行\nDoc: 1, Relevance: 8', num_choices=2)
    assert nums == [1] and rels == [8.0]


def test_parse_raise_error_rejects_malformed_line():
    with pytest.raises(ValueError, match='Invalid answer line'):
        default_parse_choice_select_answer_fn('糟糕的一行', num_choices=2, raise_error=True)


def test_parse_drops_answers_beyond_num_choices():
    nums, rels = default_parse_choice_select_answer_fn(
        'Doc: 3, Relevance: 9\nDoc: 1, Relevance: 4', num_choices=2)
    assert nums == [1] and rels == [4.0]


# ==========================================================================
# rerank：LLMRerank
# ==========================================================================

def test_top_n_none_is_rejected_at_construction():
    with pytest.raises(ValueError, match='top_n'):
        LLMRerank(llm=_StubLLM(), top_n=None)


def test_postprocess_requires_query_bundle():
    reranker = LLMRerank(llm=_StubLLM())
    with pytest.raises(ValueError, match='Query bundle'):
        reranker.postprocess_nodes(_nodes('a'), query_bundle=None)


def test_postprocess_empty_nodes_short_circuits():
    reranker = LLMRerank(llm=_StubLLM())
    assert reranker.postprocess_nodes([], query_bundle=QueryBundle('q')) == []


def test_postprocess_selects_reranks_and_truncates_to_top_n():
    llm = _StubLLM('A: 2, Relevance: 5\nB: 1, Relevance: 9')
    reranker = LLMRerank(llm=llm, top_n=1, choice_batch_size=10)
    out = reranker.postprocess_nodes(_nodes('甲', '乙'), query_bundle=QueryBundle('q'))
    # 两个候选都入选后按分降序，top_n=1 只留分最高的 '甲'
    assert [n.node.get_content() for n in out] == ['甲']
    assert out[0].score == 9.0
    assert llm.calls[0]['query_str'] == 'q'
    # LLM 模式会把 metadata 拼进正文（source: a.docx），只钉住 Document 编号形状
    assert llm.calls[0]['context_str'].startswith('Document 1:\n')


def test_postprocess_batches_and_defaults_missing_relevances():
    def parse_no_relevance(answer, num_choices):
        return [1], []               # 只选批内第 1 个，且作答没给相关性 → 补 1.0

    llm = _StubLLM()
    reranker = LLMRerank(llm=llm, top_n=5, choice_batch_size=1,
                         parse_choice_select_answer_fn=parse_no_relevance)
    out = reranker.postprocess_nodes(_nodes('甲', '乙'), query_bundle=QueryBundle('q'))
    assert [(n.node.get_content(), n.score) for n in out] == [('甲', 1.0), ('乙', 1.0)]
    assert len(llm.calls) == 2      # 每批独立 predict


# ==========================================================================
# summarizer：_SynthesizerBase
# ==========================================================================

def _base(streaming=False, llm=None):
    llm = llm or _StubLLM('合成答案')
    return _ConcreteBase(llm=llm, streaming=streaming)


class _ConcreteBase(_SynthesizerBase):
    """补一个 get_response 让基类可实例化（生产里由 SimpleSummarize 覆盖）。"""

    def get_response(self, query_str, text_chunks, **response_kwargs):
        return self._llm.predict(None, query_str=query_str,
                                 context_str=list(text_chunks), **response_kwargs)


def test_synthesize_zero_nodes_returns_empty_response_sentinel():
    base = _base(streaming=False)
    out = base.synthesize('q', nodes=[])
    assert isinstance(out, Response)
    assert out.response == 'Empty Response'

    streamed = _base(streaming=True).synthesize('q', nodes=[])
    assert isinstance(streamed, StreamingResponse)
    assert list(streamed.response_gen) == ['Empty Response']


def test_empty_response_generator_yields_the_sentinel_once():
    assert list(empty_response_generator()) == ['Empty Response']


def test_synthesize_prepares_response_with_metadata_and_extra_sources():
    base = _base()
    nodes = _nodes('甲')
    extra = _nodes('补充')
    out = base.synthesize(QueryBundle('q'), nodes=nodes,
                          additional_source_nodes=extra)
    assert out.response == '合成答案'
    assert out.source_nodes == nodes + extra
    assert out.metadata == {nodes[0].node.node_id: {'source': 'a.docx'},
                            extra[0].node.node_id: {'source': 'a.docx'}}


def test_prepare_response_output_wraps_generator_into_streaming_response():
    base = _base()
    gen = (t for t in ['流', '式'])
    out = base._prepare_response_output(gen, _nodes('甲'))
    assert isinstance(out, StreamingResponse)
    assert list(out.response_gen) == ['流', '式']


def test_synthesize_accepts_plain_string_query():
    base = _base()
    out = base.synthesize('裸字符串问题', nodes=_nodes('甲'))
    assert out.response == '合成答案'


def test_prepare_response_output_rejects_non_string_non_generator():
    base = _base()
    with pytest.raises(ValueError, match='Response must be'):
        base._prepare_response_output(12345, _nodes('甲'))


def test_get_metadata_maps_node_id_to_metadata():
    nodes = _nodes('甲')
    assert _SynthesizerBase._get_metadata_for_response(
        [n.node for n in nodes]) == {nodes[0].node.node_id: {'source': 'a.docx'}}


# ==========================================================================
# summarizer：SimpleSummarize / TreeSummarize
# ==========================================================================

def test_simple_summarize_replaces_blank_answer_with_sentinel():
    summarizer = SimpleSummarize(llm=_StubLLM(''))
    out = summarizer.get_response('q', ['块一', '块二'])
    assert out == 'Empty Response'


def test_simple_summarize_predicts_joined_chunks_non_streaming():
    llm = _StubLLM('正文')
    summarizer = SimpleSummarize(llm=llm)
    out = summarizer.get_response('问题', ['块一', '块二'])
    assert out == '正文'
    # 截断结果是一个 list，直接作为 context_str 传给 predict（既定形状）
    assert isinstance(llm.calls[0]['context_str'], list)
    assert len(llm.calls[0]['context_str']) == 1


def test_simple_summarize_streaming_delegates_to_llm_stream():
    llm = _StubLLM()
    llm.stream_answer = ['流', '式']
    summarizer = SimpleSummarize(llm=llm, streaming=True)
    out = summarizer.get_response('问题', ['块一'])
    assert list(out) == ['流', '式']


def test_tree_summarize_single_chunk_predicts_directly():
    llm = _StubLLM('单块总结')
    summarizer = TreeSummarize(llm=llm)
    assert summarizer.get_response('问题', ['短文本']) == '单块总结'


def test_tree_summarize_streaming_single_chunk_streams():
    llm = _StubLLM()
    llm.stream_answer = ['t', 'l']
    summarizer = TreeSummarize(llm=llm, streaming=True)
    assert list(summarizer.get_response('问题', ['短文本'])) == ['t', 'l']


class _SplittingHelper:
    """确定性 repack 桩：总长超阈值就切成两半，否则合并成一块。"""

    def repack(self, prompt, text_chunks, padding=5):
        joined = '\n\n'.join(text_chunks)
        if len(joined) <= 40:
            return [joined]
        mid = len(joined) // 2
        return [joined[:mid], joined[mid:]]


def test_tree_summarize_recurses_over_multiple_chunks():
    llm = _StubLLM(answer='第0段总结')   # 每块都答同一句（stub），递归把总结当新块再问
    summarizer = TreeSummarize(llm=llm, prompt_helper=_SplittingHelper())
    out = summarizer.get_response('问题', ['长' * 60])
    assert out == '第0段总结'
    # 两次切块总结 + 归并块直答（>=3 次 predict）
    assert len(llm.calls) >= 3
