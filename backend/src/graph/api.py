"""Graph HTTP API: schemas, extraction, import, query, and graph content."""
from __future__ import annotations

import io
import time

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from shared.errors.api import (KbApiError, KbMalformedRequestError,
                                  KbMediaTypeError, KbStoreError,
                                  KbValidationError)
from infrastructure.http import content_type
from infrastructure.http import kb_responses as responses
from infrastructure.http.identity import (base_bundle, current_user,
                                            header_language, language)
from shared.prefixes import RKB_PREFIX
from infrastructure.http.rkb_support import (dispatch,
                                              enforce_body_content_type, org_id)
from knowledge_base.http_support import form_files, form_text

from infrastructure.http import headers as httputil
from infrastructure.logging import trace
from infrastructure.logging.logutil import log
from shared.problem import INTERNAL_ERROR, generic_detail, problem_response
from graph.models.graph_retrieve_dto import GraphRetrieveDto
from graph.service import (graph_export_service, graph_extract_v2_api,
                           graph_import_api, graph_query_api,
                           graph_schema_service, graph_write_service)
from graph.service import graph_retrieve_gateway as gateway
from graph.service.graph_retrieve_gateway import GraphRetrieveError


KBASE_PREFIX = RKB_PREFIX

def graph_db_id(kbase_id: str) -> str:
    """图谱查询的 ``kb_id`` 必须带 ``graph_`` 前缀；路径里的 id 是裸 id。"""
    from graph.constants import GRAPH_TABLE_PREFIX

    if kbase_id.startswith(GRAPH_TABLE_PREFIX):
        return kbase_id
    return GRAPH_TABLE_PREFIX + kbase_id


async def graph_download(request: Request, build, payload: dict | None = None):
    """Graph export download; RFC 5987 ``filename*`` and JSON errors on failure."""
    from urllib.parse import quote

    lang = language(request)
    try:
        if payload is None:
            raw = await request.body()
            enforce_body_content_type(request, raw)
            payload = responses.parse_json_body(raw, required=True)
        content, filename = await run_in_threadpool(build, payload)
    except KbValidationError as validation_error:
        return responses.error(validation_error, lang, request=request)
    except ValueError:
        return responses.error(KbMalformedRequestError('RetCode.illegalArgument'),
                               lang, request=request)
    except KbApiError as kb_error:
        return responses.error(kb_error, lang, request=request)
    except KbStoreError as store_error:
        log.error('kb api store error [%s]: %s', store_error.kind, store_error.detail)
        return responses.store_error(store_error, lang, request=request)
    except Exception:
        log.exception('kb api graph export failed')
        return responses.server_error(lang, request=request)

    encoded = quote(filename, safe='')
    return StreamingResponse(
        io.BytesIO(content), media_type='application/octet-stream',
        headers={'Content-Disposition': f"attachment; filename*=utf-8''{encoded}",
                 'Content-Length': str(len(content))})


def build_router() -> APIRouter:
    router = APIRouter()

    # 图谱模板（schema）集合：模板是独立于知识库的顶层资源。
    # ------------------------------------------------------------------

    @router.get('/graph-schemas')
    async def graph_schema_list(request: Request):
        return await dispatch(
            request,
            lambda _payload: graph_schema_service.list_schemas(current_user(request)))

    @router.post('/graph-schemas')
    async def graph_schema_create(request: Request):
        return await dispatch(
            request,
            lambda payload: graph_schema_service.create_schema(
                payload, current_user(request), org_id(request)),
            with_body=True, body_required=True, ok_status=201)

    @router.post('/graph-schemas/import')
    async def graph_schema_import(request: Request, schema_file: UploadFile = File(...)):
        content = await schema_file.read()
        filename = schema_file.filename or ''
        return await dispatch(
            request,
            lambda _payload: graph_schema_service.import_schema(
                filename, content, current_user(request), org_id(request)))

    @router.get('/graph-schemas/{schema_id}')
    async def graph_schema_detail(request: Request, schema_id: str):
        return await dispatch(
            request, lambda _payload: graph_schema_service.schema_detail(schema_id))

    @router.patch('/graph-schemas/{schema_id}')
    async def graph_schema_update(request: Request, schema_id: str):
        return await dispatch(
            request,
            lambda payload: graph_schema_service.update_schema(
                {**payload, 'schema_id': schema_id}, current_user(request)),
            with_body=True, body_required=True)

    @router.delete('/graph-schemas/{schema_id}')
    async def graph_schema_delete(request: Request, schema_id: str):
        return await dispatch(
            request,
            lambda _payload: graph_schema_service.delete_schema(
                schema_id, current_user(request), language(request)))

    # ------------------------------------------------------------------
    # 图谱建库 / 导入 / 抽取
    #
    # `POST /graph-extractions` 建新图谱库（multipart）；对已有库的重抽是
    # `PUT /knowledge-bases/{id}/graph`（替换图内容）。导入包同样是一次
    # 建库操作，用 `POST /graph-imports` 与抽取区分来源。
    # ------------------------------------------------------------------

    @router.post('/graph-extractions')
    async def graph_extract(request: Request):
        # 非 multipart 的 Content-Type（含没带）必须在这里显式挡：这条端点手工
        # request.form()，没有 FastAPI 的 422 可拦；否则会落到 0001。
        if not content_type.is_multipart(request.headers.get('content-type')):
            return responses.error(KbMediaTypeError(), language(request), request=request)
        form = await request.form()
        files = await form_files(form, 'file')
        data = await form_text(form, 'data')
        # 缺 file → 400 malformed_request；缺 data → 422 validation_failed。
        if files is None:
            return responses.error(KbMalformedRequestError(), language(request),
                                   request=request)
        if data is None:
            return responses.error(KbValidationError('RetCode.illegalArgument'),
                                   language(request), request=request)
        return await dispatch(
            request,
            lambda _payload: graph_extract_v2_api.extract_graph(
                files, data, header_language(request), current_user(request),
                org_id(request)),
            ok_status=202,
            location=lambda result: (
                f'{KBASE_PREFIX}/knowledge-bases/{result.get("id")}/graph'
                if isinstance(result, dict) and result.get('id') else None))

    @router.put('/knowledge-bases/{kbase_id}/graph')
    async def graph_extract_update(request: Request, kbase_id: str):
        form = await request.form()
        data = await form_text(form, 'data')
        delete_files = await form_text(form, 'deleteFiles')
        local_files = await form_text(form, 'localFiles')
        # data / deleteFiles / localFiles 三个都是必填；files 可缺。
        if data is None or delete_files is None or local_files is None:
            return responses.error(KbValidationError('RetCode.illegalArgument'),
                                   language(request), request=request)
        files = await form_files(form, 'files') or []
        # 更新这条的默认文件夹名取裸 language-option 头。
        title_language = request.headers.get('language-option') or ''
        return await dispatch(
            request,
            lambda _payload: graph_extract_v2_api.update_graph(
                kbase_id, files, data, delete_files, local_files, title_language,
                current_user(request), org_id(request)),
            ok_status=202)

    @router.post('/graph-imports')
    async def graph_import(request: Request, file: UploadFile = File(...)):
        # 整包先读进内存再分发（``dispatch`` 是同步执行的，读文件是 await 的）。
        content = await file.read()
        return await dispatch(
            request,
            lambda _payload: graph_import_api.import_graph(
                file.filename or '', content, current_user(request), org_id(request),
                base_bundle(request)),
            ok_status=202)

    # ------------------------------------------------------------------
    # 单个知识库的图内容（查询 / 实体 / 边 / 导出）
    # ------------------------------------------------------------------

    @router.post('/knowledge-bases/{kbase_id}/graph/query')
    async def graph_query(request: Request, kbase_id: str):
        return await dispatch(
            request,
            lambda payload: graph_query_api.query(
                {**payload, 'kb_id': graph_db_id(kbase_id)}),
            with_body=True, body_required=True)

    @router.post('/knowledge-bases/{kbase_id}/graph/entities')
    async def graph_entity_create(request: Request, kbase_id: str):
        return await dispatch(
            request,
            lambda payload: graph_write_service.create_entity(
                {**payload, 'kbId': kbase_id}, language(request)),
            with_body=True, body_required=True, ok_status=201)

    @router.patch('/knowledge-bases/{kbase_id}/graph/entities/{entity_id}')
    async def graph_entity_update(request: Request, kbase_id: str, entity_id: str):
        return await dispatch(
            request,
            lambda payload: graph_write_service.update_entity(
                {**payload, 'kbId': kbase_id, 'entityId': entity_id},
                language(request)),
            with_body=True, body_required=True)

    @router.delete('/knowledge-bases/{kbase_id}/graph/entities/{entity_id}')
    async def graph_entity_delete(request: Request, kbase_id: str, entity_id: str):
        payload = {
            'kbId': kbase_id,
            'entityId': entity_id,
            'entityType': request.query_params.get('entityType'),
        }
        return await dispatch(
            request,
            lambda _payload: graph_write_service.delete_entity(
                payload, language(request)))

    @router.post('/knowledge-bases/{kbase_id}/graph/edges')
    async def graph_edge_create(request: Request, kbase_id: str):
        return await dispatch(
            request,
            lambda payload: graph_write_service.create_edge(
                {**payload, 'kbId': kbase_id}, language(request)),
            with_body=True, body_required=True, ok_status=201)

    @router.patch('/knowledge-bases/{kbase_id}/graph/edges/{edge_id}')
    async def graph_edge_update(request: Request, kbase_id: str, edge_id: str):
        return await dispatch(
            request,
            lambda payload: graph_write_service.update_edge(
                {**payload, 'kbId': kbase_id, 'edgeId': edge_id}, language(request)),
            with_body=True, body_required=True)

    @router.delete('/knowledge-bases/{kbase_id}/graph/edges/{edge_id}')
    async def graph_edge_delete(request: Request, kbase_id: str, edge_id: str):
        payload = {
            'kbId': kbase_id,
            'edgeId': edge_id,
            'edgeType': request.query_params.get('edgeType'),
        }
        return await dispatch(
            request,
            lambda _payload: graph_write_service.delete_edge(
                payload, language(request)))

    @router.get('/knowledge-bases/{kbase_id}/graph/export')
    async def graph_export(request: Request, kbase_id: str):
        return await graph_download(request, graph_export_service.export_graph,
                                     payload={'kbId': kbase_id})

    # 图谱向量检索（自 app.py 收编）：对外唯一入口 ``<RKB_PREFIX>/retrieval/graph``。
    # 与上面面向 kb 的 graph 路由同属图域，挂在同一 router 里即天然排在 catch-all
    # 之前——不再依赖"先于 register_rkb_api 注册"的顺序纪律。
    router.include_router(build_graph_retrieve_router())
    return router


def build_graph_retrieve_router() -> APIRouter:
    """图检索路由：通过向量检索找到种子节点，然后按深度传播获取子图。

    编排在同进程内走**同一份**（``graph.service.graph_retrieve_gateway``）。
    成功直接返回检索结果对象；失败返回真实状态码 + ``application/problem+json``
    （不是 ``{code:0|-1,...}`` 信封）。入参绑定失败由 ``http_api`` 的异常处理器
    转成 422 problem。
    """
    # gateway 取模块而非函数：测试 monkeypatch ``gateway.retrieve_result`` 才生效
    # （闭包绑定函数引用会绕开 patch）。DTO/gateway 的 import 在模块顶部——
    # 本文件启用了 ``from __future__ import annotations``，字符串注解必须能
    # 在模块 globals 里解析，否则 FastAPI 会把 DTO 当 query 参数。
    retrieve_router = APIRouter()

    # ⚠️ 必须是**同步** def（与原 app.py 内联版一致）：GraphRetrieveDto 不是
    # pydantic v2 BaseModel，async 路由会把它当 query 参数导致 400。
    @retrieve_router.post('/retrieval/graph')
    def graph_retrieve(retrieve_dto: GraphRetrieveDto, request: Request):
        trace_token = trace.set_trace_id(trace.request_id_from(request))
        started = time.perf_counter()
        trace_headers = {trace.REQUEST_ID_HEADER: trace.get_trace_id()}
        log.info('[graph-retrieve] entry bases=%s seed_k=%s depth=%s score=%s labels=%s '
                 'query_len=%s',
                 retrieve_dto.bases, retrieve_dto.seed_k, retrieve_dto.depth,
                 retrieve_dto.score, retrieve_dto.labels, len(retrieve_dto.query or ''))
        try:
            http_headers = httputil.build_http_headers(request.headers)
            data = gateway.retrieve_result(retrieve_dto, http_headers) or {}
            base_results = data.get('base_results') or []
            log.info('[graph-retrieve] done ok=True base_results=%s entities=%s edges=%s '
                     'elapsed=%.3fs',
                     len(base_results),
                     sum(int(item.get('entity_count') or 0) for item in base_results),
                     sum(int(item.get('edge_count') or 0) for item in base_results),
                     time.perf_counter() - started)
            return JSONResponse(content=data, headers=trace_headers)
        except GraphRetrieveError as error:
            log.warning('[graph-retrieve] failed bases=%s status=%s code=%s elapsed=%.3fs',
                        retrieve_dto.bases, error.spec.status, error.spec.code,
                        time.perf_counter() - started)
            return problem_response(error.spec, error.detail,
                                    instance=request.url.path, headers=trace_headers)
        except Exception:
            log.exception('[graph-retrieve] failed bases=%s elapsed=%.3fs',
                          retrieve_dto.bases, time.perf_counter() - started)
            language_option = httputil.build_http_headers(request.headers).get_language_option()
            return problem_response(
                INTERNAL_ERROR, generic_detail(INTERNAL_ERROR, language_option),
                instance=request.url.path, headers=trace_headers)
        finally:
            trace.reset_trace_id(trace_token)

    return retrieve_router
