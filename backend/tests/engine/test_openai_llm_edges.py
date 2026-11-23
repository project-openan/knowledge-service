"""LLM 适配器的错误与分支补齐（`custom_llm/openai_llm.py`）。

`test_llm_stream.py` 已钉住正常流式链、敏感词滑窗与推理标记；本文件补
覆盖率报告里的**残余分支**，全部 monkeypatch `egress.post` / `model_bridge.resolve_llm`，
不出网：

  * 纯函数：`_strip_error_pict_marks`、`_merge_message_with_reasoning` 的两个分支、
    `_related_context_from_prompt_args` 的 None 入参；
  * `stream()` 对 output_parser 的显式拒绝；
  * 非流式 `_chat()` 的四类失败（无 url / 连接失败 / 非 2xx / 非 JSON）；
  * 流式 `_chat_stream()` 的同类失败；
  * `_extract_content()` 的三种空内容语义（no-choices / 推理吃光预算 / 普通空）；
  * `generate_answer()` 空回答回落 i18n 文案、`generate_answer_stream()` 坏模板兜底帧；
  * `_save_chat_history` 的静默失败、`_max_tokens/_temperature` 的坏配置回落、
    system_prompt 组装、空 choices 帧、黑名单声明但词表缺失的告警。
"""
import json
from types import SimpleNamespace

import pytest

import engine.settings as config
import engine.i18n as i18n
from engine.cache import chat_memory
from engine.common.beans.rag_request import RagRequest
from engine.common.exception.rag_exception import RagException
from engine.config_loader import black_list_loader
from engine.custom_llm import openai_llm
from engine.custom_llm.openai_llm import (
    OpenAICompatLLM,
    _content_has_redacted_thinking_markup,
    _merge_message_with_reasoning,
    _related_context_from_prompt_args,
    _strip_error_pict_marks,
)
from engine.primitives.templating import PromptTemplate

FAIL_TEXT = i18n.get_i18n_safe('zh', 'request-llm-failed')
GATEWAY_FAIL = 'request-model-gateway-failed'


# ---------------------------------------------------------------------------
# 桩：非流式响应 / 端点 / egress.post
# ---------------------------------------------------------------------------

class _FakeJsonResponse:
    def __init__(self, payload=None, status_code=200, bad_json=False):
        self.status_code = status_code
        self.text = 'upstream is not json' if bad_json else json.dumps(payload or {})
        self._payload = payload or {}
        self._bad_json = bad_json

    def json(self):
        if self._bad_json:
            raise ValueError('not json')
        return self._payload


class _FakeStreamResponse:
    def __init__(self, frames, status_code=200):
        self.status_code = status_code
        self.text = 'upstream body'
        self.encoding = None
        self._frames = list(frames)
        self.closed = False

    def iter_lines(self, decode_unicode=False, **kwargs):
        codec = self.encoding or 'ISO-8859-1'
        for frame in self._frames:
            if isinstance(frame, Exception):
                raise frame
            yield frame.encode('utf-8').decode(codec) if decode_unicode else frame.encode('utf-8')

    def close(self):
        self.closed = True


def _install_post(monkeypatch, payload=None, status_code=200, bad_json=False,
                  stream_frames=(), post_raises=None):
    captured = []

    def fake_post(url, json=None, headers=None, timeout=None, stream=False, **kwargs):
        captured.append({'url': url, 'body': json, 'stream': stream})
        if post_raises is not None:
            raise post_raises
        if stream:
            return _FakeStreamResponse(stream_frames, status_code=status_code)
        return _FakeJsonResponse(payload, status_code=status_code, bad_json=bad_json)

    monkeypatch.setattr(openai_llm.egress, 'post', fake_post)
    return captured


def _stub_endpoint(monkeypatch, url='http://endpoint.test/v1'):
    endpoint = SimpleNamespace(url=url, api_model='stub-model', timeout=5,
                               headers=lambda: {'Content-Type': 'application/json'})
    import engine.gateways.model_bridge as model_bridge
    monkeypatch.setattr(model_bridge, 'resolve_llm',
                        lambda model, thinking_profile=None: endpoint)
    return endpoint


def _llm(**config_info):
    user_request = RagRequest(question='原问题', conversation_id='d-llm-edges')
    config_info.setdefault('user_request', user_request)
    return OpenAICompatLLM(context_window=4096, config_info=config_info)


def _frame(delta):
    return 'data: ' + json.dumps({'choices': [{'index': 0, 'delta': delta}]}, ensure_ascii=False)


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    monkeypatch.setitem(config.Config, 'black_list_dir', '')
    black_list_loader.sensitive_words_cache.clear()
    chat_memory.user_chat_question_cache.clear()
    yield
    black_list_loader.sensitive_words_cache.clear()
    chat_memory.user_chat_question_cache.clear()


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------

def test_strip_error_pict_marks_removes_both_marks_and_handles_none():
    # 两个标记按顺序各删一遍：'{{图*}}' 先被整段删掉，剩下的 '图*' 再删一遍
    assert _strip_error_pict_marks('前{{图*}}中图*后') == '前中后'
    assert _strip_error_pict_marks(None) == ''


def test_merge_message_keeps_content_that_already_has_thinking_markup():
    marked = '<think>推理</think>正文'
    assert _merge_message_with_reasoning(marked, '别的推理') == marked
    assert not _content_has_redacted_thinking_markup('干净文本')


def test_merge_message_wraps_reasoning_before_content():
    assert _merge_message_with_reasoning('正文', ' 推理 ') == '<think>推理</think>正文'
    assert _merge_message_with_reasoning('', '') == ''


def test_related_context_none_returns_empty_list():
    assert _related_context_from_prompt_args({'context_str': None}) == []


# ---------------------------------------------------------------------------
# stream() / _final_response()
# ---------------------------------------------------------------------------

def test_stream_rejects_output_parser():
    parser = SimpleNamespace(format=lambda s: s)
    llm = OpenAICompatLLM(context_window=4096, config_info={}, output_parser=parser)
    with pytest.raises(NotImplementedError, match='Output parser'):
        llm.stream(PromptTemplate('问 {q}'), q='题')


def test_final_response_strips_error_pict_marks():
    llm = _llm()
    body = json.loads(llm._final_response('cid-1', '答{{图*}}案图*'))
    assert body['answer'] == '答案'
    assert body['conversation_id'] == 'cid-1'
    assert body['citation'] == {}


# ---------------------------------------------------------------------------
# _chat() 的四类失败
# ---------------------------------------------------------------------------

def test_chat_without_endpoint_url_raises(monkeypatch):
    _stub_endpoint(monkeypatch, url='')
    llm = _llm()
    with pytest.raises(RagException) as err:
        llm._chat([{'role': 'user', 'content': 'x'}])
    assert err.value.get_error_tag() == GATEWAY_FAIL


def test_chat_connection_failure_is_wrapped(monkeypatch):
    _stub_endpoint(monkeypatch)
    _install_post(monkeypatch, post_raises=RuntimeError('连接被拒'))
    llm = _llm()
    with pytest.raises(RagException) as err:
        llm._chat([{'role': 'user', 'content': 'x'}])
    assert err.value.get_error_tag() == GATEWAY_FAIL


def test_chat_non_2xx_raises(monkeypatch):
    _stub_endpoint(monkeypatch)
    _install_post(monkeypatch, status_code=502)
    llm = _llm()
    with pytest.raises(RagException) as err:
        llm._chat([{'role': 'user', 'content': 'x'}])
    assert err.value.get_error_tag() == GATEWAY_FAIL


def test_chat_non_json_body_raises(monkeypatch):
    _stub_endpoint(monkeypatch)
    _install_post(monkeypatch, bad_json=True)
    llm = _llm()
    with pytest.raises(RagException) as err:
        llm._chat([{'role': 'user', 'content': 'x'}])
    assert err.value.get_error_tag() == GATEWAY_FAIL


# ---------------------------------------------------------------------------
# _chat_stream() 的同类失败
# ---------------------------------------------------------------------------

def test_stream_chat_without_endpoint_url_raises(monkeypatch):
    _stub_endpoint(monkeypatch, url='')
    llm = _llm()
    with pytest.raises(RagException):
        list(llm._chat_stream([{'role': 'user', 'content': 'x'}]))


def test_stream_chat_connection_failure_is_wrapped(monkeypatch):
    _stub_endpoint(monkeypatch)
    _install_post(monkeypatch, post_raises=RuntimeError('连接被拒'))
    llm = _llm()
    with pytest.raises(RagException):
        list(llm._chat_stream([{'role': 'user', 'content': 'x'}]))


# ---------------------------------------------------------------------------
# _extract_content() 的三种空内容
# ---------------------------------------------------------------------------

def test_extract_content_without_choices_raises_no_choices_tag():
    llm = _llm()
    with pytest.raises(RagException) as err:
        llm._extract_content({'choices': []})
    assert err.value.get_error_tag() == 'llm-empty-content'


def test_extract_content_reasoning_only_with_length_is_truncation():
    llm = _llm()
    payload = {'choices': [{'message': {'content': '', 'reasoning_content': '想了很久'},
                            'finish_reason': 'length'}]}
    with pytest.raises(RagException) as err:
        llm._extract_content(payload)
    assert err.value.get_error_tag() == 'llm-empty-content-truncated'


def test_extract_content_plain_empty_raises_with_finish_reason():
    llm = _llm()
    payload = {'choices': [{'message': {'content': ''}, 'finish_reason': 'stop'}]}
    with pytest.raises(RagException) as err:
        llm._extract_content(payload)
    assert err.value.get_error_tag() == 'llm-empty-content'


# ---------------------------------------------------------------------------
# generate_answer / generate_answer_stream 的兜底
# ---------------------------------------------------------------------------

def test_generate_answer_blank_content_falls_back_to_i18n_message(monkeypatch):
    _stub_endpoint(monkeypatch)
    _install_post(monkeypatch, payload={'choices': [{'message': {'content': '  '},
                                                    'finish_reason': 'stop'}]})
    llm = _llm()
    body = json.loads(llm.generate_answer('问题'))
    assert body['conversation_id'] == 'd-llm-edges'
    assert body['answer'] == FAIL_TEXT
    # 失败时不落会话历史
    assert chat_memory.get_last_question('d-llm-edges') == ''


def test_generate_answer_stream_with_broken_template_yields_failure_frame(monkeypatch):
    _stub_endpoint(monkeypatch)
    llm = _llm(no_context_prompt='坏模板 {query_str')
    deltas = list(llm.generate_answer_stream('问题'))
    assert deltas[-1] == '[DONE]'
    failure = json.loads(deltas[0])
    assert failure['output']['type'] == 'text'
    assert failure['output']['content'] == FAIL_TEXT


def test_stream_deltas_warns_when_vocabulary_declared_but_missing(monkeypatch):
    _stub_endpoint(monkeypatch)
    frames = [_frame({'content': '正文'}), 'data: [DONE]']
    _install_post(monkeypatch, stream_frames=frames)
    llm = _llm(black_vocabulary='不存在的词表')
    deltas = list(llm.generate_answer_stream('问题'))
    assert deltas[-1] == '[DONE]'
    # 声明了词表但目录里没有 → 滑窗跳过，正文原样发出
    assert json.loads(deltas[0])['output']['content'] == '正文'


def test_stream_deltas_tolerates_empty_choices_frame(monkeypatch):
    _stub_endpoint(monkeypatch)
    frames = ['data: ' + json.dumps({'choices': []}), _frame({'content': '正文'}), 'data: [DONE]']
    _install_post(monkeypatch, stream_frames=frames)
    llm = _llm()
    deltas = list(llm.generate_answer_stream('问题'))
    contents = [json.loads(d)['output']['content'] for d in deltas if d != '[DONE]']
    assert '正文' in contents


# ---------------------------------------------------------------------------
# 会话历史 / 生成参数 / 消息组装
# ---------------------------------------------------------------------------

def test_save_chat_history_without_conversation_id_is_noop():
    llm = _llm()
    llm._save_chat_history('q', 'a', '')
    assert chat_memory.get_chat_history('d-llm-edges') is None


def test_save_chat_history_failure_is_swallowed(monkeypatch):
    llm = _llm()
    monkeypatch.setattr(chat_memory, 'save_chat_history',
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError('磁盘满了')))
    llm._save_chat_history('q', 'a', 'd-llm-edges')     # 不抛
    assert chat_memory.get_chat_history('d-llm-edges') is None


def test_max_tokens_bad_config_falls_back_to_deploy_default(monkeypatch):
    monkeypatch.setitem(config.Config, 'generation_max_tokens', 512)
    llm = _llm(max_token='不是数字')
    assert llm._max_tokens() == 512


def test_temperature_bad_config_falls_back_to_floor():
    llm = _llm(temperature='不是数字')
    assert llm._temperature() == 0.01


def test_messages_includes_system_prompt_when_configured():
    llm = _llm(system_prompt='你是助手')
    messages = llm._messages('问题', {})
    assert messages == [{'role': 'system', 'content': '你是助手'},
                        {'role': 'user', 'content': '问题'}]
    assert _llm()._messages('问题', {}) == [{'role': 'user', 'content': '问题'}]
