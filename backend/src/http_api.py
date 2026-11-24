"""Composition root for the RKB HTTP surface.

Domain modules own their routes:

* :mod:`system.api` — health and deployment capability information
* :mod:`knowledge_base.api` — knowledge-base metadata and nested content
* :mod:`retrieval.api` — the retrieval endpoint
* :mod:`operators.api` — operator registry
* :mod:`graph.api` — graph schemas, extraction, import, content **and** the
  public graph-retrieve endpoint (``POST /retrieval/graph``)
* :mod:`chat.router` — the orchestrated ``POST /query`` + read-only ``/query-traces``
* :mod:`workflow.router` — the ``/flow`` and ``/workflow`` API family
* :mod:`model.router` — model registry & management (``/models``)
* :mod:`auth.api` — local-account login (``/auth/*``)

This module wires them together in one explicit registration order (route order
is part of the OpenAPI contract) and keeps the catch-all **last**.  Because every
domain router is registered here — before the catch-all, inside the same
function — hosts no longer need the historical "register before
``register_rkb_api``" discipline.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from shared.prefixes import RKB_PREFIX
from shared.errors.api import KbApiError
from infrastructure.logging.logutil import log

from auth.api import build_router as build_auth_router
from auth.api import register_auth_exception_handlers
from chat.router import build_query_routers
from model.router import build_default_router as build_default_model_router
from workflow.router import build_flow_router
from graph import api as graph_api
from graph.service import lifecycle as graph_lifecycle
from knowledge_base import api as knowledge_base_api
from knowledge_base import graph_bridge
from knowledge_base.service import kbase_service, kbase_v2_service
from retrieval.repository.kbase_lookup import set_kbase_row_provider
from workflow.bindings import workflow_ids_binding
from infrastructure.http.rkb_support import (http_exception_handler,
                                              kb_error_handler, not_found,
                                              validation_handler)
from operators import api as operators_api
from retrieval import api as retrieval_api
from system import api as system_api

#: Single external prefix for the REST surface.
KBASE_PREFIX = RKB_PREFIX


def build_router() -> APIRouter:
    """Build the RKB router without a prefix.

    Registration order mirrors the pre-split router: system, KB collection,
    retrieval, KB content, operators, graph, then the catch-all.  FastAPI
    matches in registration order and the OpenAPI generator emits paths in the
    same order, so this sequence is part of the contract.
    """
    router = APIRouter()
    router.include_router(system_api.build_router())
    router.include_router(knowledge_base_api.build_router())
    router.include_router(retrieval_api.build_router())
    router.include_router(knowledge_base_api.build_content_router())
    router.include_router(operators_api.build_router(enable_management=False))
    # 图域：kb graph 路由 + 对外图检索 POST /retrieval/graph（原 app.py 内联端点）
    router.include_router(graph_api.build_router())
    # 编排：POST /query（stream=true 走 SSE）与只读 /query-traces
    for query_router in build_query_routers():
        router.include_router(query_router)
    # 编排接口层（/flow 与 /workflow 系列），生产默认取运行时单例服务
    router.include_router(build_flow_router())
    # 模型注册与管理（{RKB_PREFIX}/models），生产默认运行时单例服务
    router.include_router(build_default_model_router())
    # 本地账号登录（{RKB_PREFIX}/auth/status|login|logout|me|password）
    router.include_router(build_auth_router())

    # Unknown paths under the prefix keep the historical problem response.
    # This route must remain last: it would otherwise swallow every later
    # registration under the same prefix.  所有域路由都在上面注册完了，这条
    # 纪律在本函数内部即可保证——app.py 不再需要"先于 register_rkb_api"的
    # 注册顺序约定。
    @router.api_route('/{unknown_path:path}',
                      methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
                      include_in_schema=False)
    async def kb_api_catch_all(request: Request, unknown_path: str):
        log.warning('kb api unknown path: %s %s', request.method, request.url.path)
        return not_found(request)

    return router


def register_rkb_api(app) -> None:
    """Mount the RKB router and its prefix-level exception handlers."""
    graph_bridge.install(graph_lifecycle)
    kbase_v2_service.set_workflow_binding_provider(workflow_ids_binding)
    set_kbase_row_provider(kbase_service.get_kbase_row)
    app.include_router(build_router(), prefix=KBASE_PREFIX)
    app.add_exception_handler(RequestValidationError, validation_handler)
    # These two handle exceptions that escape a route function; in-route
    # failures are already converted by ``dispatch_sync``'s ladder.
    app.add_exception_handler(KbApiError, kb_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    # auth 域处理器（原 register_auth_api 挂的那两个）：路由并入上面 router 后，
    # 处理器仍挂 app 级——它们处理的是从路由函数里逃逸的 AuthError/AuthStoreUnavailable。
    register_auth_exception_handlers(app)
    log.info('Registered kb api under %s', KBASE_PREFIX)
