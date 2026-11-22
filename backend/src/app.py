import os
import time
from collections import defaultdict

from fastapi import FastAPI, Request
from auth.middleware import AuthMiddleware

from infrastructure.http.middleware.content_type_validation import ContentTypeValidationMiddleware
from infrastructure.logging.logutil import log

context_path = os.environ.get('URL_CONTEXT_PATH', '')
context_path = f'/{context_path}' if context_path else ''
# 禁用 Swagger UI 文档以避免信息泄露风险（生产环境安全要求）
#
# ``lifespan`` 负责常驻后台任务的启停。**不要改回模块级 start**：沙箱用
# spawn/forkserver 会重新执行入口模块，每个沙箱子进程都会再起一份语料队列消费者
# 与文件清理任务。详见 ``startup.py`` 的模块 docstring。
from startup import build_lifespan  # noqa: E402  (须在 app 构造前导入)

app = FastAPI(
    title='OpenAN Knowledge Service',
    root_path=context_path,
    docs_url=None,      # 禁用 /docs 端点
    redoc_url=None,     # 禁用 /redoc 端点
    openapi_url=None,   # 禁用 /openapi.json 端点
    lifespan=build_lifespan,
)
app.add_middleware(AuthMiddleware)
app.add_middleware(ContentTypeValidationMiddleware)
# 容忍路径里的连续 ``/``（web 的 operator.js 会发 ``//operator/...``，见
# infrastructure/http/path_normalization.py）。注意：**最外层是文末的
# RequestIdMiddleware**（后注册 = 先执行）。
from infrastructure.http.path_normalization import CollapseDuplicateSlashesMiddleware  # noqa: E402

app.add_middleware(CollapseDuplicateSlashesMiddleware)

# 本地账号登录（{RKB_PREFIX}/auth）：status/login/logout/me/password。
# ⚠️ **必须在 register_rkb_api 之前**：kb_api 的 ``/{unknown_path:path}``
# 兜底会把晚注册的 /auth/* 吃掉（症状：200 + 404 problem，而不是真正的登录响应）。
from auth.api import register_auth_api  # noqa: E402

register_auth_api(app)

# 知识库（/api/knowledge-service/v1）接口层：单前缀注册，见 http_api。
from http_api import register_rkb_api  # noqa: E402

register_rkb_api(app, enable_ingestion=False, enable_manual_chunks=False)

log.info(">>> start app....")

# 存储请求时间戳
request_times = defaultdict(list)

# 按请求路径定义限流规则。
rate_limits: dict[str, dict] = {}

# 慢请求埋点：单进程后端在后台抽取/入库并发时，简单只读接口可能被拖过客户端超时。
# 超过阈值的请求打一条 warning，按 method/path/耗时对账；
# 阈值可用 RKB_SLOW_REQUEST_LOG_MS 调整（0 表示全部记录）。
SLOW_REQUEST_LOG_MS = int(os.environ.get('RKB_SLOW_REQUEST_LOG_MS', '2000') or 2000)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    started_at = time.perf_counter()
    response = None
    path = request.url.path
    try:
        if request.client is None:
            log.warning("Request client is None, cannot apply rate limiting.")
            return await call_next(request)  # 直接调用下一个中间件
        client_ip = request.client.host
        current_time = time.time()

        # 获取当前路由的限流配置
        limit_info = rate_limits.get(path)
        if limit_info:
            limit = limit_info["limit"]
            window = limit_info["window"]

            # 清理过期的请求时间戳
            request_times[client_ip] = [timestamp for timestamp in request_times[client_ip] if
                                        current_time - timestamp < window]

            # 检查请求次数
            if len(request_times[client_ip]) >= limit:
                log.warning(f"Rate limit exceeded for IP: {client_ip} on path: {path}")
                from infrastructure.http.identity import language as _language
                from shared.problem import (RATE_LIMITED, generic_detail,
                                            problem_response)
                return problem_response(
                    RATE_LIMITED, generic_detail(RATE_LIMITED, _language(request)),
                    instance=path, headers={'Retry-After': str(window)})

            # 记录当前请求的时间戳
            request_times[client_ip].append(current_time)

        response = await call_next(request)
        return response
    finally:
        elapsed_ms = (time.perf_counter() - started_at) * 1000
        if elapsed_ms >= SLOW_REQUEST_LOG_MS:
            log.warning(
                "slow request: %s %s -> %s in %.0f ms",
                request.method, path,
                getattr(response, 'status_code', 'no-response'), elapsed_ms)


# 健康检查只有唯一端点 `GET <prefix>/health`（kb_api 提供，纯文本 ok）。
# 容器内探活使用 `http://localhost:8091/api/knowledge-service/v1/health`。

# 请求 ID：**必须最后注册**（= 最外层），才能覆盖鉴权 401、限流 429、路由 404/422
# 这些不经过业务 handler 的响应。客户端传合法 ``X-Request-Id`` 就沿用，
# 不合法则丢弃重新生成；响应头同名回显。
# 见 infrastructure/http/middleware/request_id.py。
from infrastructure.http.middleware.request_id import RequestIdMiddleware  # noqa: E402

app.add_middleware(RequestIdMiddleware)
