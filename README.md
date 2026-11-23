# OpenAN Knowledge Service

OpenAN 知识服务包含基于 Co-Knowledge 的 Knowledge Studio 前端和对应的后端服务。

| 工作区 | 能力 |
|---|---|
| 文档知识库 | 建库、管理目录、上传与解析文档、重试、查看切片和下载原文 |
| 图谱知识库 | 定义本体、导入或抽取图谱、查询、可视化、编辑和导出实体与关系 |
| 知识检索 | 编排和发布检索流程，使用关键词、向量与图谱检索节点 |
| 对话测试 | 选择已发布的检索流程，流式查看回答和知识库依据 |
| 模型管理 | 登记、测试、启停 LLM、Embedding 和 Reranker 端点 |

## 快速开始

需要 Docker 和 Docker Compose。

```sh
# 1. 准备配置：复制示例并填写三个必填凭据（见「配置」）
cp deploy/.env.example deploy/.env

# 2. 启动 PostgreSQL、OpenSearch、后端和 Web 控制台
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build --wait

# 3. 健康检查
curl http://localhost:8091/api/knowledge-service/v1/health   # -> ok
```

打开 [Knowledge Studio](http://localhost:8080/#/knowledge)，用本地管理员账号登录并完成初次改密。
在「模型管理」登记并测试可达的 OpenAI 兼容 Embedding 和 LLM 端点，再创建知识库、导入文档、
编排并发布检索流程，最后在「对话测试」中选择该流程提问。流程使用重排时再登记 Reranker。
模型推理服务由部署方提供。可在 `deploy/.env` 中预配置模型端点，或在界面登记。

### 获取 admin 初始密码

`RKB_ADMIN_PASSWORD` 留空时，启动期自动生成随机密码写入容器内
`/data/rkb/initial-admin-password`（权限 0600）：

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec backend cat /data/rkb/initial-admin-password
```

首次登录后按界面提示改密，改密成功后此文件会自动删除。

### 登录与调用

默认 `AUTH_MODE=local`：除健康检查与 `/auth/status|login|logout` 外，
所有接口都要求会话 Cookie（`openan_session`，HttpOnly）。

```sh
# 登录（登录本身不要求 Origin）
curl -c cookies.txt -X POST http://localhost:8091/api/knowledge-service/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<初始密码>"}'

# 建库（props 必传；embeddingModel 使用已登记的模型名或部署默认值）
curl -b cookies.txt -X POST \
  http://localhost:8091/api/knowledge-service/v1/knowledge-bases \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:8091' \
  -d '{"name":"demo","description":"示例知识库","props":{"embeddingModel":"bge-base-zh-v1.5"}}'

# 查询知识库列表
curl -b cookies.txt http://localhost:8091/api/knowledge-service/v1/knowledge-bases
```

规则速记：`POST/PUT/PATCH/DELETE` 必须带 `Origin`（或 `Referer`）头且其
host 与请求 `Host` 一致（CSRF 防护，`curl` 不带会得到 `403 csrf_rejected`）；
未登录访问业务接口返回 `401`；登录连续失败会触发 `429` 防爆破。

## HTTP 接口

统一前缀 `/api/knowledge-service/v1`。生产环境禁用了 Swagger（`/docs`、
`/openapi.json`）。主要接口如下。

| 域 | 方法与路径 | 说明 |
|---|---|---|
| 健康 | GET `/health` | 存活探针，无需登录 |
| 认证 | GET `/auth/status` · POST `/auth/login` · POST `/auth/logout` · GET `/auth/me` · POST `/auth/password` | 本地账号会话 |
| 系统 | GET `/system/info` · GET `/system/file-size-limits` | 服务信息 / 上传大小限制 |
| 知识库 | GET·POST `/knowledge-bases` · GET `/knowledge-bases/stats` · GET·PATCH·DELETE `/knowledge-bases/{id}` · GET `/knowledge-bases/{id}/graph` | 建库（`?type=graph` 建图谱库）/ 改 / 删 / 查；同名空库自动复用 |
| 目录 | GET·POST `/knowledge-bases/{id}/directories` · GET·PATCH·DELETE `.../directories/{did}` | 目录树管理（删目录保留文档，移入 Default） |
| 文档 | GET·POST·PATCH `/knowledge-bases/{id}/documents` · DELETE `.../documents/{did}` · POST `.../documents/{did}/retry` · GET `.../documents/{did}/content` | 查询、上传、移动、删除、重试和下载 |
| 切片 | GET·POST `/knowledge-bases/{id}/chunks` · GET `.../documents/{did}/chunks` | 关键词分页查询与手工新增 |
| 图谱 | `/graph-schemas` · `/graph-extractions` · `/graph-imports` · `/knowledge-bases/{id}/graph/*` | 本体、抽取、导入、实体关系管理与查询 |
| 检索 | POST `/retrieval` · POST `/retrieval/graph` · `/workflows` | 知识检索和流程编排、验证与发布 |
| 对话测试 | POST `/query` | 已发布的流程运行，`stream: true` 时返回 SSE |
| 模型 | `/models` | 管理模型端点与连通性测试 |
| 算子查询 | GET `/operators` · GET `/operators/available` · GET `/operators/supported` | 建库与检索编排所用的算子选项 |

## 配置

复制 `deploy/.env.example` 为 `deploy/.env`；所有配置经环境变量注入：

| 变量 | 必填 | 说明 |
|---|---|---|
| `POSTGRES_PASSWORD` | ✅ | 数据库超级用户口令（建议 32 位随机值） |
| `RKB_DB_PASSWORD` | ✅ | 应用角色 `rag_app` 口令（非 superuser，空卷初始化时自动创建） |
| `RKB_SECRET_KEY` | ✅ | 模型凭据加密密钥（建议 32+ 字节随机值）。已有模型时需沿用原密钥 |
| `RKB_ADMIN_PASSWORD` | – | 留空则启动期随机生成到 `/data/rkb/initial-admin-password` |
| `AUTH_MODE` | – | `local`（默认）/ `none` / `gateway`（网关令牌模式，须由前置网关剥离客户端伪造的身份头） |
| `KNOWLEDGE_BASE_PORT` | – | 对外端口，默认 8091 |
| `WEB_PORT` | – | Web 控制台端口，默认 8080 |
| `RKB_AUTH_SESSION_TTL_SECONDS` | – | 会话有效期，默认 12h，钳制 [60s, 30d] |
| `RKB_AUTH_LOGIN_MAX_FAILURES` / `RKB_AUTH_LOGIN_IP_MAX_FAILURES` / `RKB_AUTH_LOGIN_WINDOW_SECONDS` | – | 登录防爆破阈值（按账号+IP 与 IP 双维度滑动窗口） |
| `RKB_AUTH_COOKIE_SECURE` | – | `auto`（默认，按 `X-Forwarded-Proto`）/ `true` / `false` |
| `URL_CONTEXT_PATH` | – | 反向代理子路径（root_path），如经 nginx 挂在子路径下时设置 |
| `RKB_STORAGE_BACKEND` | – | 文件存储后端，`local`（默认，卷 `/data/kb`） |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSION` | – | 部署默认的向量模型名与维度（默认 `bge-base-zh-v1.5` / 1024） |
| `MODEL_GATEWAY_URL` / `GENERATION_GATEWAY_URL` / `RERANK_URL` | – | 用于初始化模型注册表的端点，也可在「模型管理」配置 |
| `RKB_SLOW_REQUEST_LOG_MS` | – | 慢请求告警阈值，默认 2000ms |

## 故障排查

| 现象 | 处理 |
|---|---|
| OpenSearch 起不来 | 内核 `vm.max_map_count` 需 ≥ 262144：`sudo sysctl -w vm.max_map_count=262144` |
| 端口被占 | 修改 `.env` 的 `WEB_PORT` 或 `KNOWLEDGE_BASE_PORT` |
| 登录成功但业务接口一直 401 | 首登处于「必须改密」状态，只放行 `/auth/me`、`/auth/password`，先改密 |
| POST 返回 `403 csrf_rejected` | 补 `Origin` 头，host 必须与请求 `Host` 一致 |
| 登录返回 429 | 触发防爆破，按响应 `Retry-After` 等待，或调整阈值变量 |
| 看日志 | `docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f backend` |

数据卷包括 `pgdata`（关系库）、`osdata`（全文索引）、`kbdata`（知识库文件）和
`rkbdata`（运行文件）。`down` 保留卷，`down -v` 会清除数据。

## 从基础版升级已有数据库

空数据库会自动初始化。已用基础版创建过 PostgreSQL 数据卷时，先备份数据库并停止写入，
然后在同一个数据卷上按顺序执行 `deploy/init/pg/04-studio-schema.sql`、`05-app-role.sh`
及 `10` 到 `17` 的 SQL 脚本。`05-app-role.sh` 使用数据库所有者账号更新应用角色权限。
这些脚本保留知识库、账号、切片和历史任务。缺少持久化输入的旧未完成任务会被标为失败，
可在对应知识库重新提交。`00-schema.sql` 用于空卷初始化。

## 后端测试

Linux + Python 3.11，在 `backend/` 目录：

```sh
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m compileall -q src tests
python -m pytest tests -q                  # 单元与 HTTP 契约
python -m pytest src/ingestion/tests -q    # 文档解析与算子沙箱
ruff check src tests
```

前端开发在 `frontend/` 运行 `npm ci` 和 `npm run serve`，打开 `http://localhost:8808`。
开发服务器默认代理本机 `8091`，可通过 `VUE_APP_API` 指定其他后端。运行
`npm run test:unit` 执行前端测试，运行 `npm run build` 生成生产静态资源。

## 许可

Apache-2.0。前端和扩展后端迁自 [Co-Knowledge](https://github.com/ZTE-AICloud/Co-Sight/tree/01b93a40647c2999558cc130f149632dd75cbe1e/Co-Knowledge)。
版权与归属见 [NOTICE](NOTICE) 和 [第三方声明](THIRD-PARTY-NOTICES.md)。
