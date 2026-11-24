"""「首次访问自建表」的公共兜底（本仓没有 alembic/flyway）。

``model/repository_pg.py``（``model_registry``）与 ``workflow/repository_pg.py``
（``flow_*`` 三表）各自负责所在表的建表兜底，逻辑同形：进程内就绪标记 +
首次到达时执行 DDL。这里只收敛「检查 → 加锁 → 执行 → 标记」的公共顺序；
两样东西仍归各 repository 所有：

* **DDL**（``SCHEMA_STATEMENTS`` / ``FLOW_SCHEMA_STATEMENTS``）是表结构的唯一来源，
  留在各自 repository（表结构随各自模块演进，改 DDL 不用过这里）；
* **就绪标记**（各模块的 ``_schema_ready`` 全局变量）也留在调用方模块 ——
  测试靠 ``monkeypatch.setattr(store_pg, '_schema_ready', False)`` 重置它
  （见 ``tests/test_flow_repository_schema.py``），标记换地方就拆了测试的地基。

两条建表路径的并发/事务语义不同，通过参数保留各自现状（不要顺手"统一"）：

* ``lock``：workflow 侧并发请求线程可能同时首查，用双检锁保证只建一次；
  model 侧维持原样（检查一次即执行，不加锁）。
* ``commit``：workflow 侧建完**立即提交** —— 外层写入可能因唯一键冲突回滚，
  DDL 跟着回滚而标记已置位，下一请求会撞「表不存在」且不再重试；
  model 侧维持原样（DDL 随外层事务一起提交）。
"""

from __future__ import annotations

import threading
from types import ModuleType
from typing import Optional, Sequence


def ensure_schema(
    conn,
    statements: Sequence[str],
    *,
    owner: ModuleType,
    flag: str = '_schema_ready',
    lock: Optional[threading.Lock] = None,
    commit: bool = True,
) -> None:
    """确保 ``statements`` 在本进程执行过一次（幂等）。

    :param owner: 就绪标记所在的模块（调用方传 ``sys.modules[__name__]``）
    :param flag: 标记变量名，默认 ``_schema_ready``
    :param lock: 双检锁；并发首查时传，None 表示沿用调用方现状（不加锁）
    :param commit: 建完是否立即提交（见模块 docstring 的两条取舍）
    """
    if getattr(owner, flag):
        return
    if lock is not None:
        with lock:
            if getattr(owner, flag):
                return
            _apply(conn, statements, owner, flag, commit)
    else:
        _apply(conn, statements, owner, flag, commit)


def _apply(conn, statements: Sequence[str], owner: ModuleType, flag: str,
           commit: bool) -> None:
    """执行 DDL 并置位标记（顺序与原两处实现逐一对应）。"""
    with conn.cursor() as cursor:
        for statement in statements:
            cursor.execute(statement)
    if commit:
        conn.commit()
    setattr(owner, flag, True)
