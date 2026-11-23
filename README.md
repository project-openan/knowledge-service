# OpenAN Knowledge Service

OpenAN Knowledge Service 提供文档与图谱知识库、检索流程编排和基于知识库的问答。项目包含 Knowledge Studio 前端和 FastAPI 后端。PostgreSQL（pgvector）存储业务数据与向量，OpenSearch 提供关键词检索。

## 当前功能

| 工作区 | 默认入口 | 能力 |
| --- | --- | --- |
| 文档知识库 | `/#/knowledge` | 创建知识库和目录，导入并处理文档，查看切片，下载原文，重试失败文档 |
| 图谱知识库 | `/#/graph` | 管理本体模板，从文档抽取或导入图谱，查询、可视化、编辑和导出实体与关系 |
| 知识检索 | `/#/flow` | 在画布上编排关键词、向量或图谱检索，保存草稿、校验、发布与取消发布 |
| 对话测试 | `/#/chat` | 选择已发布的检索流程，流式查看回答、检索证据和引用 |
| 模型管理 | `/#/models` | 登记、启停和测试 LLM、Embedding 与 Reranker，按需设置默认模型 |

## 安装与部署

以下 Bash 命令在部署主机的仓库根目录执行。目标版本应包含 `backend/`、`frontend/` 和 `deploy/docker-compose.yml`。需要可用的 Docker Engine、支持 `up --wait` 的 Docker Compose v2 和 `curl`。首次构建还需要访问镜像仓库、PyPI 和 npm，或在环境文件中配置可用的镜像源。

### 1. 检查部署环境

```bash
docker version
docker compose version
```

在 Linux 部署主机上，OpenSearch 需要 `vm.max_map_count` 至少为 `262144`。
默认使用宿主机端口 `8080` 和 `8091`。端口已占用时，可在 `deploy/.env` 中修改
`WEB_PORT` 或 `KNOWLEDGE_BASE_PORT`，并同步修改后续检查命令。

### 2. 准备环境文件

手动配置时，复制示例并填入 `POSTGRES_PASSWORD`、`RKB_DB_PASSWORD` 和 `RKB_SECRET_KEY`。

```bash
(
  umask 077
  cp -n deploy/.env.example deploy/.env
)
```

Agent 或 CI 做首次安装时，可用 OpenSSL 自动生成三个必填值。下面的命令仅在环境文件不存在时创建它。
已有部署沿用原来的环境文件、Compose 项目名和数据卷。

```bash
if [ ! -e deploy/.env ]; then
  (
    set -euC
    umask 077
    studio_pg_password="$(openssl rand -hex 24)"
    studio_app_password="$(openssl rand -hex 24)"
    studio_secret_key="$(openssl rand -hex 32)"
    printf 'POSTGRES_PASSWORD=%s\nRKB_DB_PASSWORD=%s\nRKB_SECRET_KEY=%s\n' \
      "$studio_pg_password" "$studio_app_password" "$studio_secret_key" > deploy/.env
  )
fi
```

### 3. 启动并检查服务

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml config --quiet
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build --wait
docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps

# Web 入口应返回页面，两条健康检查均应返回 ok
curl -fsSL --retry 5 --retry-connrefused -o /dev/null http://localhost:8080/
curl -fsS --retry 5 --retry-connrefused http://localhost:8091/api/knowledge-service/v1/health
curl -fsS --retry 5 --retry-connrefused http://localhost:8080/api/knowledge-service/v1/health
```

对外部署时，将 HTTPS 反向代理指向 Web 端口。Web 会将同域的 API 请求转发到后端。
通过公网域名再验证一次首页和健康接口。上层代理转发 `POST /api/knowledge-service/v1/query` 时应关闭响应缓冲，以便逐段显示 SSE 回答。

### 4. 登录并验收

本机打开 [Knowledge Studio](http://localhost:8080/#/knowledge)，远程部署使用目标服务器的 Web 地址。
默认管理员用户名为 `admin`。新数据库初始化时，若 `RKB_ADMIN_PASSWORD` 留空，服务会生成随机初始密码。
可在部署主机读取。首次登录后按界面提示改密，改密成功后密码文件会自动删除。

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
  exec backend cat /data/rkb/initial-admin-password
```

如果设置了 `RKB_ADMIN_PASSWORD`，首次登录使用该配置值。已有数据库继续使用其中的账号和密码。

自动化部署结果可按以下两项验收。汇报 Web 地址、探针结果和已完成的功能验证即可，凭据留在部署环境内。

- **服务启动。** Compose 四个服务正常运行，Web 首页可访问，直连和 Web 代理的健康检查均返回 `ok`。
- **功能可用。** 已使用真实模型完成一次文档导入，文档状态为「可用」，可检索到该文档的切片。模型端点或凭据待配置时，可先完成服务启动验收，并记录入库与检索尚待验证。

## 从导入文档到检索问答

1. **登记模型。** 在「模型管理」添加并启用一个 Embedding 端点，填写基础地址、服务商的模型标识、正确的向量维度和所需凭据，然后测试连通性。要生成回答，再添加并测试 LLM。流程包含重排节点时再配置 Reranker。模型服务由部署方提供，端点须能从后端容器访问。
2. **创建知识库。** 在「文档知识库」新建一个库，选择刚登记的 Embedding 模型。打开「文档」页，导入一份含文字的 Markdown、TXT 或 DOCX。首次验证可用一句容易查找的示例内容，如「测试环境的归档周期为 30 天」。
3. **确认入库。** 等待文档状态变为「可用」，查看切片数及内容。文档处理依次经过解析、切分、向量化和索引写入。任务失败后，可在文档操作菜单选择「重新处理」，无需重新上传原件。
4. **编排并发布。** 在「知识检索」新建流程，将检索节点绑定到刚创建的库，按所选节点配置 Embedding 或生成模型。保存并校验流程，在列表中发布。修改已发布的流程后，保存只更新草稿，重新发布才会让新配置生效。
5. **验证结果。** 在「对话测试」选择已发布的流程，提问「测试环境的归档周期是多少？」并查看回答与检索证据。也可直接调用 `POST /retrieval` 单独验证向量或关键词检索。

## HTTP API

所有路径均相对于 `/api/knowledge-service/v1`。默认可直连 `http://localhost:8091`，也可通过 Web 同域代理 `http://localhost:8080`。服务使用 HTTP 状态码，业务错误通常返回 `application/problem+json`。内置 Swagger 页面和 `/openapi.json` 已关闭。

| 域 | 主要接口 | 说明 |
| --- | --- | --- |
| 健康与系统 | GET `/health`、`/system/info`、`/system/file-size-limits` | 健康检查无需登录。文件限制以部署返回值为准 |
| 认证 | GET `/auth/status`、`/auth/me` · POST `/auth/login`、`/auth/logout`、`/auth/password` | 登录、会话与改密 |
| 知识库 | GET/POST `/knowledge-bases` · GET/PATCH/DELETE `/knowledge-bases/{id}` | 默认创建文档库，`POST /knowledge-bases?type=graph` 创建图谱库 |
| 目录与文档 | `/knowledge-bases/{id}/directories`、`/knowledge-bases/{id}/documents` | 管理目录、上传、移动、删除、下载原文与查看切片。POST `/knowledge-bases/{id}/documents/{document_id}/retry` 提交重试 |
| 切片 | GET/POST `/knowledge-bases/{id}/chunks` · GET `/knowledge-bases/{id}/documents/{document_id}/chunks` | 切片查询及新增 |
| 图谱 | `/graph-schemas`、`/graph-extractions`、`/graph-imports`、`/knowledge-bases/{id}/graph` | 管理本体，提交抽取或导入，查询、编辑与导出图谱 |
| 直接检索 | POST `/retrieval`、`/retrieval/graph` | 文档向量/关键词检索与图谱检索 |
| 检索流程 | `/workflows`、`/workflows/{id}/flow`、`/workflows/{id}/validate`、`/workflows/{id}/publication` | 流程管理、草稿编辑、校验与发布 |
| 问答与追踪 | POST `/query` · GET `/query-traces` | 指定已发布的 `workflow_id` 和 `conversation_id`，`stream: true` 使用 SSE |
| 模型 | `/models`、POST `/models/test`、POST `/models/{id}/test` | 模型配置和连通性验证 |
| 算子选项 | GET `/operators`、`/operators/available`、`/operators/supported` | 查询导入与编排可用的算子 |

### API 验证示例

在默认的 `AUTH_MODE=local` 下，请用已完成首登改密的账号。登录返回 HttpOnly 会话 Cookie `openan_session`。持会话发起业务 `POST`、`PUT`、`PATCH`、`DELETE` 请求时，`Origin` 或 `Referer` 的主机和端口必须与请求地址匹配。

以下示例使用 Bash 和 Python 3。若更改了管理员用户名，请替换命令中的 `admin`。将 `<知识库 ID>` 和 `<已登记的 Embedding 模型名>` 替换为已完成导入的文档库 ID 和该库配置的模型名。

```bash
studio=http://localhost:8080
api="$studio/api/knowledge-service/v1"
cookies="$(mktemp)"
trap 'rm -f "$cookies"' EXIT

read -rsp '管理员密码: ' studio_password
printf '\n'
printf '%s' "$studio_password" |
  python3 -c 'import json, sys; print(json.dumps({"username": "admin", "password": sys.stdin.read()}))' |
  curl -fsS -c "$cookies" -H 'Content-Type: application/json' \
    --data-binary @- "$api/auth/login"
unset studio_password

curl -fsS -b "$cookies" "$api/knowledge-bases"

curl -fsS -b "$cookies" -H "Origin: $studio" -H 'Content-Type: application/json' \
  --data-binary @- "$api/retrieval" <<'JSON'
{
  "question": "测试环境的归档周期是多少？",
  "model": "<已登记的 Embedding 模型名>",
  "type": 0,
  "bases": [{"baseList": ["doc_<知识库 ID>"], "priority": 0, "top_k": 3}]
}
JSON
```

`type: 0` 是向量检索，改用 `type: 1` 可检查关键词命中。`doc_` 是文档检索所用的前缀，知识库列表接口返回的 `id` 本身不含这个前缀。响应按库返回 `baseName` 和 `docs`，其中 `docs` 是命中的片段。

## 部署配置与数据

完整配置见部署文件。 [Compose 配置](deploy/docker-compose.yml) [环境变量示例](deploy/.env.example)

| 变量 | 用途 |
| --- | --- |
| `POSTGRES_PASSWORD`、`RKB_DB_PASSWORD` | 必填。分别是数据库管理员和应用数据库角色的口令 |
| `RKB_SECRET_KEY` | 必填。用于加密模型凭据。恢复既有数据库时须保留对应密钥 |
| `RKB_ADMIN_USERNAME`、`RKB_ADMIN_PASSWORD` | 新数据库的管理员账号配置。用户名默认 `admin`，密码可留空以自动生成 |
| `AUTH_MODE` | 默认 `local`。`none` 关闭本地鉴权，`gateway` 依赖受信任的前置网关验证身份并处理身份头 |
| `WEB_PORT`、`KNOWLEDGE_BASE_PORT` | 宿主机端口，默认分别为 `8080` 和 `8091` |
| `WEB_BASE_URL` | Web 构建路径，默认 `/`。改为子路径时需重新构建 Web |
| `EMBEDDING_MODEL`、`EMBEDDING_DIMENSION` | 向量模型及维度的部署级默认值。配置名称和维度本身不会启动模型端点 |
| `MODEL_GATEWAY_URL`、`GENERATION_GATEWAY_URL`、`RERANK_URL` | 可选。预配置 Embedding、LLM、Reranker 端点，也可以在「模型管理」里登记 |
| `RKB_STORAGE_BACKEND` | 默认 `local`，知识库文件写入 `/data/kb` |

默认 Compose 数据卷为 `pgdata`（业务数据与向量）、`osdata`（搜索索引）、`kbdata`（知识库文件）和 `rkbdata`（日志及其他运行文件）。普通 `docker compose down` 保留数据卷，附加 `-v` 会删除数据卷。

### 从基础版升级数据库

空 PostgreSQL 卷会自动初始化。如果复用基础版的 PostgreSQL 卷，先备份数据库并停止应用写入，再以数据库管理员身份按顺序应用 [初始化目录](deploy/init/pg) 中的 `04-studio-schema.sql`、`05-app-role.sh` 和 `10` 至 `17` 的 SQL。`05-app-role.sh` 使用部署中的数据库名、应用角色及口令更新权限。`04-studio-schema.sql` 用于尚未安装 Studio 表的基础版数据库，已升级的实例应核对迁移记录后补齐缺失步骤。旧任务若缺少可重放的输入，迁移后需要从知识库重新提交。

### 常见问题

| 现象 | 检查方法 |
| --- | --- |
| OpenSearch 启动失败 | 在运行 Docker 的 Linux 主机检查 `vm.max_map_count`。若低于 `262144`，可用 `sudo sysctl -w vm.max_map_count=262144` 临时调整 |
| 首登后 API 返回 `403 password_change_required` | 先在页面完成改密，再用新密码登录获取会话 |
| API 返回 `403 csrf_rejected` | 确认 `Origin` 或 `Referer` 与实际请求的地址匹配 |
| 文档显示「向量化失败」 | 核对知识库选用的模型、端点、凭据和向量维度，再点「重新处理」。智谱官方端点的 `Embedding-2` 批量请求会由服务自动拆分 |
| 对话测试找不到流程，或仍使用旧配置 | 从「知识检索」发布流程。更新草稿后使用「重新发布」 |
| 需要查看处理日志 | 执行 `docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f backend` |

## 开发与测试

后端在 Linux 上使用 Python 3.11。以下命令在 `backend/` 目录执行。

```bash
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m compileall -q src tests
ruff check src tests
python -m pytest tests -q
python -m pytest src/ingestion/tests -q
```

前端使用 Node.js 22。以下命令在 `frontend/` 目录执行。

```bash
npm ci
npm run serve
npm run test:unit
npm run build
```

开发页面默认是 `http://localhost:8808`，API 默认代理到本机 `8091`，可在 `frontend/.env.local` 设置 `VUE_APP_API`。生产静态资源输出到 `frontend/dist/`。

## 许可

项目以 Apache-2.0 许可发布。前端与扩展后端基于 Co-Knowledge 迁移。 [上游 Co-Knowledge](https://github.com/ZTE-AICloud/Co-Sight/tree/01b93a40647c2999558cc130f149632dd75cbe1e/Co-Knowledge)

版权、许可与第三方组件归属见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [第三方声明](THIRD-PARTY-NOTICES.md)。
