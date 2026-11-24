"""自研原语层：models / llm / templating / token_split / interfaces 的分支补齐。

既有文件（test_primitives_models / _llm / _templating / _token_split / _components）
钉住了主路径；这里只补覆盖率报告里的**残余分支**：
  * models：node_id/set_content/get_embedding 三个小口、NodeWithScore 的 str/class_name/
    透传属性与非 TextNode 拒绝、StreamingResponse.get_response 消费生成器、
    MultiSelection.reason 的多选拒绝；
  * llm：CompletionResponse.__repr__、基类 stream() 的两条分发（chat 拒绝 / completion
    逐帧）、output_parser 参与 format/parse、system_prompt 仅限 chat 路径、
    模板日志失败不影响调用；
  * templating：function_mappings、completion_to_prompt、SelectorPromptTemplate 的
    conditionals 命中与 partial_format 透传、SingleSelectPrompt 装配；
  * token_split：分词器加载失败、overlap>size、切分递归、ratio 越界、chunk_size_limit
    上限、非正 chunk_size、repack；
  * interfaces：基类的默认实现与显式拒绝（get_description / retrieve / synthesize /
    run / select 委托）。
"""
from types import SimpleNamespace

import pytest

import tiktoken

from engine.primitives.components.selector import SelectionOutputParser
from engine.primitives.components.token_split import (
    PromptHelper,
    TokenizerTextSplitter,
    get_tokenizer,
)
from engine.primitives.interfaces import (
    RagQueryEngine,
    RagQueryTransform,
    RagRetriever,
)
from engine.primitives.llm import (
    CompletionResponse,
    LLMMetadata,
    LLM,
    stream_completion_response_to_tokens,
)
from engine.primitives.models import (
    MetadataMode,
    MultiSelection,
    Node,
    NodeWithScore,
    QueryBundle,
    Response,
    SingleSelection,
    StreamingResponse,
)
from engine.primitives.templating import (
    PromptTemplate,
    PromptType,
    SelectorPromptTemplate,
    SingleSelectPrompt,
)


# ==========================================================================
# models
# ==========================================================================

def test_node_id_setter_and_set_content_and_get_embedding():
    node = Node(text='旧', embedding=[0.1, 0.2])
    node.node_id = 'fixed-id'
    assert node.id_ == 'fixed-id' and node.node_id == 'fixed-id'
    node.set_content('新')
    assert node.text == '新'
    assert node.get_embedding() == [0.1, 0.2]


def test_node_with_score_class_name_and_str():
    assert NodeWithScore.class_name() == 'NodeWithScore'
    scored = NodeWithScore(node=Node(text='甲'), score=0.5)
    assert str(scored) == f'{scored.node}\nScore:  0.500\n'
    unscored = NodeWithScore(node=Node(text='乙'))
    assert 'Score: None' in str(unscored)


def test_node_with_score_passthrough_properties():
    node = Node(text='甲', metadata={'source': 'a.docx'}, embedding=[1.0])
    nws = NodeWithScore(node=node, score=1.0)
    assert nws.node_id == node.node_id
    assert nws.id_ == node.id_
    assert nws.text == '甲'
    assert nws.metadata == {'source': 'a.docx'}
    assert nws.embedding == [1.0]
    assert nws.get_text() == '甲'
    # LLM 模式会把 metadata 拼进正文（text_template 的形状）
    assert 'source: a.docx' in nws.get_content(metadata_mode=MetadataMode.LLM)


def test_node_with_score_text_access_requires_text_node():
    nws = NodeWithScore(node=SimpleNamespace(text='伪节点'))
    with pytest.raises(ValueError, match='Node must be a TextNode'):
        _ = nws.text
    with pytest.raises(ValueError, match='Node must be a TextNode'):
        nws.get_text()


def test_streaming_response_get_response_consumes_and_memorizes_gen():
    response = StreamingResponse(response_gen=(t for t in ['流', '式', '答']))
    out = response.get_response()
    assert isinstance(out, Response)
    assert out.response == '流式答'
    # 生成器已消费并记忆：再取同一段文本
    assert response.get_response().response == '流式答'


def test_multi_selection_reason_rejects_multiple_selections():
    multi = MultiSelection(selections=[SingleSelection(index=0, reason='a'),
                                       SingleSelection(index=1, reason='b')])
    with pytest.raises(ValueError, match='please use .reasons'):
        _ = multi.reason


# ==========================================================================
# llm
# ==========================================================================

class _CompletionLLM(LLM):
    """非 chat 的最小实现：metadata + complete/stream_complete。"""

    def __init__(self, answer='答', system_prompt=None, output_parser=None,
                 is_chat_model=False):
        super().__init__(system_prompt=system_prompt, output_parser=output_parser)
        self.answer = answer
        self._is_chat = is_chat_model
        self.prompts = []

    @property
    def metadata(self):
        return LLMMetadata(is_chat_model=self._is_chat)

    def complete(self, prompt, formatted=False, **kwargs):
        self.prompts.append(prompt)
        return CompletionResponse(text=self.answer)

    def stream_complete(self, prompt, formatted=False, **kwargs):
        self.prompts.append(prompt)
        yield CompletionResponse(text=self.answer, delta=self.answer)


def test_completion_response_repr():
    assert repr(CompletionResponse(text='x')) == "CompletionResponse(text='x', delta=None)"


def test_base_llm_stream_non_chat_yields_deltas():
    llm = _CompletionLLM(answer='帧')
    tokens = llm.stream(PromptTemplate('问 {q}'), q='题')
    assert list(tokens) == ['帧']
    assert llm.prompts == ['问 题']


def test_base_llm_stream_chat_model_is_not_supported():
    llm = _CompletionLLM(is_chat_model=True)
    with pytest.raises(NotImplementedError, match='stream_chat'):
        llm.stream(PromptTemplate('问 {q}'), q='题')


def test_base_llm_predict_applies_output_parser_on_format_and_parse():
    parser = SimpleNamespace(format=lambda s: s + '!!', parse=lambda s: f'解析:{s}')
    llm = _CompletionLLM(answer='答', output_parser=parser)
    # format 作用于提示词、parse 作用于响应文本（两条链路独立）
    assert llm.predict(PromptTemplate('问 {q}'), q='题') == '解析:答'
    assert llm.prompts == ['问 题!!']


def test_base_llm_system_prompt_without_chat_path_is_rejected():
    llm = _CompletionLLM(system_prompt='系统提示')
    with pytest.raises(NotImplementedError, match='system_prompt'):
        llm.predict(PromptTemplate('问 {q}'), q='题')


def test_base_llm_template_logging_failure_is_swallowed():
    llm = _CompletionLLM()
    assert llm._log_template_data(object(), q='题') is None   # prompt 无 kwargs 属性也不炸


def test_stream_tokens_map_missing_delta_to_empty_string():
    gen = stream_completion_response_to_tokens(
        iter([CompletionResponse(text='有字', delta=None)]))
    assert list(gen) == ['']


# ==========================================================================
# templating
# ==========================================================================

def test_format_applies_function_mappings():
    template = PromptTemplate('{a}-{b}',
                              function_mappings={'b': lambda **kw: kw['a'] + 1})
    assert template.format(a=1) == '1-2'


def test_format_applies_completion_to_prompt_wrapper():
    template = PromptTemplate('内容 {x}')
    wrapped = template.format(x=1, completion_to_prompt=lambda s: f'<s>{s}</s>')
    assert wrapped == '<s>内容 1</s>'


def _selector_with_conditionals():
    parser = SelectionOutputParser()
    default = PromptTemplate('默认 {q}', prompt_type=PromptType.QUESTION_ANSWER,
                             output_parser=parser)
    conditional = PromptTemplate('条件 {q}', prompt_type=PromptType.QUESTION_ANSWER)
    return SelectorPromptTemplate(
        default_template=default,
        conditionals=[(lambda llm: getattr(llm, 'chat', False), conditional)],
    )


def test_selector_prompt_selects_conditional_template_when_predicate_matches():
    selector = _selector_with_conditionals()
    picked = selector.select(llm=SimpleNamespace(chat=True))
    assert picked.template == '条件 {q}'
    assert picked.output_parser is selector.output_parser
    # 命中解析器时 format 会把 FORMAT_STR 追加在尾部（解析器自己的 format 行为）
    assert selector.format(llm=SimpleNamespace(chat=True), q='x').startswith('条件 x')


def test_selector_prompt_partial_format_applies_to_conditionals_too():
    selector = _selector_with_conditionals()
    selector.default_template.output_parser = None   # 摘掉解析器，免得 format 追加 FORMAT_STR
    partial = selector.partial_format(q='改写后')
    # partial_format 是「kwargs 注入」而不是改模板字符串
    assert partial.default_template.format() == '默认 改写后'
    assert partial.conditionals[0][1].format() == '条件 改写后'
    assert partial.format(llm=SimpleNamespace()) == '默认 改写后'


def test_single_select_prompt_initializes_with_parser():
    prompt = SingleSelectPrompt(template='选 {query_str}', output_parser=SelectionOutputParser())
    assert prompt.metadata['prompt_type'] == PromptType.SINGLE_SELECT
    assert prompt.output_parser is not None
    assert prompt.format(query_str='q').startswith('选 q')


# ==========================================================================
# token_split
# ==========================================================================

def test_get_tokenizer_wraps_vocab_failure_in_runtime_error(monkeypatch):
    monkeypatch.setattr('engine.primitives.components.token_split._TOKENIZER', None)
    monkeypatch.setattr(tiktoken, 'encoding_for_model',
                        lambda _model: (_ for _ in ()).throw(RuntimeError('词表坏了')))
    with pytest.raises(RuntimeError, match='tiktoken'):
        get_tokenizer()


def test_splitter_rejects_overlap_larger_than_chunk_size():
    with pytest.raises(ValueError, match='larger chunk overlap'):
        TokenizerTextSplitter(chunk_size=2, chunk_overlap=5,
                              tokenizer=lambda s: list(s))


def test_splitter_recurses_into_oversized_splits_by_char():
    splitter = TokenizerTextSplitter(chunk_size=2, chunk_overlap=0, separator=' ',
                                     backup_separators=[], tokenizer=lambda s: list(s))
    # 分隔符保留在后续分片头部（' efgh' 连着空格一起被按字符切），
    # 合并时 strip 掉首尾空白 → 空格落单成一块 'e'
    assert splitter.split_text('abcd efgh') == ['ab', 'cd', 'e', 'fg', 'h']


def test_prompt_helper_rejects_out_of_range_overlap_ratio():
    with pytest.raises(ValueError, match='chunk_overlap_ratio'):
        PromptHelper(chunk_overlap_ratio=1.5)


def test_prompt_helper_chunk_size_limit_caps_available_context():
    helper = PromptHelper(context_window=8000, num_output=100, chunk_size_limit=50)
    prompt = PromptTemplate('上下文 {context_str}')
    assert helper._get_available_chunk_size(prompt, num_chunks=1) == 50


def test_prompt_helper_rejects_non_positive_chunk_size():
    # available ≥ 0 但 available // num_chunks - padding ≤ 0 → 才走到这个分支
    helper = PromptHelper(context_window=16, num_output=5)
    prompt = PromptTemplate('上下文 {context_str}')
    with pytest.raises(ValueError, match='not positive'):
        helper.get_text_splitter_given_prompt(prompt, num_chunks=2)


def test_prompt_helper_repack_strips_and_joins_chunks():
    helper = PromptHelper(context_window=8000, num_output=100)
    prompt = PromptTemplate('上下文 {context_str}')
    assert helper.repack(prompt, [' a ', '', ' b ']) == ['a\n\nb']


# ==========================================================================
# interfaces
# ==========================================================================

class _StubRetriever(RagRetriever):
    def _retrieve(self, query_bundle):
        return []


class _StubEngine(RagQueryEngine):
    def _query(self, query_bundle):
        return None


class _StubTransform(RagQueryTransform):
    def _run(self, query_bundle, metadata):
        query_bundle.query_str = '改写后'
        return query_bundle


def test_retriever_default_description_is_none():
    assert _StubRetriever().get_description() is None


def test_query_engine_retrieve_and_synthesize_are_explicitly_unsupported():
    engine = _StubEngine()
    bundle = QueryBundle('q')
    with pytest.raises(NotImplementedError, match='does not support retrieve'):
        engine.retrieve(bundle)
    with pytest.raises(NotImplementedError, match='does not support synthesize'):
        engine.synthesize(bundle, nodes=[])


def test_query_transform_copies_config_and_run_delegates():
    transform = _StubTransform(config_dict={'llm': 'x'})
    assert transform.config_info == {'llm': 'x'}
    assert _StubTransform(None).config_info == {}
    out = transform.run(QueryBundle('原始'))
    assert out.query_str == '改写后'
