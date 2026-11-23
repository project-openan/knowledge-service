"""按路径的进程内限流 + 慢请求埋点（自 ``app.py`` 抽出，行为保持一致）。

两部分职责历史上长在 ``app.py`` 的一个函数式中间件里；本模块只做搬家：

* **限流**：按 path 配置 ``{limit, window}``，内存时间戳滑窗计数。当前只有图检索
  一条（300 次/秒）。⚠️ 状态是**进程内存态**——多副本/多 worker 部署时各限各的，
  不是全局限流；如需全局配额要走网关或 Redis，见 PR 讨论。
* **慢请求埋点**（ISSUE-OPS-002）：超过 ``RKB_SLOW_REQUEST_LOG_MS``（毫秒，0 表示
  全部记录）的请求打一条 warning：method + path + status + 耗时，按路径对账。

实现是**纯 ASGI**（与 :mod:`request_id` 同一约定）：不缓冲 SSE 流式响应，
响应状态码从 ``http.response.start`` 消息里取。
"""
from __future__ import annotations

import os
import time
from collections import defaultdict

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from shared.prefixes import GRAPH_RETRIEVE_PATH
from shared.problem import RATE_LIMITED, generic_detail, problem_response
from infrastructure.http.identity import language
from infrastructure.logging.logutil import log

#: 慢请求阈值（毫秒）。可用环境变量 ``RKB_SLOW_REQUEST_LOG_MS`` 覆盖。
SLOW_REQUEST_LOG_MS = int(os.environ.get('RKB_SLOW_REQUEST_LOG_MS', '2000') or 2000)

#: 限流配置：path -> {limit, window}（窗口秒数）。当前仅图检索保留。
RATE_LIMITS: dict = {
    GRAPH_RETRIEVE_PATH: {"limit": 300, "window": 1},
}


class RateLimitMiddleware:
    """按路径限流 + 慢请求打点。``limits``/``slow_ms`` 供测试注入，默认用上面两份。"""

    def __init__(self, app: ASGIApp, limits: dict | None = None,
                 slow_ms: int | None = None) -> None:
        self.app = app
        self.rate_limits = RATE_LIMITS if limits is None else limits
        # ``None`` = 每次请求时读模块常量（测试可 monkeypatch SLOW_REQUEST_LOG_MS），
        # 与原 app.py 函数式中间件"运行时读全局"的可测语义一致。
        self._slow_ms_override = slow_ms
        # 存储请求时间戳：client_ip -> [timestamp, ...]
        self.request_times: defaultdict = defaultdict(list)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get('type') != 'http':
            await self.app(scope, receive, send)
            return

        started_at = time.perf_counter()
        path = scope.get('path', '')
        status = 'no-response'

        async def send_capturing_status(message: Message) -> None:
            nonlocal status
            if message['type'] == 'http.response.start':
                status = message['status']
            await send(message)

        try:
            limited = self._enforce_limit(scope, path, send)
            if limited is not None:
                await limited(scope, receive, send)
                return
            await self.app(scope, receive, send_capturing_status)
        finally:
            elapsed_ms = (time.perf_counter() - started_at) * 1000
            slow_threshold = SLOW_REQUEST_LOG_MS if self._slow_ms_override is None \
                else self._slow_ms_override
            if elapsed_ms >= slow_threshold:
                log.warning(
                    "slow request: %s %s -> %s in %.0f ms",
                    scope.get('method', ''), path, status, elapsed_ms)

    def _enforce_limit(self, scope: Scope, path: str, send: Send) -> JSONResponse | None:
        """命中限流时返回待发送的 429 problem 响应，否则返回 ``None``。"""
        limit_info = self.rate_limits.get(path)
        if not limit_info:
            return None

        client = scope.get('client')
        if client is None:
            log.warning("Request client is None, cannot apply rate limiting.")
            return None
        client_ip = client[0]

        limit = limit_info["limit"]
        window = limit_info["window"]
        current_time = time.time()
        # 清理过期的时间戳后滑窗计数
        self.request_times[client_ip] = [
            timestamp for timestamp in self.request_times[client_ip]
            if current_time - timestamp < window]
        if len(self.request_times[client_ip]) >= limit:
            log.warning(f"Rate limit exceeded for IP: {client_ip} on path: {path}")
            return problem_response(
                RATE_LIMITED, generic_detail(RATE_LIMITED, language(Request(scope))),
                instance=path, headers={'Retry-After': str(window)})

        self.request_times[client_ip].append(current_time)
        return None
