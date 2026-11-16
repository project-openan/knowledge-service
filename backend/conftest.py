"""Global pytest fixtures and an optional import guard for llama_index."""
from __future__ import annotations

import os
import sys
from importlib.abc import MetaPathFinder

import pytest

_TRUTHY = {'1', 'true', 'yes', 'on'}
_REMOVED_PACKAGE = 'llama_index'


class _RemovedLibBlocker(MetaPathFinder):
    """命中已移除的包（及其子模块）即抛 ModuleNotFoundError（信息里点名开关）。"""

    def find_spec(self, fullname, path=None, target=None):  # noqa: ANN001
        if fullname == _REMOVED_PACKAGE or fullname.startswith(_REMOVED_PACKAGE + '.'):
            raise ModuleNotFoundError(
                f'RAG_FORBID_REMOVED_LIB=1：禁止 import {fullname} —— '
                '测试环境禁止依赖该第三方库'
            )
        return None


def _install_blocker() -> None:
    if os.environ.get('RAG_FORBID_REMOVED_LIB', '').strip().lower() not in _TRUTHY:
        return
    if any(isinstance(f, _RemovedLibBlocker) for f in sys.meta_path):
        return
    sys.meta_path.insert(0, _RemovedLibBlocker())


_install_blocker()


@pytest.fixture(autouse=True)
def _default_auth_mode_none(monkeypatch):
    """单测默认按 ``AUTH_MODE=none`` 跑（鉴权用例自己显式设置）。

    生产默认值是 ``local``；单测若全部继承 ``local``，大量与鉴权无关的用例会被
    401 挡住，反而掩盖真正的回归。这里只在环境未显式设置时兜底。
    """
    if 'AUTH_MODE' not in os.environ:
        monkeypatch.setenv('AUTH_MODE', 'none')
