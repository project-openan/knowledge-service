"""外部重排模型算子：编排方法的全链路直测
（`post_retriever/external_model_reranker.py` 的类方法部分）。

`test_external_model_reranker_helpers.py` 已钉住三个纯函数（`_remove_overlap` /
`_extract_text_content` / `_merge_chunk_texts`）与 `_invoke_rerank` 的模型选择；
本文件补剩下的编排面，rerank 服务一律打桩（monkeypatch `_invoke_rerank`）：

  * `_extract_clean_source` / `_build_copilot_text` / `_get_node_by_content` 三个小助手；
  * `_postprocess_nodes` 的入口校验与 copilot/标准双路分发；
  * 标准路径：top_n 截断 → 按 source 分组（related_ids 并集）→ 备份 chunk 关联 →
    合并成单文档节点（引用壳、`Document：source` 头、score=1.0、base_name 透传）；
  * copilot 路径：`source:text` 组合文本匹配 + 未命中过滤；
  * 排序兜底：order 不可解析按 9999 稳定排序。
"""
from engine.common import const
from engine.post_retriever.external_model_reranker import (
    ExternalModelReranker,
    _build_copilot_text,
    _extract_clean_source,
    _get_node_by_content,
)
from engine.primitives.models import QueryBundle, TextNode
from engine.retriever import RagNodeWithScore

BUNDLE = QueryBundle('问题')


def _node(text, source='doc1.pdf', base_name='kb1', chunk_id=None,
          chunk_order=None, related=None):
    metadata = {'source': f'{const.source_format}{source}{const.source_format}'}
    if chunk_id is not None:
        metadata['chunk_id'] = chunk_id
    if chunk_order is not None:
        metadata['chunk_order'] = chunk_order
    if related is not None:
        metadata['related_chunk_ids'] = related
    wrapped = f'{const.expand_format}{text}{const.expand_format}'
    return RagNodeWithScore(node=TextNode(text=wrapped, metadata=metadata),
                            score=1.0, base_name=base_name)


def _text(node):
    from engine.post_retriever.external_model_reranker import _extract_text_content
    return _extract_text_content(node)


# ==========================================================================
# 小助手
# ==========================================================================

def test_extract_clean_source_strips_wrapper_and_extension():
    node = _node('正文', source='手册 v2.pdf')
    assert _extract_clean_source(node) == '手册 v2'


def test_build_copilot_text_prefers_source_prefix_and_falls_back_to_text():
    with_source = _node('正文', source='doc1.pdf')
    without_source = _node('正文', source='')
    assert _build_copilot_text(with_source) == 'doc1:正文'
    assert _build_copilot_text(without_source) == '正文'


def test_get_node_by_content_matches_both_modes():
    nodes = [_node('甲'), _node('乙', source='doc2.pdf')]
    assert _get_node_by_content(nodes, '甲') is nodes[0]
    assert _get_node_by_content(nodes, 'doc2:乙', for_nia_copilot=True) is nodes[1]
    assert _get_node_by_content(nodes, '不存在') is None
    assert _get_node_by_content(nodes, '不存在', for_nia_copilot=True) is None


# ==========================================================================
# 入口
# ==========================================================================

def test_postprocess_requires_query_bundle():
    reranker = ExternalModelReranker({'top_n': 3})
    import pytest
    with pytest.raises(ValueError, match='Query bundle'):
        reranker.postprocess_nodes([_node('甲')], query_bundle=None)


def test_postprocess_empty_nodes_short_circuits():
    reranker = ExternalModelReranker({'top_n': 3})
    assert reranker.postprocess_nodes([], query_bundle=BUNDLE) == []


def test_postprocess_dispatches_to_copilot_path(monkeypatch):
    reranker = ExternalModelReranker({'top_n': 1, 'for_nia_copilot': True})
    captured = {}

    def fake_invoke(query_str, texts):
        captured['texts'] = texts
        return texts[:1]

    monkeypatch.setattr(reranker, '_invoke_rerank', fake_invoke)
    nodes = [_node('甲', source='doc1.pdf'), _node('乙', source='doc2.pdf')]
    out = reranker.postprocess_nodes(nodes, query_bundle=BUNDLE)
    assert captured['texts'] == ['doc1:甲', 'doc2:乙']       # copilot 用组合文本
    assert out == [nodes[0]]


# ==========================================================================
# 标准路径：分组、合并、备份关联
# ==========================================================================

def test_standard_path_merges_selected_chunks_by_source(monkeypatch):
    reranker = ExternalModelReranker({'top_n': 2})
    n1 = _node('ABCDEFGH', chunk_id='c1', chunk_order=1, related=['c1'])
    n2 = _node('GHIJ', chunk_id='c2', chunk_order=2, related=['c2'])
    n3 = _node('别的文档', source='doc3.pdf', base_name='kb2', chunk_id='c9')
    monkeypatch.setattr(reranker, '_invoke_rerank',
                        lambda query_str, texts: [_text(n1), _text(n2), _text(n3)])

    out = reranker.postprocess_nodes([n1, n2, n3], query_bundle=BUNDLE)

    assert len(out) == 1
    merged = out[0]
    # 相邻 order 连续 → 重叠部分（GH）被去掉；头部带「Document：source」行
    # （source 键只去引用壳、不去扩展名 —— splitext 只发生在 copilot 文本里）
    assert _text(merged) == 'Document：doc1.pdf\nABCDEFGHIJ'
    assert merged.score == 1.0 and merged.base_name == 'kb1'
    assert merged.node.metadata['source'] == f'{const.source_format}doc1.pdf{const.source_format}'
    assert merged.node.text.startswith(f'{const.expand_format}Document：doc1.pdf\n')


def test_standard_path_ignores_texts_rerank_returned_without_nodes(monkeypatch):
    reranker = ExternalModelReranker({'top_n': 3})
    n1 = _node('甲')
    monkeypatch.setattr(reranker, '_invoke_rerank', lambda query_str, texts: ['幽灵文本'])
    assert reranker.postprocess_nodes([n1], query_bundle=BUNDLE) == []


def test_backup_chunk_joins_when_its_id_is_related(monkeypatch):
    reranker = ExternalModelReranker({'top_n': 1})
    selected = _node('主块', chunk_id='c1', chunk_order=1, related=['c2', 'c3'])
    backup = _node('关联块', chunk_id='c2', chunk_order=2)
    stranger = _node('无关块', chunk_id='c8', chunk_order=3)
    monkeypatch.setattr(reranker, '_invoke_rerank',
                        lambda query_str, texts: [_text(selected), _text(backup),
                                                  _text(stranger)])
    out = reranker.postprocess_nodes([selected, backup, stranger], query_bundle=BUNDLE)
    assert len(out) == 1
    merged_text = _text(out[0])
    assert '主块' in merged_text and '关联块' in merged_text
    assert '无关块' not in merged_text        # chunk_id 不在 related_ids → 不合并


def test_backup_from_unselected_source_is_dropped(monkeypatch):
    reranker = ExternalModelReranker({'top_n': 1})
    selected = _node('主块', chunk_id='c1', chunk_order=1, related=['c2'])
    backup = _node('别家块', source='doc9.pdf', chunk_id='c2', chunk_order=2)
    monkeypatch.setattr(reranker, '_invoke_rerank',
                        lambda query_str, texts: [_text(selected), _text(backup)])
    out = reranker.postprocess_nodes([selected, backup], query_bundle=BUNDLE)
    assert len(out) == 1
    assert '别家块' not in _text(out[0])


def test_backup_text_that_matches_no_node_is_ignored(monkeypatch):
    reranker = ExternalModelReranker({'top_n': 1})
    selected = _node('主块', chunk_id='c1', chunk_order=1, related=['c2'])
    monkeypatch.setattr(reranker, '_invoke_rerank',
                        lambda query_str, texts: [_text(selected), '幽灵备份'])
    out = reranker.postprocess_nodes([selected], query_bundle=BUNDLE)
    assert len(out) == 1
    assert '幽灵备份' not in _text(out[0])


def test_merge_orders_that_cannot_be_parsed_are_sorted_last(monkeypatch):
    reranker = ExternalModelReranker({'top_n': 2})
    first = _node('乙块', chunk_id='c1', chunk_order='坏掉')
    second = _node('甲块', chunk_id='c2', chunk_order=2)
    monkeypatch.setattr(reranker, '_invoke_rerank',
                        lambda query_str, texts: [_text(first), _text(second)])
    out = reranker.postprocess_nodes([first, second], query_bundle=BUNDLE)
    assert _text(out[0]) == 'Document：doc1.pdf\n甲块乙块'   # order=2 排在 9999 前


def test_merge_chunks_by_source_skips_sources_without_chunks():
    reranker = ExternalModelReranker({'top_n': 3})
    out = reranker._merge_chunks_by_source(
        {'doc1': 'kb1', 'doc2': 'kb2'},
        {'doc1': {'chunks': []}, 'doc2': {'chunks': [{'text': '内容', 'order': 1}]}},
    )
    assert [n.base_name for n in out] == ['kb2']


# ==========================================================================
# 装配
# ==========================================================================

def test_from_args_returns_reranker_with_config():
    reranker = ExternalModelReranker.from_args({'top_n': 5})
    assert isinstance(reranker, ExternalModelReranker)
    assert reranker.config_info == {'top_n': 5}
