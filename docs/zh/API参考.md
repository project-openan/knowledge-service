# API 参考

## 使用之前

### 概述

本 API 提供 OpenAN 知识服务的 RESTful 接口，支持开发者创建和管理文档知识库与图谱知识库、导入和处理文档、编排和发布检索流程、执行文档、关键词与图谱检索，以及获取带检索证据的生成答案。接口按本文列出的域分组。

### 基础地址与版本

本文所有路径均相对于前缀 `/api/knowledge-service/v1`。默认部署在后端直连地址 `http://localhost:8091` 和 Web 同域代理 `http://localhost:8080` 上提供接口。主应用不暴露 `/openapi.json` 和 `/docs`；对外 OpenAPI 契约由路由表生成，并由仓库中的快照测试固定。

### 约束与限制

- 错误使用 RFC 9457 问题详情，媒体类型为 `application/problem+json`。问题响应携带稳定的 `code`，客户端可按 `code` 匹配。
- 创建资源返回 `201` 并携带 `Location` 头；异步任务返回 `202`；删除返回 `204`。
- 分页参数为 `page` 和 `size`，默认值因接口而异，在各域中说明。
- 上传使用 `multipart/form-data`。文档上传支持一次提交多个文件。
- `POST /query` 在 `stream: true` 时返回 Server-Sent Events（`text/event-stream`），代理层不得缓冲该响应。

### 认证与授权

默认 `AUTH_MODE=local` 下，部署使用本地账号和会话 Cookie。通过 `POST /auth/login` 登录，响应设置 HttpOnly Cookie `openan_session`，后续请求携带该 Cookie。持 Cookie 发起业务 `POST`、`PUT`、`PATCH`、`DELETE` 请求时，`Origin` 或 `Referer` 的主机和端口必须与请求地址匹配，否则返回 `403 csrf_rejected`。

| `AUTH_MODE` | 行为 |
| --- | --- |
| `local` | 默认。本地账号与会话 Cookie |
| `none` | 关闭本地鉴权 |
| `gateway` | 由受信任的前置网关验证身份并处理身份头 |

新数据库的管理员密码若为自动生成，须先完成改密，否则其他业务调用返回 `403 password_change_required`。

## 系统接口

健康检查与部署元数据。`GET /health` 无需认证。

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活探针，返回 `ok` |
| GET | `/system/info` | 部署信息 |
| GET | `/system/embedding-models` | 部署可用的 Embedding 模型 |
| GET | `/system/llm-models` | 部署可用的 LLM 模型 |
| GET | `/system/rerank-models` | 部署可用的 Reranker 模型 |
| GET | `/system/file-size-limits` | 上传大小限制；`category` 查询参数默认 `1`。以部署返回值为准 |

## 认证接口

### 查询认证状态

- 典型场景
  Web 应用启动时调用该接口，决定是否启用登录守卫。同一份构建支持三种认证模式。

- 说明
  返回生效的认证模式、账号库是否已初始化，以及当前请求是否携带有效会话。

- 方法
  `GET`

- URI
  `/auth/status`

- 请求参数
  无。

- 响应参数
  | 参数 | 类型 | 说明 |
  | --- | --- | --- |
  | `mode` | string | 生效的认证模式：`local`、`none` 或 `gateway` |
  | `initialized` | boolean | 本地账号库是否已初始化 |
  | `authenticated` | boolean | 当前请求是否携带有效会话 |
  | `user` | object 或 null | 已认证时返回当前用户的公开信息 |

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `200` | 返回状态 |

### 登录

- 典型场景
  用户在 Web 应用登录，或脚本获取会话以调用 API。

- 说明
  校验本地账号并创建会话，响应设置 HttpOnly Cookie `openan_session`。

- 方法
  `POST`

- URI
  `/auth/login`

- 请求参数
  | 参数 | 类型 | 必填 | 说明 |
  | --- | --- | --- | --- |
  | `username` | string | 是 | 账号名，最长 255 字符 |
  | `password` | string | 是 | 账号密码，最长 1024 字符 |

- 请求示例
  ```bash
  curl -fsS -c cookies.txt -H 'Content-Type: application/json' \
    --data '{"username": "admin", "password": "<password>"}' \
    http://localhost:8080/api/knowledge-service/v1/auth/login
  ```

- 响应参数
  `Set-Cookie` 响应头中的会话 Cookie `openan_session`。

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `200` | 登录成功 |
  | `401` | 凭据无效 |
  | `403` | 需先完成改密才能继续操作 |

### 登出

- 说明
  使当前会话失效并清除 Cookie。

- 方法
  `POST`

- URI
  `/auth/logout`

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `200` | 已登出 |

### 查询当前用户

- 说明
  返回当前会话绑定的账号。

- 方法
  `GET`

- URI
  `/auth/me`

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `200` | 返回当前用户 |
  | `401` | 无有效会话 |

### 修改密码

- 说明
  修改当前账号的密码。管理员密码为初始化时自动生成的情况下，该调用完成首次强制改密。

- 方法
  `POST`

- URI
  `/auth/password`

- 请求参数
  | 参数 | 类型 | 必填 | 说明 |
  | --- | --- | --- | --- |
  | `currentPassword` | string | 是 | 当前密码 |
  | `newPassword` | string | 是 | 新密码 |

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `200` | 密码已修改 |
  | `400` | 当前密码错误或新密码不符合要求 |

## 知识库接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/knowledge-bases` | 列出调用方可见的知识库 |
| GET | `/knowledge-bases/stats` | 知识库汇总统计 |
| POST | `/knowledge-bases` | 创建知识库；查询参数 `type` 取 `document`（默认）或 `graph` |
| GET | `/knowledge-bases/{kbase_id}` | 文档知识库详情 |
| GET | `/knowledge-bases/{kbase_id}/graph` | 图谱知识库详情，返回 `{schemaInfo, data, fileInfo}` |
| PATCH | `/knowledge-bases/{kbase_id}` | 更新元数据 |
| DELETE | `/knowledge-bases/{kbase_id}` | 删除空知识库；非空知识库会被拒绝 |

### 创建知识库

- 典型场景
  用户在导入文档前创建文档知识库，或在配置图谱模板前创建图谱知识库。

- 说明
  默认创建文档知识库；传入 `type=graph` 时创建图谱知识库。请求体携带名称、可选描述和知识库属性，文档知识库的属性中包含 Embedding 模型。

- 方法
  `POST`

- URI
  `/knowledge-bases`

- 请求参数
  | 参数 | 类型 | 必填 | 说明 |
  | --- | --- | --- | --- |
  | `type` | 查询字符串 | 否 | `document`（默认）或 `graph` |
  | `name` | string | 是 | 知识库名称 |
  | `description` | string | 否 | 描述 |
  | `props` | object | 是 | 知识库属性；文档知识库通过 `props.embeddingModel` 指定 Embedding 模型 |

- 请求示例
  ```json
  {
    "name": "运维手册库",
    "description": "产品手册与维护记录",
    "props": {"embeddingModel": "bge-base-zh-v1.5"}
  }
  ```

- 响应参数
  创建成功的知识库对象，包含 `id`。该 `id` 不含文档检索使用的 `doc_` 前缀。

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `201` | 创建成功；`Location` 头指向 `/knowledge-bases/{kbase_id}` |
  | `400` | 名称、大小或属性不合法 |
  | `409` | 同名知识库已存在 |

## 目录接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/knowledge-bases/{kbase_id}/directories` | 列出目录；可选 `parentId`、`type`、`sort` |
| POST | `/knowledge-bases/{kbase_id}/directories` | 创建目录 |
| GET | `/knowledge-bases/{kbase_id}/directories/{directory_id}` | 目录详情 |
| PATCH | `/knowledge-bases/{kbase_id}/directories/{directory_id}` | 重命名或移动目录 |
| DELETE | `/knowledge-bases/{kbase_id}/directories/{directory_id}` | 删除目录 |

## 文档接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/knowledge-bases/{kbase_id}/documents` | 列出文档；可选 `keyword`、`page`（默认 1）、`size`（默认 50） |
| POST | `/knowledge-bases/{kbase_id}/documents` | 以 `multipart/form-data` 上传一个或多个文档 |
| POST | `/knowledge-bases/{kbase_id}/documents/{document_id}/retry` | 异步重新处理失败的文档（仅限失败状态的文档） |
| PATCH | `/knowledge-bases/{kbase_id}/documents` | 在目录间移动文档 |
| DELETE | `/knowledge-bases/{kbase_id}/documents/{document_id}` | 删除文档 |
| GET | `/knowledge-bases/{kbase_id}/documents/{document_id}/content` | 下载原文件 |
| GET | `/knowledge-bases/{kbase_id}/documents/{document_id}/chunks` | 列出文档切片；可选 `keyword`、`page`（默认 1）、`size`（默认 10）、`order` |

### 上传文档

- 典型场景
  用户向文档知识库导入 Markdown、TXT、DOCX 等受支持的文件。

- 说明
  上传一个或多个文件，启动入库流水线：解析、切分、向量化和索引写入。响应返回创建的文档记录。处理异步进行，轮询文档列表直至状态变为可用。

- 方法
  `POST`

- URI
  `/knowledge-bases/{kbase_id}/documents`

- 请求参数
  | 参数 | 类型 | 必填 | 说明 |
  | --- | --- | --- | --- |
  | `files` | 文件列表 | 是 | 待导入文件，以重复的 `files` 表单部分提交 |
  | `metadata` | 表单字符串 | 否 | 上传的 JSON 元数据；路径参数 `kbase_id` 为唯一事实来源，会覆盖 `metadata` 中的同名值 |

- 请求示例
  ```bash
  curl -fsS -b cookies.txt \
    -F 'files=@manual.md' \
    -F 'files=@appendix.docx' \
    -F 'metadata={"directoryId": ""}' \
    http://localhost:8080/api/knowledge-service/v1/knowledge-bases/<kbase_id>/documents
  ```

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `201` | 已受理上传并创建文档 |
  | `400` | 文件类型不受支持或超出大小限制 |
  | `404` | 知识库不存在 |

### 重新处理文档

- 说明
  重新处理处理失败的文档。仅接受失败状态的文档，无需重新上传原文件。

- 方法
  `POST`

- URI
  `/knowledge-bases/{kbase_id}/documents/{document_id}/retry`

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `202` | 已受理重新处理 |
  | `400` | 文档不处于失败状态 |

## 切片接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/knowledge-bases/{kbase_id}/chunks` | 列出知识库切片；可选 `keyword`、`page`（默认 1）、`size`（默认 20） |
| POST | `/knowledge-bases/{kbase_id}/chunks` | 新增手工切片 |

## 算子接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/operators` | 列出已发布算子与系统算子 |
| GET | `/operators/types` | 算子类型 |
| GET | `/operators/template` | 下载算子模板 |
| GET | `/operators/available` | 知识库可用的算子 |
| GET | `/operators/supported` | 受支持的算子 |
| GET | `/operators/{operator_id}` | 算子详情 |
| GET | `/operators/{operator_id}/export` | 导出算子包 |
| POST | `/operators` | 导入算子包（multipart `file`） |
| DELETE | `/operators/{operator_id}` | 删除算子 |
| POST | `/operators/{operator_id}/publish` | 发布算子 |
| DELETE | `/operators/{operator_id}/publish` | 取消发布算子 |
| PUT | `/operators/{operator_id}/visibility` | 更新算子可见性 |

## 图谱接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/graph-schemas` | 列出本体模板 |
| POST | `/graph-schemas` | 创建本体模板 |
| POST | `/graph-schemas/import` | 从文件导入本体模板（`schema_file`） |
| GET | `/graph-schemas/{schema_id}` | 模板详情 |
| PATCH | `/graph-schemas/{schema_id}` | 更新模板 |
| DELETE | `/graph-schemas/{schema_id}` | 删除模板 |
| POST | `/graph-extractions` | 提交图谱抽取 |
| PUT | `/knowledge-bases/{kbase_id}/graph` | 更新图谱知识库的图谱 |
| POST | `/graph-imports` | 从文件导入图谱（`file`） |
| POST | `/knowledge-bases/{kbase_id}/graph/query` | 查询图谱知识库 |
| POST | `/knowledge-bases/{kbase_id}/graph/entities` | 创建实体 |
| PATCH | `/knowledge-bases/{kbase_id}/graph/entities/{entity_id}` | 更新实体 |
| DELETE | `/knowledge-bases/{kbase_id}/graph/entities/{entity_id}` | 删除实体 |
| POST | `/knowledge-bases/{kbase_id}/graph/edges` | 创建关系 |
| PATCH | `/knowledge-bases/{kbase_id}/graph/edges/{edge_id}` | 更新关系 |
| DELETE | `/knowledge-bases/{kbase_id}/graph/edges/{edge_id}` | 删除关系 |
| GET | `/knowledge-bases/{kbase_id}/graph/export` | 导出图谱 |

### 提交图谱抽取

- 典型场景
  用户基于本体模板，从已导入的文档中抽取实体与关系。

- 说明
  提交异步图谱抽取任务。请求体指定图谱知识库、源文档和图谱模板。

- 方法
  `POST`

- URI
  `/graph-extractions`

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `202` | 已受理抽取 |
  | `400` | 请求不合法或缺少模板 |
  | `404` | 知识库或模板不存在 |

## 检索接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| POST | `/retrieval` | 向量或关键词文档检索 |
| POST | `/retrieval/graph` | 对外图谱检索接口 |

### 文档检索

- 典型场景
  开发者在编排流程前，验证知识库能为某个问题返回预期片段。

- 说明
  在一个或多个文档知识库上执行向量或关键词检索，按知识库返回命中的片段。

- 方法
  `POST`

- URI
  `/retrieval`

- 请求参数
  | 参数 | 类型 | 必填 | 说明 |
  | --- | --- | --- | --- |
  | `question` | string | 是 | 查询文本 |
  | `model` | string | 是 | 已登记的 Embedding 模型名 |
  | `type` | integer | 是 | `0` 为向量检索，`1` 为关键词检索 |
  | `bases` | array | 是 | 待检索知识库；每项包含 `baseList`、`priority` 和 `top_k` |

  `baseList` 的每个元素是 `doc_` 加知识库 `id`。知识库列表返回的 `id` 本身不含该前缀。

- 请求示例
  ```json
  {
    "question": "测试环境的归档周期是多少？",
    "model": "bge-base-zh-v1.5",
    "type": 0,
    "bases": [{"baseList": ["doc_<知识库 ID>"], "priority": 0, "top_k": 3}]
  }
  ```

- 响应参数
  | 参数 | 类型 | 说明 |
  | --- | --- | --- |
  | `baseName` | string | 知识库显示名称 |
  | `docs` | array | 命中的片段 |

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `200` | 检索完成 |
  | `400` | 请求体不合法 |
  | `404` | 知识库或模型不存在 |

## 流程接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/workflows` | 列出流程 |
| POST | `/workflows` | 创建流程 |
| GET | `/workflows/knowledge-bases` | 供画布绑定的知识库及状态 |
| PATCH | `/workflows/{workflow_id}` | 更新流程元数据 |
| DELETE | `/workflows/{workflow_id}` | 删除流程 |
| GET | `/workflows/{workflow_id}/flow` | 读取画布配置 |
| PUT | `/workflows/{workflow_id}/flow` | 将画布配置保存为草稿 |
| POST | `/workflows/{workflow_id}/validate` | 发布前校验画布 |
| GET | `/workflows/{workflow_id}/publication` | 读取已发布配置 |
| POST | `/workflows/{workflow_id}/publication` | 发布当前草稿 |
| DELETE | `/workflows/{workflow_id}/publication` | 取消发布 |
| GET | `/workflows/{workflow_id}/export` | 导出画布 JSON |

### 发布流程

- 典型场景
  用户完成检索流程编辑，将其提供给对话测试和下游调用方使用。

- 说明
  发布当前草稿。修改已发布的流程后，保存只更新草稿，重新发布才会让新配置生效。

- 方法
  `POST`

- URI
  `/workflows/{workflow_id}/publication`

- 响应参数
  | 参数 | 类型 | 说明 |
  | --- | --- | --- |
  | `version` | string | 发布版本标识 |

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `201` | 发布成功；`Location` 头指向发布资源 |
  | `400` | 草稿不合法 |

## 问答与追踪接口

### 提问

- 典型场景
  智能体或对话测试工作区对已发布的检索流程提问。

- 说明
  对给定问题执行已发布的流程。`stream` 为 `true` 时以 Server-Sent Events 返回答案。请求可携带对话历史和会话标识，使追问复用上下文。

- 方法
  `POST`

- URI
  `/query`

- 请求参数
  | 参数 | 类型 | 必填 | 说明 |
  | --- | --- | --- | --- |
  | `question` | string | 是 | 问题文本 |
  | `workflow_id` | string | 否 | 待执行的已发布流程 |
  | `conversation_id` | string | 是 | 会话标识，用于跨轮保持上下文 |
  | `stream` | boolean | 否 | `true` 返回 Server-Sent Events，默认 `false` |
  | `chat_history` | array | 否 | 对话的历史轮次 |
  | `include_retrieval` | boolean | 否 | 在响应中包含本轮检索证据，默认 `false` |
  | `llm` | string | 否 | LLM 模型名；为空时使用流程默认值 |
  | `kwargs` | object | 否 | 传给流程的附加参数 |

- 请求示例
  ```json
  {
    "question": "测试环境的归档周期是多少？",
    "workflow_id": "<已发布流程 ID>",
    "conversation_id": "conv-001",
    "stream": true,
    "include_retrieval": true
  }
  ```

- 响应参数
  `stream: true` 时返回 `text/event-stream`，携带答案分段、检索证据和引用。`stream: false` 时返回包含答案的 JSON 对象；`include_retrieval` 为 `true` 时同时包含检索证据。

- 状态码
  | 状态码 | 说明 |
  | --- | --- |
  | `200` | 返回答案 |
  | `400` | 请求不合法或流程未发布 |
  | `404` | 流程不存在 |

### 查询追踪

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/query-traces` | 列出查询追踪；可选 `workflowId`、`conversationId`、`traceId`、`orgId` 及分页参数 |
| GET | `/query-traces/stats` | 追踪统计；可选 `workflowId`、`orgId`、`from`、`to`、`bucket`（默认 `day`） |
| GET | `/query-traces/{trace_row_id}` | 追踪详情，包含检索证据 |

## 模型接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/models` | 列出已登记模型 |
| GET | `/models/thinking-presets` | LLM 思考预设 |
| POST | `/models/test` | 测试未保存的模型配置 |
| POST | `/models` | 登记模型 |
| GET | `/models/{model_id}` | 模型详情 |
| PUT | `/models/{model_id}` | 更新模型 |
| DELETE | `/models/{model_id}` | 删除模型 |
| POST | `/models/{model_id}/test` | 测试已保存的模型 |

模型凭据使用 `RKB_SECRET_KEY` 加密。模型端点必须可从后端容器访问。

## 任务接口

| 方法 | URI | 说明 |
| --- | --- | --- |
| GET | `/tasks/stats` | 任务统计 |
| GET | `/tasks/groups` | 任务分组；可选 `task_type`、`status`、`lane`、`kbase_id`、`keyword`、`page`（默认 1）、`size`（默认 20） |
| GET | `/tasks` | 列出任务，筛选条件与任务分组相同 |
| GET | `/tasks/{task_id}` | 任务详情 |
| POST | `/tasks/{task_id}/cancel` | 取消任务 |
| POST | `/tasks/{task_id}/retry` | 重试任务 |
| PATCH | `/tasks/{task_id}` | 更新任务属性 |

## 状态码

| 状态码 | 说明 |
| --- | --- |
| `200` | 请求成功 |
| `201` | 资源已创建；`Location` 头标识资源位置 |
| `202` | 已受理异步任务 |
| `204` | 请求成功且无响应体 |
| `400` | 请求体或参数不合法 |
| `401` | 需要认证或会话无效 |
| `403` | `password_change_required`、`csrf_rejected` 或权限不足 |
| `404` | 资源不存在 |
| `409` | 冲突，例如知识库名称重复 |
| `500` | 内部错误 |

## 附录

错误响应遵循 RFC 9457，媒体类型为 `application/problem+json`。`code` 字段稳定，客户端可按其匹配；`title` 和 `detail` 为可读文本。`AUTH_MODE=local` 下，只有健康检查和登录接口无需会话。
