"""Register system, knowledge-base and operator routes under the service prefix."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from shared.prefixes import RKB_PREFIX
from shared.errors.api import KbApiError
from infrastructure.logging.logutil import log

from infrastructure.http.rkb_support import (http_exception_handler,
                                              kb_error_handler, not_found,
                                              validation_handler)
from knowledge_base import api as knowledge_base_api
from knowledge_base import graph_bridge as graph_bridge_install
from operators import api as operators_api
from system import api as system_api

#: Single external prefix for the REST surface.
KBASE_PREFIX = RKB_PREFIX


def build_router(*, enable_ingestion: bool = True,
                 enable_manual_chunks: bool = True) -> APIRouter:
    """Build the router with the fallback route registered last."""
    router = APIRouter()
    router.include_router(system_api.build_router())
    router.include_router(knowledge_base_api.build_router())
    router.include_router(knowledge_base_api.build_content_router(
        enable_ingestion=enable_ingestion, enable_manual_chunks=enable_manual_chunks))
    router.include_router(operators_api.build_router())

    # Unknown paths under the prefix keep the historical problem response.
    # This route must remain last: it would otherwise swallow every later
    # registration under the same prefix.
    @router.api_route('/{unknown_path:path}',
                      methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
                      include_in_schema=False)
    async def kb_api_catch_all(request: Request, unknown_path: str):
        log.warning('kb api unknown path: %s %s', request.method, request.url.path)
        return not_found(request)

    return router


def register_rkb_api(app, *, enable_ingestion: bool = True,
                     enable_manual_chunks: bool = True) -> None:
    """Mount the RKB router and its prefix-level exception handlers."""
    # Connect knowledge-base lookups and storage lifecycle hooks.
    from retrieval.repository.kbase_lookup import set_kbase_row_provider
    from knowledge_base.service import kbase_service
    from graph.service import lifecycle as graph_lifecycle

    set_kbase_row_provider(kbase_service.get_kbase_row)
    graph_bridge_install.install(graph_lifecycle)
    app.include_router(build_router(enable_ingestion=enable_ingestion,
                                    enable_manual_chunks=enable_manual_chunks), prefix=KBASE_PREFIX)
    app.add_exception_handler(RequestValidationError, validation_handler)
    # These two handle exceptions that escape a route function; in-route
    # failures are already converted by ``dispatch_sync``'s ladder.
    app.add_exception_handler(KbApiError, kb_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    log.info('Registered kb api under %s', KBASE_PREFIX)
