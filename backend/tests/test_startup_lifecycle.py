"""服务启动装配（``startup.py``）与入口（``main.py``）的生命周期测试。

为什么要专门测：``start_background`` 在真实服务里只跑一次，但踩空了就是
「沙箱子进程各起一份语料队列消费者」或「新装库建不出默认算子」这类隐蔽故障。
所有副作用（admin 播种、算子播种、存储后端、任务队列）都用桩替换 ——
**测试绝不真启动后台任务，也不连库**。

``main.py`` 的 ``__main__`` 块不执行（uvicorn 会被真正拉起来），只验模块级
配置与「导入期不导入 app」这一纪律。

跑法（服务目录下）::

    python -m pytest tests/test_startup_lifecycle.py -q
"""

import asyncio

import pytest

import startup
from auth import bootstrap as auth_bootstrap
from auth import service as auth_service
from auth.middleware import AuthMiddleware
from infrastructure.storage import backend as storage_backend_module
from knowledge_base.task import runtime as kb_task_runtime
from operators import bootstrap as operator_bootstrap


@pytest.fixture(autouse=True)
def fresh_startup_state(monkeypatch):
    """每个用例都从「未启动」开始（``_started`` 是模块级全局）。"""
    monkeypatch.setattr(startup, '_started', False)


@pytest.fixture(autouse=True)
def stubbed_dependencies(monkeypatch, tmp_path):
    """把启动期的所有副作用换成桩，并记录调用。"""
    calls = {}

    monkeypatch.setattr(AuthMiddleware, 'filterfree', [])
    monkeypatch.setattr(AuthMiddleware, 'set_log_path',
                        classmethod(lambda cls, path: calls.setdefault('log_path', path)))
    monkeypatch.setattr(auth_service, 'validate_auth_mode', lambda: 'none')
    monkeypatch.setattr(auth_bootstrap, 'ensure_initial_admin',
                        lambda: calls.setdefault('admin_seeded', True))
    monkeypatch.setattr(operator_bootstrap, 'ensure_default_operators',
                        lambda: calls.setdefault('operators_seeded', True))
    monkeypatch.setattr(storage_backend_module, 'backend_name', lambda: 'local')
    monkeypatch.setattr(storage_backend_module, 'storage_backend',
                        lambda: calls.setdefault('storage_built', True))
    # 任务队列不启动（RKB_TASK_QUEUE_DB=0 由 conftest 全局兜底；这里再显式桩掉）
    monkeypatch.setattr(kb_task_runtime, 'start',
                        lambda: calls.setdefault('kb_queue', True))
    monkeypatch.setattr(kb_task_runtime, 'shutdown',
                        lambda: calls.setdefault('kb_shutdown', True))
    from graph import task_runtime as graph_task_runtime

    monkeypatch.setattr(graph_task_runtime, 'start',
                        lambda: calls.setdefault('graph_queue', True))
    monkeypatch.setattr(graph_task_runtime, 'shutdown',
                        lambda: calls.setdefault('graph_shutdown', True))
    return calls


def test_start_background_wires_auth_storage_and_seeds_defaults(stubbed_dependencies,
                                                                monkeypatch, tmp_path):
    monkeypatch.setenv('LOG_DIR', str(tmp_path / 'logs'))

    startup.start_background()

    assert startup._started is True
    # 内置公开路径写死在中间件里；filterfree 只是运维白名单，保持为空
    assert AuthMiddleware.filterfree == []
    assert stubbed_dependencies['log_path'] == str(tmp_path / 'logs')
    assert stubbed_dependencies['admin_seeded']
    assert stubbed_dependencies['operators_seeded']
    assert stubbed_dependencies['storage_built']
    # 队列默认关闭（RKB_TASK_QUEUE_DB=0）→ start 不该被调
    assert 'kb_queue' not in stubbed_dependencies
    assert 'graph_queue' not in stubbed_dependencies


def test_start_background_is_idempotent(stubbed_dependencies, caplog):
    """第二次调用必须被忽略：lifespan 可能被热重载重复触发。"""
    caplog.set_level('WARNING')

    startup.start_background()
    startup.start_background()

    assert 'start_background 已被调用过' in caplog.text
    # 播种只发生一次
    assert len([k for k in stubbed_dependencies if k == 'admin_seeded']) == 1


def test_start_background_starts_task_queues_when_db_lane_enabled(stubbed_dependencies,
                                                                  monkeypatch):
    """``RKB_TASK_QUEUE_DB`` 打开时启动即认领库里的 PENDING/RETRY 任务。"""
    monkeypatch.setenv('RKB_TASK_QUEUE_DB', '1')

    startup.start_background()

    assert stubbed_dependencies['kb_queue']
    assert stubbed_dependencies['graph_queue']


def test_stop_background_shuts_down_both_runtimes(stubbed_dependencies):
    startup.start_background()

    startup.stop_background()

    assert stubbed_dependencies['kb_shutdown']
    assert stubbed_dependencies['graph_shutdown']
    assert startup._started is False


def test_build_lifespan_starts_on_enter_and_stops_on_exit(stubbed_dependencies):
    async def drive():
        async with startup.build_lifespan(object()):
            assert startup._started is True
        assert startup._started is False

    asyncio.run(drive())
    assert stubbed_dependencies['kb_shutdown']


def test_build_lifespan_stops_even_when_app_body_raises(stubbed_dependencies):
    """``finally`` 保证退出路径：应用启动中途抛错也要停掉已起的后台任务。"""
    async def drive():
        async with startup.build_lifespan(object()):
            raise RuntimeError('boom during app lifetime')

    with pytest.raises(RuntimeError):
        asyncio.run(drive())

    assert startup._started is False
    assert stubbed_dependencies['kb_shutdown']


# ----------------------------------------------------------------------
# 入口 main.py
# ----------------------------------------------------------------------


def test_main_module_defaults(monkeypatch):
    import importlib

    import main

    monkeypatch.delenv('KNOWLEDGE_BASE_HOST', raising=False)
    monkeypatch.delenv('KNOWLEDGE_BASE_PORT', raising=False)
    reloaded = importlib.reload(main)
    assert reloaded.HOST == '0.0.0.0'            # 容器内必须绑 0.0.0.0
    assert reloaded.PORT == 8091

    monkeypatch.setenv('KNOWLEDGE_BASE_HOST', '127.0.0.1')
    monkeypatch.setenv('KNOWLEDGE_BASE_PORT', '9000')
    reloaded = importlib.reload(main)
    assert (reloaded.HOST, reloaded.PORT) == ('127.0.0.1', 9000)


def test_main_import_does_not_pull_the_app_or_start_uvicorn():
    """顶层 ``import app`` 会让每个沙箱子进程都重建一遍 FastAPI 应用 ——
    这是 ``main.py`` 模块 docstring 里用 ``__main__`` 守卫挡掉的崩溃路径。
    所以导入 ``main`` 之后，模块命名空间里**不能**出现 app/uvicorn。"""
    import main

    assert not hasattr(main, 'app')
    assert 'uvicorn' not in vars(main)
