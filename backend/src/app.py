"""应用装配根（composition root）：只做中间件与路由装配，不含业务逻辑。

本文件历史上还内联过图检索端点、进程内限流和慢请求埋点；现已全部归位：

* 图检索端点 → :mod:`graph.api`（随 kb router 一并注册，天然排在兜底路由之前）；
* 限流 + 慢请求埋点 → :mod:`infrastructure.http.middleware.rate_limit`；
* 全部对外路由的注册序列 → :func:`http_api.build_router`（catch-all 最后）。

新增对外端点时改对应的域模块，**不要**往这里加路由。
"""
import os

from fastapi import FastAPI

from auth.middleware import AuthMiddleware
from infrastructure.http.middleware.content_type_validation import ContentTypeValidationMiddleware
from infrastructure.http.middleware.rate_limit import RateLimitMiddleware
from infrastructure.http.middleware.request_id import RequestIdMiddleware
from infrastructure.http.path_normalization import CollapseDuplicateSlashesMiddleware
from infrastructure.logging.logutil import log
from http_api import register_rkb_api

context_path = os.environ.get('URL_CONTEXT_PATH', '')
context_path = f'/{context_path}' if context_path else ''
# 禁用 Swagger UI 文档以避免信息泄露风险（生产环境安全要求）
#
# ``lifespan`` 负责常驻后台任务的启停。**不要改回模块级 start**：沙箱用
# spawn/forkserver 会重新执行入口模块，每个沙箱子进程都会再起一份语料队列消费者
# 与文件清理任务。详见 ``startup.py`` 的模块 docstring。
from startup import build_lifespan  # noqa: E402  (须在 app 构造前导入)

app = FastAPI(
    title='RAG Knowledge Base Service',
    root_path=context_path,
    docs_url=None,      # 禁用 /docs 端点
    redoc_url=None,     # 禁用 /redoc 端点
    openapi_url=None,   # 禁用 /openapi.json 端点
    lifespan=build_lifespan,
)

# 中间件注册顺序 = 洋葱层次：**后注册的在最外层**。最外层必须是 RequestId
# （覆盖鉴权 401、限流 429、404/422 与 Agent 子应用等不经过业务 handler 的响应）；
# CollapseDuplicateSlashes 要在限流之前完成路径归一（``//operator/...`` 由
# web 的 operator.js 发出，见 infrastructure/http/path_normalization.py）。
app.add_middleware(AuthMiddleware)
app.add_middleware(ContentTypeValidationMiddleware)
app.add_middleware(CollapseDuplicateSlashesMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(RequestIdMiddleware)

# 健康检查只有唯一端点 `GET <prefix>/health`（kb_api 提供，纯文本 ok）。
# 容器内探活使用 `http://localhost:8091/api/knowledge-service/v1/health`。
register_rkb_api(app)

log.info(">>> start app....")
