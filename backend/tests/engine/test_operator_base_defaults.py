"""vendored 算子基类的默认实现（`retriever/base.py`、`post_retriever/base.py`）。

两个基类都只保留「默认行为 + 抽象 `from_args`」：
  * `BaseRagRetriever._retrieve` 默认 `pass`（返回 None）—— 没有检索逻辑的占位算子
    用它兜底，子类不必实现；
  * `BaseRagPostRetriever._postprocess_nodes` 默认**原样返回节点列表**（不过滤）。
"""
from engine.post_retriever.base import BaseRagPostRetriever
from engine.primitives.models import Node, NodeWithScore, QueryBundle
from engine.retriever.base import BaseRagRetriever


class _NoopRetriever(BaseRagRetriever):
    @classmethod
    def from_args(cls, config_dict):
        return cls()


class _PassthroughPostRetriever(BaseRagPostRetriever):
    @classmethod
    def from_args(cls, config_dict):
        return cls()


def test_base_retriever_default_retrieve_returns_none():
    assert _NoopRetriever().retrieve(QueryBundle('q')) is None


def test_base_post_retriever_default_passes_nodes_through():
    nodes = [NodeWithScore(node=Node(text='甲'), score=1.0)]
    assert _PassthroughPostRetriever().postprocess_nodes(nodes, query_bundle=QueryBundle('q')) is nodes
