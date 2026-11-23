"""``sandbox_runtime`` 的环境白名单与装配逻辑测试（进程内单元，不起沙箱）。

沙箱端到端见 ``tests/test_ingestion_self_operator.py``；这里钉的是：

1. forkserver 预载配置幂等、且不含 ``__main__``；
2. ``ensure_import_root`` 把 ``src/`` 放上 ``sys.path``（幂等）；
3. 环境变量白名单：运维逃生口 > 拒绝前缀 > 保留前缀 > 基础白名单；
4. ``sanitize_environment`` 返回被剔除的名字清单。
"""

import os
import sys

from ingestion.utility import sandbox_runtime


def test_configure_multiprocessing_is_idempotent(monkeypatch):
    sandbox_runtime._configured = False
    calls = []
    monkeypatch.setattr(sandbox_runtime.multiprocessing, 'set_forkserver_preload',
                        lambda modules: calls.append(list(modules)))
    sandbox_runtime.configure_multiprocessing()
    sandbox_runtime.configure_multiprocessing()
    assert calls == [list(sandbox_runtime.PRELOAD_MODULES)]
    assert sandbox_runtime._configured is True


def test_sandbox_context_returns_forkserver():
    assert sandbox_runtime.sandbox_context().get_start_method() == 'forkserver'


def test_ensure_import_root_appends_src_once():
    expected_root = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(sandbox_runtime.__file__))))
    sandbox_runtime._import_root_ready = False
    snapshot = list(sys.path)
    try:
        if expected_root in sys.path:
            sys.path.remove(expected_root)
        sandbox_runtime.ensure_import_root()
        assert sys.path[-1] == expected_root
        appended = len([p for p in sys.path if p == expected_root])
        sandbox_runtime.ensure_import_root()
        assert len([p for p in sys.path if p == expected_root]) == appended
    finally:
        while expected_root in sys.path:
            sys.path.remove(expected_root)
        sys.path.extend(snapshot)
        sandbox_runtime._import_root_ready = True


def test_ensure_import_root_is_noop_when_ready():
    sandbox_runtime._import_root_ready = True
    snapshot = list(sys.path)
    sandbox_runtime.ensure_import_root()
    assert sys.path == snapshot


# ---------------------------------------------------------------------------
# 环境变量白名单
# ---------------------------------------------------------------------------

def test_env_allowlist_parses_comma_list(monkeypatch):
    monkeypatch.setenv('OPERATOR_ENV_ALLOWLIST', ' MY_TICKET , ,OTHER')
    assert sandbox_runtime._env_allowlist() == {'MY_TICKET', 'OTHER'}
    monkeypatch.delenv('OPERATOR_ENV_ALLOWLIST')
    assert sandbox_runtime._env_allowlist() == set()


def test_allowlist_escalates_over_deny_prefix(monkeypatch):
    monkeypatch.setenv('OPERATOR_ENV_ALLOWLIST', 'RKB_DB_PASSWORD')
    assert sandbox_runtime._is_allowed('RKB_DB_PASSWORD') is True


def test_deny_prefixes_block_data_side_credentials(monkeypatch):
    monkeypatch.delenv('OPERATOR_ENV_ALLOWLIST', raising=False)
    for name in ('RKB_DB_PASSWORD', 'RKB_ES_URL', 'RKB_SECRET_KEY', 'RKB_ADMIN_USER',
                 'RKB_AGENT_KEY_PEPPER', 'POSTGRES_USER', 'DB_HOST', 'AUTH_MODE'):
        assert sandbox_runtime._is_allowed(name) is False, name


def test_keep_prefixes_and_basic_env(monkeypatch):
    monkeypatch.delenv('OPERATOR_ENV_ALLOWLIST', raising=False)
    for name in ('MODEL_GATEWAY_URL', 'MODEL_GATEWAY_API_KEY', 'EMBEDDING_MODEL',
                 'GENERATION_ENDPOINT', 'RKB_RERANK_URL', 'OPERATOR_MEMORY_LIMIT_MB',
                 'PATH', 'HOME', 'LANG', 'OPENBLAS_NUM_THREADS', 'PYTHONHASHSEED'):
        assert sandbox_runtime._is_allowed(name) is True, name
    assert sandbox_runtime._is_allowed('SOME_RANDOM_VAR') is False


def test_sanitize_environment_returns_removed_names(monkeypatch):
    monkeypatch.setattr(os, 'environ', {
        'PATH': '/usr/bin',
        'RKB_DB_PASSWORD': 'x',
        'POSTGRES_HOST': 'db',
        'MODEL_GATEWAY_URL': 'http://gw',
        'MYSTERY_VAR': 'y',
        'OPERATOR_ENV_ALLOWLIST': 'SAVED_TICKET',
        'SAVED_TICKET': 'z',
    })
    removed = sandbox_runtime.sanitize_environment()
    assert sorted(removed) == ['MYSTERY_VAR', 'POSTGRES_HOST', 'RKB_DB_PASSWORD']
    assert os.environ['MODEL_GATEWAY_URL'] == 'http://gw'
    assert os.environ['SAVED_TICKET'] == 'z'
    assert 'RKB_DB_PASSWORD' not in os.environ
