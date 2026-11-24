"""检索网关适配器的传输契约补齐（`gateways/knowledge_base_client.py`）。

`test_kb_adapter.py` 已钉住正常转换链（引用标记、排序、去重）；本文件补
**错误与信封分支**，transport 一律打桩（monkeypatch 模块级 `_transport`，
monkeypatch 会自动还原，不会泄漏到别的用例）：

  * `_get_transport` 未注入时的显式 RuntimeError；
  * 检索接口：payload 非 list、transport 抛非业务异常 → 统一包成
    `RagException(-2, 'request-knowledgebase-failed')`；
  * 图谱接口：payload 非 dict、泛化异常 → `request-knowledge-graph-failed`；
  * 知识库列表：tableName 提取 / 非 2xx / 非 list / 无可用库 / 泛化异常。
"""
from types import SimpleNamespace

import pytest

from engine.common.exception.rag_exception import RagException
from engine.gateways import knowledge_base_client as kb

HEADERS = {'X-Emp-No': 'tester'}


def _response(payload, status_code=200):
    return SimpleNamespace(status_code=status_code, json=lambda: payload)


class _Transport:
    """按需返回响应或抛异常的最小 transport 桩。"""

    def __init__(self, retrieve=None, graph=None, kbase=None):
        self._retrieve, self._graph, self._kbase = retrieve, graph, kbase

    def post_retrieve(self, body, headers):
        if isinstance(self._retrieve, Exception):
            raise self._retrieve
        return self._retrieve

    def post_graph_retrieve(self, body, headers):
        if isinstance(self._graph, Exception):
            raise self._graph
        return self._graph

    def get_kbase_list(self):
        if isinstance(self._kbase, Exception):
            raise self._kbase
        return self._kbase


def _install(monkeypatch, transport):
    monkeypatch.setattr(kb, '_transport', transport)
    return transport


# ---------------------------------------------------------------------------
# transport 未注入
# ---------------------------------------------------------------------------

def test_get_transport_without_injection_raises_runtime_error(monkeypatch):
    monkeypatch.setattr(kb, '_transport', None)
    with pytest.raises(RuntimeError, match='transport is not configured'):
        kb._get_transport()


# ---------------------------------------------------------------------------
# 检索接口的错误信封
# ---------------------------------------------------------------------------

def test_retrieve_with_non_list_payload_is_rejected(monkeypatch):
    _install(monkeypatch, _Transport(retrieve=_response({'unexpected': 'shape'})))
    with pytest.raises(RagException) as err:
        kb.invoke_knowledge_base_client(HEADERS, {'question': 'q'})
    assert err.value.get_error_tag() == 'request-knowledgebase-failed'


def test_retrieve_wraps_unexpected_transport_errors(monkeypatch):
    _install(monkeypatch, _Transport(retrieve=KeyError('传输层炸了')))
    with pytest.raises(RagException) as err:
        kb.invoke_knowledge_base_client(HEADERS, {'question': 'q'})
    assert err.value.get_error_tag() == 'request-knowledgebase-failed'


def test_retrieve_lets_business_errors_pass_through(monkeypatch):
    _install(monkeypatch, _Transport(retrieve=_response([], status_code=500)))
    with pytest.raises(RagException) as err:
        kb.invoke_knowledge_base_client(HEADERS, {'question': 'q'})
    assert err.value.get_error_tag() == 'bad-status-code'


# ---------------------------------------------------------------------------
# 图谱接口
# ---------------------------------------------------------------------------

def test_graph_with_non_dict_payload_is_rejected(monkeypatch):
    _install(monkeypatch, _Transport(graph=_response(['不是对象'])))
    with pytest.raises(RagException) as err:
        kb.invoke_knowledge_graph_client(HEADERS, {'question': 'q'})
    assert err.value.get_error_tag() == 'request-knowledge-graph-failed'


def test_graph_wraps_unexpected_transport_errors(monkeypatch):
    _install(monkeypatch, _Transport(graph=RuntimeError('图谱挂了')))
    with pytest.raises(RagException) as err:
        kb.invoke_knowledge_graph_client(HEADERS, {'question': 'q'})
    assert err.value.get_error_tag() == 'request-knowledge-graph-failed'


def test_graph_success_returns_payload_verbatim(monkeypatch):
    payload = {'entities': [], 'chunks': []}
    _install(monkeypatch, _Transport(graph=_response(payload)))
    # 2xx 的 body 就是图数据对象，原样透传给 retriever
    assert kb.invoke_knowledge_graph_client(HEADERS, {'question': 'q'}) == payload


# ---------------------------------------------------------------------------
# 知识库列表
# ---------------------------------------------------------------------------

def test_kbase_list_extracts_table_names(monkeypatch):
    _install(monkeypatch, _Transport(
        kbase=_response([{'tableName': 'kb_a'}, {'tableName': None}, {}, {'tableName': 'kb_b'}])))
    assert kb.invoke_list_vector_knowledge_bases() == ['kb_a', 'kb_b']


def test_kbase_list_non_2xx_raises_bad_status(monkeypatch):
    _install(monkeypatch, _Transport(kbase=_response([], status_code=403)))
    with pytest.raises(RagException) as err:
        kb.invoke_list_vector_knowledge_bases()
    assert err.value.get_error_tag() == 'bad-status-code'


def test_kbase_list_non_list_payload_raises_bad_status(monkeypatch):
    _install(monkeypatch, _Transport(kbase=_response({'oops': 1})))
    with pytest.raises(RagException) as err:
        kb.invoke_list_vector_knowledge_bases()
    assert err.value.get_error_tag() == 'bad-status-code'


def test_kbase_list_without_any_table_raises_not_imported(monkeypatch):
    _install(monkeypatch, _Transport(kbase=_response([{'other': 'x'}])))
    with pytest.raises(RagException) as err:
        kb.invoke_list_vector_knowledge_bases()
    assert err.value.get_error_tag() == 'knowledgebase-not-imported'


def test_kbase_list_wraps_unexpected_errors(monkeypatch):
    _install(monkeypatch, _Transport(kbase=ValueError('列表挂了')))
    with pytest.raises(RagException) as err:
        kb.invoke_list_vector_knowledge_bases()
    assert err.value.get_error_tag() == 'request-knowledgebase-failed'


def test_select_base_size_caps_at_four_and_shrinks_in_quarters():
    assert kb._calculate_select_base_size(2) == 2
    assert kb._calculate_select_base_size(4) == 4
    assert kb._calculate_select_base_size(5) == 4
    assert kb._calculate_select_base_size(20) == 5
    assert kb._calculate_select_base_size(40) == 10
