"""Health, deployment information and upload limits."""
from __future__ import annotations

import os

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from infrastructure.http.rkb_support import dispatch, path_long
from knowledge_base.service import file_service, kbase_service


def build_router() -> APIRouter:
    router = APIRouter()

    @router.get('/health', response_class=PlainTextResponse)
    async def health():
        return 'ok'

    @router.get('/system/info')
    async def system_info(request: Request):
        return await dispatch(request, lambda _payload: {
            'deployedBy': kbase_service.deployed_by(),
            'ais': kbase_service.is_ais_environment(os.environ.get('DEPLOY_PLAT_TYPE')),
        })

    @router.get('/system/file-size-limits')
    async def file_size_limits(request: Request, category: str = '1'):
        return await dispatch(
            request, lambda _payload: file_service.file_size_limit(path_long(category)))
    return router
