"""自研原语层：选择器的分支补齐（`primitives/components/selector.py` 与
`pre_retriever/query_selector/query_routing.py`）。

钉住解析链的每一段：
  * `_marshal_llm_to_json` 的取边界规则（首个 `[`/`{` vs 最后 `]`/`}`，`{{`/`}}` 去转义）；
  * `SelectionOutputParser.parse`：JSON 直读 / dict 包一层 / yaml 兜底 / 坏 yaml 抛
    `OutputParserException` / 空对象抛 `ValueError`；
  * `_filter_dict` / `_format_output` 的收敛（嵌套 dict、list 内 dict）；
  * `SingleSelector` 的装配与 `_select`（stub LLM 抓 predict 的 kwargs）；
  * `LLMSemanticRouting`：解析失败时兜底路由到第一个 query-engine（index=0）。
"""
from types import SimpleNamespace

import pytest

from engine.pre_retriever.query_selector import query_routing
from engine.primitives.components.selector import (
    FORMAT_STR,
    OutputParserException,
    SelectionOutputParser,
    SingleSelector,
    _build_choices_text,
    _escape_curly_braces,
    _marshal_llm_to_json,
    _structured_output_to_selector_result,
)
from engine.primitives.models import QueryBundle, ToolMetadata
from engine.primitives.prompts import DEFAULT_SINGLE_SELECT_PROMPT_TMPL
from engine.primitives.templating import PromptTemplate, PromptType


class _StubLLM:
    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    def predict(self, **kwargs):
        self.calls.append(kwargs)
        return self.answer


# ==========================================================================
# 纯函数
# ==========================================================================

def test_escape_curly_braces_doubles_braces():
    assert _escape_curly_braces('a {b} c') == 'a {{b}} c'


def test_marshal_takes_square_bracket_span_when_it_comes_first():
    assert _marshal_llm_to_json('x [1] y {2}') == '[1]'
    # 边界怪癖（与库一致）：没有花括号时条件不成立 → 落到 brace 分支 → 空串
    assert _marshal_llm_to_json('前言 [1, 2] 后记') == ''


def test_marshal_takes_brace_span_otherwise():
    assert _marshal_llm_to_json('{"choice": 1}') == '{"choice": 1}'


def test_marshal_strips_doubled_braces_first():
    assert _marshal_llm_to_json('{{"choice": 2}}') == '{"choice": 2}'


def test_marshal_without_any_delimiter_returns_empty_string():
    assert _marshal_llm_to_json('纯文本作答') == ''


def test_build_choices_text_joins_multiline_descriptions():
    choices = [
        ToolMetadata(name='a', description='第一行\n第二行'),
        ToolMetadata(name='b', description=None),
    ]
    assert _build_choices_text(choices) == '(1) 第一行 第二行\n\n(2) '


def test_structured_output_to_selector_result_shifts_to_zero_based():
    answers = SimpleNamespace(parsed_output=[
        SimpleNamespace(choice=1, reason='第一个'),
        SimpleNamespace(choice=3, reason='第三个'),
    ])
    result = _structured_output_to_selector_result(answers)
    assert [(s.index, s.reason) for s in result.selections] == [(0, '第一个'), (2, '第三个')]


# ==========================================================================
# SelectionOutputParser
# ==========================================================================

def test_parse_json_list_directly():
    out = SelectionOutputParser().parse('[{"choice": 2, "reason": "r"}]')
    assert out.raw_output == '[{"choice": 2, "reason": "r"}]'
    assert [(a.choice, a.reason) for a in out.parsed_output] == [(2, 'r')]


def test_parse_single_dict_gets_wrapped_into_list():
    out = SelectionOutputParser().parse('{"choice": "1", "reason": 3}')
    # 数值字符串强转（Answer.from_dict 按注记 cast）
    assert out.parsed_output[0].choice == 1
    assert out.parsed_output[0].reason == '3'


def test_parse_takes_substring_after_preface():
    out = SelectionOutputParser().parse('说明文字\n[{"choice": 1, "reason": "x"}]\n尾')
    assert len(out.parsed_output) == 1


def test_parse_falls_back_to_yaml_when_json_is_invalid():
    out = SelectionOutputParser().parse('{choice: 2, reason: yaml 兜底}')
    assert out.parsed_output[0].choice == 2
    assert out.parsed_output[0].reason == 'yaml 兜底'


def test_parse_invalid_yaml_raises_output_parser_exception():
    # 边界必须成对（右括号要能被 rfind 到），坏的内容交给 yaml 兜底时才炸
    with pytest.raises(OutputParserException, match='Got invalid JSON object'):
        SelectionOutputParser().parse('[{a: b: c}]')


def test_parse_empty_object_raises_value_error():
    with pytest.raises(ValueError, match='Failed to convert output to JSON'):
        SelectionOutputParser().parse('纯文本，没有任何结构')


def test_filter_dict_keeps_only_required_keys_from_nested_payloads():
    parser = SelectionOutputParser()
    merged = parser._filter_dict({
        'noise': 1,
        'nest': {'extra': 2, 'nested_list': [{'junk': 3}, {'choice': 5, 'reason': 'deep'}]},
    })
    assert merged == {'choice': 5, 'reason': 'deep'}


def test_format_output_refilters_entries_missing_required_keys():
    parser = SelectionOutputParser()
    # 键齐 → 原样保留；缺键 → 整体收敛（嵌套 dict 里找回 choice/reason）
    assert parser._format_output([{'choice': 1, 'reason': 'r', 'junk': 0}]) == [
        {'choice': 1, 'reason': 'r', 'junk': 0}]
    assert parser._format_output([{'junk': {'choice': 4, 'reason': 'deep'}}]) == [
        {'choice': 4, 'reason': 'deep'}]


def test_format_appends_escaped_format_str():
    template = '选择一个'
    formatted = SelectionOutputParser().format(template)
    assert formatted == template + '\n\n' + _escape_curly_braces(FORMAT_STR)


def test_parse_without_yaml_installed_raises_import_error(monkeypatch):
    from engine.primitives.components import selector as selector_module
    monkeypatch.delattr(selector_module, 'yaml')   # 模拟 PyYAML 未安装
    with pytest.raises(ImportError, match='PyYAML'):
        SelectionOutputParser().parse('[{a: b: c}]')


# ==========================================================================
# SingleSelector
# ==========================================================================

def test_selector_requires_prompt_with_output_parser():
    plain = PromptTemplate('q: {query_str}', prompt_type=PromptType.SINGLE_SELECT)
    with pytest.raises(ValueError, match='output parser'):
        SingleSelector(llm=_StubLLM(''), prompt=plain)


def test_from_defaults_uses_default_template_and_parser():
    selector = SingleSelector.from_defaults(llm=_StubLLM(''))
    assert selector._prompt.template == DEFAULT_SINGLE_SELECT_PROMPT_TMPL
    assert isinstance(selector._prompt.output_parser, SelectionOutputParser)


def test_from_defaults_blank_template_string_falls_back_to_default():
    selector = SingleSelector.from_defaults(llm=_StubLLM(''), prompt_template_str='')
    assert selector._prompt.template == DEFAULT_SINGLE_SELECT_PROMPT_TMPL


def test_select_passes_choices_text_and_query_to_llm():
    llm = _StubLLM('[{"choice": 1, "reason": "选它"}]')
    selector = SingleSelector.from_defaults(llm=llm)
    choices = [ToolMetadata(name='r0', description='引擎一'), ToolMetadata(name='r1', description='引擎二')]
    result = selector.select(choices, QueryBundle('哪个引擎'))
    assert result.selections[0].index == 0
    assert llm.calls[0]['num_choices'] == 2
    assert '(1) 引擎一' in llm.calls[0]['context_list']
    assert llm.calls[0]['query_str'] == '哪个引擎'


# ==========================================================================
# LLMSemanticRouting（pre_retriever/query_selector）
# ==========================================================================

def _routing(monkeypatch, answer):
    seen = {}

    def fake_llm(llm_name, llm_config):
        seen['llm'] = llm_name
        seen['config'] = llm_config
        return _StubLLM(answer)

    monkeypatch.setattr(query_routing, 'get_custom_llm', fake_llm)
    return seen


def test_routing_from_args_defaults_to_aux_thinking_profile(monkeypatch):
    seen = _routing(monkeypatch, '[{"choice": 1, "reason": "r"}]')
    routing = query_routing.LLMSemanticRouting.from_args({'llm': 'qwen-x'})
    assert seen['llm'] == 'qwen-x'
    assert seen['config']['thinking_profile'] == 'aux'
    result = routing.select([ToolMetadata(name='a', description='A')], QueryBundle('q'))
    assert result.selections[0].index == 0


def test_routing_parse_failure_falls_back_to_first_engine(monkeypatch):
    _routing(monkeypatch, '完全不是结构化的作答')
    routing = query_routing.LLMSemanticRouting.from_args({'prompt': None})
    choices = [ToolMetadata(name='a', description='A'), ToolMetadata(name='b', description='B')]
    result = routing.select(choices, QueryBundle('q'))
    assert [(s.index, s.reason) for s in result.selections] == [(0, 'Failed to select')]
