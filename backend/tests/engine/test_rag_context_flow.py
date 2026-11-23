"""RagContext 的编排配置装配（`context/rag_context.py`）。

钉住三件事：

* 画布快照 → 四段算子配置（pre/retriever/post/synthesizer）的装配与
  ``base_names`` 注入（引用名写进 generator-config / knowledge_info_list）；
* default workflow 的两条环境回落：环境 LLM 名、环境知识库表名；
* workflow 图的两个遍历（BFS 取节点、链式扫描取链）与 query-engine 校验。

provider 是模块级全局：所有用例结束后恢复原值，别污染别的测试。
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from engine.common import const
from engine.common.beans.rag_request import RagRequest
from engine.common.beans.rag_request_headers import RagRequestHeaders
from engine.common.exception.rag_exception import RagException
from engine.context import rag_context as rc
from engine.context.rag_context import RagContext

DEFAULT_WF = const.default_workflow_id


@pytest.fixture(autouse=True)
def _restore_provider():
    """provider 是进程级全局，用完必须还原。"""
    old = rc._workflow_config_provider
    yield
    rc.set_workflow_config_provider(old)


def _workflow_config(**overrides):
    config = {
        'workflow_id': 'wf-canvas-1',
        'query-engine': {'operator': 'SequentialQueryEngine',
                         'package': 'core.rag.query_engine.sequential_query_engine'},
        'pre-retriever': [{'id': 'rewrite', 'operator': 'LLMQueryRewriter', 'kwargs': {}}],
        'retriever': [
            {'id': 'vec', 'operator': 'VectorRetriever',
             'kwargs': {'knowledge_info_list': [{'knowledge_base_name': ['画布原库']}, {'x': 1}]}},
            {'id': 'kw', 'operator': 'KeywordRetriever', 'kwargs': {'knowledge_base_name': ['画布原库']}},
        ],
        'post-retriever': [{'id': 'rerank', 'operator': 'LLMReranker', 'kwargs': {}}],
        'response-synthesizer': [{'id': 'gen', 'operator': 'RagSimpleSummarizer',
                                  'kwargs': {'generator-config': [{'llm': 'canvas-llm'}]}}],
        'workflow': {'edges': [['rewrite', 'vec'], ['vec', 'rerank'], ['rerank', 'gen']]},
    }
    config.update(overrides)
    return config


def _request(**overrides):
    # ⚠️ RagRequest 的 workflow_id 默认就是 const.default_workflow_id——那会触发
    # 「环境回落」分支并打真实网关；普通用例显式给一个画布 id。
    params = dict(question='问题', conversation_id='conv-abc', workflow_id='wf-req-1', kwargs={})
    params.update(overrides)
    return RagRequest(**params)


def _context(monkeypatch, config, request=None, *, env_llm=None, env_bases=None):
    if env_llm is not None:
        monkeypatch.setattr(rc, 'llm_proxy_client',
                            SimpleNamespace(invoke_query_llm_info=lambda: env_llm))
    if env_bases is not None:
        monkeypatch.setattr(rc, 'invoke_list_vector_knowledge_bases', lambda: env_bases)
    return RagContext(request or _request(), RagRequestHeaders(),
                      workflow_config_provider=lambda workflow_id, scope: config)


# ---------------------------------------------------------------------------
# provider 缺失 / base_names 注入
# ---------------------------------------------------------------------------
def test_missing_provider_raises_runtime_error(monkeypatch):
    monkeypatch.setattr(rc, '_workflow_config_provider', None)
    with pytest.raises(RuntimeError, match='workflow config provider'):
        RagContext(_request(), RagRequestHeaders())


def test_base_names_are_injected_into_synthesizer_config(monkeypatch):
    config = _workflow_config()
    context = _context(monkeypatch, config, _request(kwargs={'base_names': ['kb-a', 'kb-b']}))

    generator_config = context.response_synthesizer_config[0]['kwargs']['generator-config'][0]
    assert generator_config['knowledge_base_name'] == ['kb-a', 'kb-b']
    # 其余段原样保留
    assert context.pre_retrieval_config == config['pre-retriever']
    assert context.post_retrieval_config == config['post-retriever']
    # get_operators 是四段的顺序拼接（装配顺序契约）
    assert context.get_operators() == (config['pre-retriever'] + config['retriever']
                                       + config['post-retriever'] + config['response-synthesizer'])


# ---------------------------------------------------------------------------
# workflow 图遍历
# ---------------------------------------------------------------------------
def test_workflow_without_entry_node_yields_no_nodes(monkeypatch):
    context = _context(monkeypatch, _workflow_config(workflow={'edges': []}))
    assert context.get_workflow_nodes() == []


def test_bfs_survives_cycles(monkeypatch):
    # b/c 成环，a 是唯一入度为 0 的入口
    edges = [['a', 'b'], ['b', 'c'], ['c', 'b']]
    context = _context(monkeypatch, _workflow_config(workflow={'edges': edges}))
    # 返回值是 visited 集合的 list（顺序不保证），只看成员
    assert sorted(context.get_workflow_nodes()) == ['a', 'b', 'c']


def test_bfs_dedupes_diamond_fan_in(monkeypatch):
    # d 被两条路先后入队：第二次出队时已访问 → 走 continue（78 行）
    edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]
    context = _context(monkeypatch, _workflow_config(workflow={'edges': edges}))
    assert sorted(context.get_workflow_nodes()) == ['a', 'b', 'c', 'd']


def test_chain_scan_follows_every_reachable_node(monkeypatch):
    edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['d', 'a']]
    context = _context(monkeypatch, _workflow_config(workflow={'edges': edges}))
    assert context.get_chain_all_nodes('a') == ['b', 'd', 'a', 'c']
    assert context.get_chain_all_nodes('c') == []
    # 无出度的终点返回空链
    assert context.get_chain_all_nodes('missing') == []


# ---------------------------------------------------------------------------
# default workflow 的环境回落
# ---------------------------------------------------------------------------
def test_default_workflow_injects_environment_llm(monkeypatch):
    config = _workflow_config()
    context = _context(monkeypatch, config, _request(workflow_id=DEFAULT_WF), env_llm='env-llm-7b')

    assert context.pre_retrieval_config[0]['kwargs']['llm'] == 'env-llm-7b'
    generator_config = context.response_synthesizer_config[0]['kwargs']['generator-config'][0]
    assert generator_config['llm'] == 'env-llm-7b'


def test_default_workflow_resolves_environment_bases(monkeypatch):
    """画布用 default workflow 且没带 base_names：库表名由环境接口补齐。"""
    config = _workflow_config(workflow_id=DEFAULT_WF)
    context = _context(monkeypatch, config, _request(workflow_id='wf-canvas-1'),
                       env_bases=['tbl-a', 'tbl-b'])

    vec_kwargs = context.retrieval_config[0]['kwargs']
    assert vec_kwargs['knowledge_info_list'][0]['knowledge_base_name'] == ['tbl-a', 'tbl-b']
    # 第二条 knowledge_info 被丢弃（只保留第一条注入后的形状）
    assert len(vec_kwargs['knowledge_info_list']) == 1
    assert context.retrieval_config[1]['kwargs']['knowledge_base_name'] == ['tbl-a', 'tbl-b']
    generator_config = context.response_synthesizer_config[0]['kwargs']['generator-config'][0]
    assert generator_config['knowledge_base_name'] == ['tbl-a', 'tbl-b']


# ---------------------------------------------------------------------------
# SqlRetriever 死分支与 pre-retriever llm
# ---------------------------------------------------------------------------
def test_sql_retriever_receives_fallback_llm(monkeypatch):
    config = _workflow_config(
        **{'pre-retriever': [{'id': 'rewrite', 'operator': 'LLMQueryRewriter',
                              'kwargs': {'llm': 'rewrite-llm'}}],
           'retriever': [{'id': 'sql', 'operator': 'SqlRetriever', 'kwargs': {}}]},
    )
    context = _context(monkeypatch, config)

    sql_kwargs = context.retrieval_config[0]['kwargs']
    assert sql_kwargs['fallback_llm'] == 'rewrite-llm'


def test_pre_retriever_without_llm_yields_no_fallback(monkeypatch):
    config = _workflow_config(
        retriever=[{'id': 'sql', 'operator': 'SqlRetriever', 'kwargs': {}}],
    )
    context = _context(monkeypatch, config)

    assert context._get_pre_retriever_llm() is None
    assert 'fallback_llm' not in context.retrieval_config[0]['kwargs']


# ---------------------------------------------------------------------------
# query-engine 校验
# ---------------------------------------------------------------------------
def test_unsupported_query_engine_with_bases_is_rejected(monkeypatch):
    config = _workflow_config(**{'query-engine': {'operator': 'ConditionalQueryEngine'}})
    with pytest.raises(RagException) as exc:
        _context(monkeypatch, config, _request(kwargs={'base_names': ['kb-a']}))
    assert exc.value.get_error_tag() == 'only-support-sequential-hybrid'
    assert exc.value.get_error_code() == -1


def test_missing_operator_is_rejected_too(monkeypatch):
    # 画布漏配 query-engine operator：同样按不支持拒绝
    config = _workflow_config(**{'query-engine': {}})
    with pytest.raises(RagException) as exc:
        _context(monkeypatch, config, _request(kwargs={'base_names': ['kb-a']}))
    assert exc.value.get_error_tag() == 'only-support-sequential-hybrid'
