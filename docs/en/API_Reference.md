# API Reference

## Before You Begin

### Overview

This API provides RESTful interfaces for OpenAN Knowledge Service. It enables developers to create and manage document and graph knowledge bases, import and process documents, compose and publish retrieval workflows, run document, keyword, and graph retrieval, and obtain generated answers with retrieval evidence. The API surface is grouped into the domains listed in this document.

### Base URL and Versioning

All paths in this document are relative to the prefix `/api/knowledge-service/v1`. The default deployment exposes the backend directly on `http://localhost:8091` and the web same-origin proxy on `http://localhost:8080`. The main application does not expose `/openapi.json` or `/docs`; the external OpenAPI contract is generated from the route table and pinned by snapshot tests in the repository.

### Constraints and Limitations

- Errors use RFC 9457 problem details with the `application/problem+json` media type. A problem response carries a stable `code` that clients can match.
- Creation returns `201` with a `Location` header where a new resource is created; asynchronous work returns `202`; deletion returns `204`.
- Pagination parameters are `page` and `size`; defaults differ per endpoint and are noted in each domain.
- Uploads use `multipart/form-data`. Document upload accepts multiple files in one request.
- `POST /query` with `stream: true` returns Server-Sent Events (`text/event-stream`). Proxy layers must not buffer this response.

### Authentication and Authorization

Under the default `AUTH_MODE=local`, the deployment uses local accounts and session cookies. Sign in with `POST /auth/login`; the response sets the HttpOnly cookie `openan_session`. Send the cookie with subsequent requests. For business `POST`, `PUT`, `PATCH`, and `DELETE` requests that carry the cookie, the host and port of `Origin` or `Referer` must match the request address, otherwise the request is rejected with `403 csrf_rejected`.

| `AUTH_MODE` | Behavior |
| --- | --- |
| `local` | Default. Local accounts and session cookies |
| `none` | Local authentication disabled |
| `gateway` | Identity is verified by a trusted front proxy that handles identity headers |

A new database whose administrator password was generated automatically requires a password change before other business calls; otherwise those calls return `403 password_change_required`.

## System API

Health and deployment metadata. `GET /health` requires no authentication.

| Method | URI | Description |
| --- | --- | --- |
| GET | `/health` | Liveness probe, returns `ok` |
| GET | `/system/info` | Deployment information |
| GET | `/system/embedding-models` | Embedding models available to the deployment |
| GET | `/system/llm-models` | LLM models available to the deployment |
| GET | `/system/rerank-models` | Reranker models available to the deployment |
| GET | `/system/file-size-limits` | Upload size limits; the `category` query parameter defaults to `1`. Use the deployment response as the source of truth for limits |

## Authentication API

### Get Authentication Status

- Typical Scenario
  The web application calls this endpoint on startup to decide whether to enable the login guard. The same build supports all three authentication modes.

- Description
  Reports the effective authentication mode, whether the account store is initialized, and whether the current request carries a valid session.

- Method
  `GET`

- URI
  `/auth/status`

- Request Parameters
  None.

- Response Parameters
  | Parameter | Type | Description |
  | --- | --- | --- |
  | `mode` | string | Effective authentication mode: `local`, `none`, or `gateway` |
  | `initialized` | boolean | Whether the local account store has been initialized |
  | `authenticated` | boolean | Whether the request carries a valid session |
  | `user` | object or null | Public profile of the current user when authenticated |

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `200` | Status returned |

### Sign In

- Typical Scenario
  A user signs in to the web application, or a script obtains a session for API calls.

- Description
  Verifies the local account and creates a session. The response sets the HttpOnly cookie `openan_session`.

- Method
  `POST`

- URI
  `/auth/login`

- Request Parameters
  | Parameter | Type | Required | Description |
  | --- | --- | --- | --- |
  | `username` | string | Yes | Account name, at most 255 characters |
  | `password` | string | Yes | Account password, at most 1024 characters |

- Request Example
  ```bash
  curl -fsS -c cookies.txt -H 'Content-Type: application/json' \
    --data '{"username": "admin", "password": "<password>"}' \
    http://localhost:8080/api/knowledge-service/v1/auth/login
  ```

- Response Parameters
  Session cookie `openan_session` in the `Set-Cookie` header.

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `200` | Signed in |
  | `401` | Invalid credentials |
  | `403` | Password change required before other operations |

### Sign Out

- Description
  Invalidates the current session and clears the cookie.

- Method
  `POST`

- URI
  `/auth/logout`

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `200` | Signed out |

### Get Current User

- Description
  Returns the account bound to the current session.

- Method
  `GET`

- URI
  `/auth/me`

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `200` | Current user returned |
  | `401` | No valid session |

### Change Password

- Description
  Changes the password of the current account. When the administrator password was generated during initialization, this call completes the mandatory first password change.

- Method
  `POST`

- URI
  `/auth/password`

- Request Parameters
  | Parameter | Type | Required | Description |
  | --- | --- | --- | --- |
  | `currentPassword` | string | Yes | Current password |
  | `newPassword` | string | Yes | New password |

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `200` | Password changed |
  | `400` | Current password incorrect or new password rejected |

## Knowledge Base API

| Method | URI | Description |
| --- | --- | --- |
| GET | `/knowledge-bases` | List knowledge bases visible to the caller |
| GET | `/knowledge-bases/stats` | Aggregate statistics of knowledge bases |
| POST | `/knowledge-bases` | Create a knowledge base; query parameter `type` accepts `document` (default) or `graph` |
| GET | `/knowledge-bases/{kbase_id}` | Document knowledge base detail |
| GET | `/knowledge-bases/{kbase_id}/graph` | Graph knowledge base detail; returns `{schemaInfo, data, fileInfo}` |
| PATCH | `/knowledge-bases/{kbase_id}` | Update metadata |
| DELETE | `/knowledge-bases/{kbase_id}` | Delete an empty knowledge base; non-empty bases are rejected |

### Create a Knowledge Base

- Typical Scenario
  A user creates a document knowledge base before importing documents, or a graph knowledge base before configuring a graph schema.

- Description
  Creates a document knowledge base by default, or a graph knowledge base when `type=graph` is supplied. The request body carries the name, optional description, and the properties of the knowledge base, including the embedding model for a document knowledge base.

- Method
  `POST`

- URI
  `/knowledge-bases`

- Request Parameters
  | Parameter | Type | Required | Description |
  | --- | --- | --- | --- |
  | `type` | query string | No | `document` (default) or `graph` |
  | `name` | string | Yes | Knowledge base name |
  | `description` | string | No | Description |
  | `props` | object | Yes | Knowledge base properties; `props.embeddingModel` selects the embedding model for document knowledge bases |

- Request Example
  ```json
  {
    "name": "Operations Manuals",
    "description": "Product manuals and maintenance records",
    "props": {"embeddingModel": "bge-base-zh-v1.5"}
  }
  ```

- Response Parameters
  The created knowledge base object, including its `id`. The `id` does not include the `doc_` prefix used by document retrieval.

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `201` | Created; `Location` header points to `/knowledge-bases/{kbase_id}` |
  | `400` | Invalid name, size, or properties |
  | `409` | A knowledge base with the same name already exists |

## Directory API

| Method | URI | Description |
| --- | --- | --- |
| GET | `/knowledge-bases/{kbase_id}/directories` | List directories; optional `parentId`, `type`, `sort` |
| POST | `/knowledge-bases/{kbase_id}/directories` | Create a directory |
| GET | `/knowledge-bases/{kbase_id}/directories/{directory_id}` | Directory detail |
| PATCH | `/knowledge-bases/{kbase_id}/directories/{directory_id}` | Rename or move a directory |
| DELETE | `/knowledge-bases/{kbase_id}/directories/{directory_id}` | Delete a directory |

## Document API

| Method | URI | Description |
| --- | --- | --- |
| GET | `/knowledge-bases/{kbase_id}/documents` | List documents; optional `keyword`, `page` (default 1), `size` (default 50) |
| POST | `/knowledge-bases/{kbase_id}/documents` | Upload one or more documents as `multipart/form-data` |
| POST | `/knowledge-bases/{kbase_id}/documents/{document_id}/retry` | Reprocess a failed document asynchronously (only documents in failed status) |
| PATCH | `/knowledge-bases/{kbase_id}/documents` | Move documents between directories |
| DELETE | `/knowledge-bases/{kbase_id}/documents/{document_id}` | Delete a document |
| GET | `/knowledge-bases/{kbase_id}/documents/{document_id}/content` | Download the original file |
| GET | `/knowledge-bases/{kbase_id}/documents/{document_id}/chunks` | List chunks of a document; optional `keyword`, `page` (default 1), `size` (default 10), `order` |

### Upload Documents

- Typical Scenario
  A user imports Markdown, TXT, DOCX, or other supported files into a document knowledge base.

- Description
  Uploads one or more files and starts the ingestion pipeline: parsing, splitting, vectorization, and index writing. The response returns the created document records. Processing continues asynchronously; poll the document list until the status becomes available.

- Method
  `POST`

- URI
  `/knowledge-bases/{kbase_id}/documents`

- Request Parameters
  | Parameter | Type | Required | Description |
  | --- | --- | --- | --- |
  | `files` | file list | Yes | Files to import, sent as repeated `files` parts |
  | `metadata` | form string | No | JSON metadata for the upload; the `kbase_id` path parameter is authoritative and overrides a conflicting value in `metadata` |

- Request Example
  ```bash
  curl -fsS -b cookies.txt \
    -F 'files=@manual.md' \
    -F 'files=@appendix.docx' \
    -F 'metadata={"directoryId": ""}' \
    http://localhost:8080/api/knowledge-service/v1/knowledge-bases/<kbase_id>/documents
  ```

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `201` | Upload accepted and documents created |
  | `400` | Unsupported file type or size limit exceeded |
  | `404` | Knowledge base not found |

### Reprocess a Document

- Description
  Reprocesses a document whose processing failed. Only documents in failed status are accepted; the source file does not need to be uploaded again.

- Method
  `POST`

- URI
  `/knowledge-bases/{kbase_id}/documents/{document_id}/retry`

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `202` | Reprocessing accepted |
  | `400` | Document is not in failed status |

## Chunk API

| Method | URI | Description |
| --- | --- | --- |
| GET | `/knowledge-bases/{kbase_id}/chunks` | List chunks in the knowledge base; optional `keyword`, `page` (default 1), `size` (default 20) |
| POST | `/knowledge-bases/{kbase_id}/chunks` | Add a manual chunk |

## Operator API

| Method | URI | Description |
| --- | --- | --- |
| GET | `/operators` | List published and system operators |
| GET | `/operators/types` | Operator types |
| GET | `/operators/template` | Download the operator template |
| GET | `/operators/available` | Operators available for a knowledge base |
| GET | `/operators/supported` | Supported operators |
| GET | `/operators/{operator_id}` | Operator detail |
| GET | `/operators/{operator_id}/export` | Export an operator package |
| POST | `/operators` | Import an operator package (multipart `file`) |
| DELETE | `/operators/{operator_id}` | Delete an operator |
| POST | `/operators/{operator_id}/publish` | Publish an operator |
| DELETE | `/operators/{operator_id}/publish` | Unpublish an operator |
| PUT | `/operators/{operator_id}/visibility` | Update operator visibility |

## Graph API

| Method | URI | Description |
| --- | --- | --- |
| GET | `/graph-schemas` | List ontology templates |
| POST | `/graph-schemas` | Create an ontology template |
| POST | `/graph-schemas/import` | Import an ontology template from a file (`schema_file`) |
| GET | `/graph-schemas/{schema_id}` | Schema detail |
| PATCH | `/graph-schemas/{schema_id}` | Update a schema |
| DELETE | `/graph-schemas/{schema_id}` | Delete a schema |
| POST | `/graph-extractions` | Submit a graph extraction |
| PUT | `/knowledge-bases/{kbase_id}/graph` | Update the graph of a graph knowledge base |
| POST | `/graph-imports` | Import a graph from a file (`file`) |
| POST | `/knowledge-bases/{kbase_id}/graph/query` | Query a graph knowledge base |
| POST | `/knowledge-bases/{kbase_id}/graph/entities` | Create an entity |
| PATCH | `/knowledge-bases/{kbase_id}/graph/entities/{entity_id}` | Update an entity |
| DELETE | `/knowledge-bases/{kbase_id}/graph/entities/{entity_id}` | Delete an entity |
| POST | `/knowledge-bases/{kbase_id}/graph/edges` | Create a relation |
| PATCH | `/knowledge-bases/{kbase_id}/graph/edges/{edge_id}` | Update a relation |
| DELETE | `/knowledge-bases/{kbase_id}/graph/edges/{edge_id}` | Delete a relation |
| GET | `/knowledge-bases/{kbase_id}/graph/export` | Export the graph |

### Submit a Graph Extraction

- Typical Scenario
  A user extracts entities and relations from imported documents using an ontology template.

- Description
  Submits an asynchronous graph extraction job. The request body selects the graph knowledge base, the source documents, and the graph schema.

- Method
  `POST`

- URI
  `/graph-extractions`

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `202` | Extraction accepted |
  | `400` | Invalid request or missing schema |
  | `404` | Knowledge base or schema not found |

## Retrieval API

| Method | URI | Description |
| --- | --- | --- |
| POST | `/retrieval` | Document retrieval by vector or keyword |
| POST | `/retrieval/graph` | Public graph retrieval endpoint |

### Document Retrieval

- Typical Scenario
  A developer validates that a knowledge base returns the expected fragments for a question, before composing a workflow.

- Description
  Performs vector or keyword retrieval over one or more document knowledge bases and returns the matched fragments per knowledge base.

- Method
  `POST`

- URI
  `/retrieval`

- Request Parameters
  | Parameter | Type | Required | Description |
  | --- | --- | --- | --- |
  | `question` | string | Yes | Query text |
  | `model` | string | Yes | Registered embedding model name |
  | `type` | integer | Yes | `0` for vector retrieval, `1` for keyword retrieval |
  | `bases` | array | Yes | Knowledge bases to search; each entry carries `baseList`, `priority`, and `top_k` |

  Each element of `baseList` is `doc_` followed by the knowledge base `id`. The `id` returned by the knowledge base list does not include the prefix.

- Request Example
  ```json
  {
    "question": "What is the archive period of the test environment?",
    "model": "bge-base-zh-v1.5",
    "type": 0,
    "bases": [{"baseList": ["doc_<knowledge base ID>"], "priority": 0, "top_k": 3}]
  }
  ```

- Response Parameters
  | Parameter | Type | Description |
  | --- | --- | --- |
  | `baseName` | string | Knowledge base display name |
  | `docs` | array | Matched fragments |

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `200` | Retrieval completed |
  | `400` | Invalid request body |
  | `404` | Knowledge base or model not found |

## Workflow API

| Method | URI | Description |
| --- | --- | --- |
| GET | `/workflows` | List workflows |
| POST | `/workflows` | Create a workflow |
| GET | `/workflows/knowledge-bases` | Knowledge bases with status for canvas binding |
| PATCH | `/workflows/{workflow_id}` | Update workflow metadata |
| DELETE | `/workflows/{workflow_id}` | Delete a workflow |
| GET | `/workflows/{workflow_id}/flow` | Read the canvas configuration |
| PUT | `/workflows/{workflow_id}/flow` | Save the canvas configuration as a draft |
| POST | `/workflows/{workflow_id}/validate` | Validate the canvas before publishing |
| GET | `/workflows/{workflow_id}/publication` | Read the published configuration |
| POST | `/workflows/{workflow_id}/publication` | Publish the current draft |
| DELETE | `/workflows/{workflow_id}/publication` | Unpublish the workflow |
| GET | `/workflows/{workflow_id}/export` | Export the canvas JSON |

### Publish a Workflow

- Typical Scenario
  A user finishes editing a retrieval workflow and makes it available to chat and downstream callers.

- Description
  Publishes the current draft. Saving a published workflow updates the draft only; publish again to make the new configuration effective.

- Method
  `POST`

- URI
  `/workflows/{workflow_id}/publication`

- Response Parameters
  | Parameter | Type | Description |
  | --- | --- | --- |
  | `version` | string | Published version identifier |

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `201` | Published; `Location` header points to the publication resource |
  | `400` | Draft is invalid |

## Query and Trace API

### Ask a Question

- Typical Scenario
  An agent or the Chat Test workspace asks a question against a published retrieval workflow.

- Description
  Executes the published workflow for the given question. When `stream` is `true`, the answer is returned as Server-Sent Events. The request may carry the conversation history and a conversation identifier so that follow-up questions reuse the context.

- Method
  `POST`

- URI
  `/query`

- Request Parameters
  | Parameter | Type | Required | Description |
  | --- | --- | --- | --- |
  | `question` | string | Yes | Question text |
  | `workflow_id` | string | No | Published workflow to execute |
  | `conversation_id` | string | Yes | Conversation identifier used to keep context across turns |
  | `stream` | boolean | No | `true` returns Server-Sent Events; default `false` |
  | `chat_history` | array | No | Previous turns of the conversation |
  | `include_retrieval` | boolean | No | Include the retrieval evidence of this turn in the response; default `false` |
  | `llm` | string | No | LLM model name; empty uses the workflow default |
  | `kwargs` | object | No | Additional parameters passed to the workflow |

- Request Example
  ```json
  {
    "question": "What is the archive period of the test environment?",
    "workflow_id": "<published workflow ID>",
    "conversation_id": "conv-001",
    "stream": true,
    "include_retrieval": true
  }
  ```

- Response Parameters
  With `stream: true`, a `text/event-stream` response carrying answer segments, retrieval evidence, and citations. With `stream: false`, a JSON object with the answer and, when `include_retrieval` is `true`, the retrieval evidence.

- Status Codes
  | Status Code | Description |
  | --- | --- |
  | `200` | Answer returned |
  | `400` | Invalid request or workflow not published |
  | `404` | Workflow not found |

### Query Traces

| Method | URI | Description |
| --- | --- | --- |
| GET | `/query-traces` | List query traces; optional `workflowId`, `conversationId`, `traceId`, `orgId`, and pagination |
| GET | `/query-traces/stats` | Trace statistics; optional `workflowId`, `orgId`, `from`, `to`, `bucket` (default `day`) |
| GET | `/query-traces/{trace_row_id}` | Trace detail, including retrieval evidence |

## Model API

| Method | URI | Description |
| --- | --- | --- |
| GET | `/models` | List registered models |
| GET | `/models/thinking-presets` | Thinking presets for LLM models |
| POST | `/models/test` | Test an unsaved model configuration |
| POST | `/models` | Register a model |
| GET | `/models/{model_id}` | Model detail |
| PUT | `/models/{model_id}` | Update a model |
| DELETE | `/models/{model_id}` | Delete a model |
| POST | `/models/{model_id}/test` | Test a saved model |

Model credentials are encrypted with `RKB_SECRET_KEY`. A model endpoint must be reachable from the backend container.

## Task API

| Method | URI | Description |
| --- | --- | --- |
| GET | `/tasks/stats` | Task statistics |
| GET | `/tasks/groups` | Task groups; optional `task_type`, `status`, `lane`, `kbase_id`, `keyword`, `page` (default 1), `size` (default 20) |
| GET | `/tasks` | List tasks with the same filters as task groups |
| GET | `/tasks/{task_id}` | Task detail |
| POST | `/tasks/{task_id}/cancel` | Cancel a task |
| POST | `/tasks/{task_id}/retry` | Retry a task |
| PATCH | `/tasks/{task_id}` | Update task attributes |

## Status Codes

| Status Code | Description |
| --- | --- |
| `200` | Request succeeded |
| `201` | Resource created; the `Location` header identifies it |
| `202` | Asynchronous work accepted |
| `204` | Request succeeded without a response body |
| `400` | Invalid request body or parameters |
| `401` | Authentication required or session invalid |
| `403` | `password_change_required`, `csrf_rejected`, or insufficient permission |
| `404` | Resource not found |
| `409` | Conflict, for example a duplicate knowledge base name |
| `500` | Internal error |

## Appendix

Error responses follow RFC 9457 and use the `application/problem+json` media type. The `code` field is stable and can be matched by clients; `title` and `detail` are human-readable. Health checks and sign-in are the only endpoints that do not require a session under `AUTH_MODE=local`.
