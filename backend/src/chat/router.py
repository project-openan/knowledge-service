"""编排路由的装配入口。

本模块把编排的 ``POST <prefix>/query`` 挂到宿主应用上；前缀由宿主决定
（当前是 ``shared.prefixes.RKB_PREFIX``）。``stream=true`` 时以 SSE 返回。

健康检查统一由 kb_api 的 ``GET <prefix>/health`` 提供。

生产装配里本路由器经 ``http_api.build_router`` 纳入统一注册序列（catch-all
之前），不再有"被兜底路由吃掉"的顺序坑；独立宿主仍可用 ``register_query_api``
自行挂载（那时才需要保证它先于宿主的兜底路由）。
"""

from __future__ import annotations

from fastapi import APIRouter, FastAPI

from shared.prefixes import RKB_PREFIX
from chat.app import router as query_router
from chat.trace_api import router as trace_router

#: 本服务的对外前缀（宿主的单点常量）。
#: 单测据此按**生产同形的路径**发请求 —— 不要打根路径，生产并没有根路径。
DEFAULT_PREFIX = RKB_PREFIX


def build_query_routers() -> list[APIRouter]:
    """返回编排的两条路由器（路径相对，由宿主决定挂载前缀）。

    供 :func:`http_api.build_router` 纳入统一注册序列（catch-all 之前），
    也可经 :func:`register_query_api` 挂到独立宿主上。
    """
    return [query_router, trace_router]


def register_query_api(app: FastAPI, prefix: str) -> None:
    """把编排的 ``/query`` 与只读 ``/query-traces`` 挂到 ``app`` 上。"""
    for router in build_query_routers():
        app.include_router(router, prefix=prefix)
