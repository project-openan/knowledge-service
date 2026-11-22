"""Shared fixtures for backend unit tests."""

import os
import sys
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = SERVICE_ROOT / 'src'
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from shared.prefixes import RKB_PREFIX as KB_SERVICE_PREFIX  # noqa: E402  (须在 sys.path 处理之后)

# 单测直接安装存储级联服务，无需启动应用。
from knowledge_base import graph_bridge  # noqa: E402
from graph.service import lifecycle as _graph_lifecycle  # noqa: E402

graph_bridge.install(_graph_lifecycle)

# 前缀**从单一来源导入**，不在这里复制字面量。
assert KB_SERVICE_PREFIX.startswith('/api/')


@pytest.fixture(autouse=True, scope='session')
def _test_secret_key():
    """固定测试密钥环境变量，避免用例在数据目录下生成真实密钥文件。"""
    os.environ.setdefault('RKB_SECRET_KEY', 'unit-test-only-secret-key')
    yield


@pytest.fixture(autouse=True)
def _disable_query_trace(monkeypatch):
    """默认关闭 trace 入库：TestClient 会执行 background，不能让它连真实 DB。"""
    monkeypatch.setenv('RKB_QUERY_TRACE_ENABLED', 'false')
    yield
