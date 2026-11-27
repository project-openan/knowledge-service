# User Guide

## Module/Feature Overview

OpenAN Knowledge Service provides document and graph knowledge bases, retrieval workflow orchestration, and question answering over the knowledge bases. It consists of the Knowledge Studio web application and a FastAPI backend. PostgreSQL with pgvector stores business data and vectors, and OpenSearch provides keyword retrieval.

The service is used when an operations or development team needs a shared, verifiable knowledge base built from its own documents, and needs retrieval results that can be inspected, composed into workflows, and consumed by agents or applications through REST APIs.

### Use Cases

- Build a document knowledge base from product manuals, maintenance records, or standards, and retrieve the relevant fragments for a question.
- Build a graph knowledge base from a domain ontology, extract entities and relations from documents, and answer questions that require relationship traversal.
- Compose keyword, vector, and graph retrieval into a workflow, publish it, and let an agent or a downstream system call it through `POST /query`.
- Register and test model endpoints (LLM, Embedding, Reranker) so that ingestion and answer generation use the provider chosen by the deployment.

### Feature Summary

| Workspace | Default entry | Capabilities |
| --- | --- | --- |
| Document Knowledge Base | `/#/knowledge` | Create knowledge bases and directories, import and process documents, view chunks, download source files, retry failed documents |
| Graph Knowledge Base | `/#/graph` | Manage ontology templates, extract from documents or import graphs, query, visualize, edit, and export entities and relations |
| Knowledge Retrieval | `/#/flow` | Compose keyword, vector, or graph retrieval on a canvas; save drafts, validate, publish, and unpublish |
| Chat Test | `/#/chat` | Select a published retrieval workflow and view streamed answers, retrieval evidence, and citations |
| Model Management | `/#/models` | Register, enable, disable, and test LLM, Embedding, and Reranker models; set default models |

### Basic Concepts

| Concept | Description |
| --- | --- |
| Knowledge base | A container for documents or graph data. `POST /knowledge-bases` creates a document knowledge base by default; `?type=graph` creates a graph knowledge base |
| Directory | A folder inside a knowledge base used to organize documents |
| Document | A Markdown, TXT, DOCX, or other supported file imported into a knowledge base. Each document has a processing status; a failed document can be reprocessed without re-uploading |
| Chunk | A fragment produced by splitting a document. Chunks are vectorized and indexed, and retrieval returns chunks as evidence |
| Operator | A processing step used during ingestion and orchestration. Operators are listed and configured through the `/operators` APIs |
| Retrieval workflow | A canvas configuration of retrieval nodes. A workflow is saved as a draft, validated, and then published; only a published workflow can be selected for chat |
| Query trace | A record of a query execution, including retrieval evidence and timing, readable through `/query-traces` |
| Model | An LLM, Embedding, or Reranker endpoint registered in Model Management. The backend encrypts credentials with `RKB_SECRET_KEY` |

### How It Works

Document ingestion runs four stages: parsing, splitting, vectorization, and index writing. A document becomes available only after all stages succeed. Embedding uses the model configured for the knowledge base; keyword indexing writes to OpenSearch.

Retrieval supports three modes: vector retrieval over chunks, keyword retrieval over the OpenSearch index, and graph retrieval that finds seed nodes by vector similarity and then propagates through relations by depth. `POST /retrieval` performs document retrieval directly, and `POST /knowledge-bases/{kbase_id}/graph/query` performs graph retrieval.

Question answering executes a published retrieval workflow. `POST /query` accepts a `workflow_id` and a `conversation_id`; when `stream` is `true` the answer is returned as Server-Sent Events, with retrieval evidence and citations included in the stream.

## Installation

### Prerequisites

- A Linux host with Docker Engine and Docker Compose v2 that supports `up --wait`
- `curl` for health checks
- Repository checkout containing `backend/`, `frontend/`, and `deploy/docker-compose.yml`
- Network access to image registries, PyPI, and npm for the first build, or mirror settings in the environment file
- Host ports `8080` (web) and `8091` (backend) available
- On Linux, `vm.max_map_count` at least `262144` for OpenSearch

### Getting Started

All commands run in the repository root on the deployment host.

1. Verify the deployment environment.

   ```bash
   docker version
   docker compose version
   ```

2. Prepare the environment file. Copy the example and fill in `POSTGRES_PASSWORD`, `RKB_DB_PASSWORD`, and `RKB_SECRET_KEY`.

   ```bash
   (
     umask 077
     cp -n deploy/.env.example deploy/.env
   )
   ```

   An agent or CI job can generate the three required values with OpenSSL. The command creates the file only when it does not exist. Existing deployments keep their environment file, Compose project name, and data volumes.

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

3. Start the services and check them.

   ```bash
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml config --quiet
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build --wait
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps

   curl -fsSL --retry 5 --retry-connrefused -o /dev/null http://localhost:8080/
   curl -fsS --retry 5 --retry-connrefused http://localhost:8091/api/knowledge-service/v1/health
   curl -fsS --retry 5 --retry-connrefused http://localhost:8080/api/knowledge-service/v1/health
   ```

   For an external deployment, point an HTTPS reverse proxy at the web port. The web service forwards same-origin API requests to the backend. When the proxy forwards `POST /api/knowledge-service/v1/query`, disable response buffering so that SSE answers are delivered incrementally.

4. Sign in and accept the deployment. Open `http://localhost:8080/#/knowledge`, or the web address of the target server. The default administrator user name is `admin`. On a new database, if `RKB_ADMIN_PASSWORD` is empty, the service generates a random initial password that can be read on the deployment host:

   ```bash
   docker compose --env-file deploy/.env -f deploy/docker-compose.yml \
     exec backend cat /data/rkb/initial-admin-password
   ```

   Change the password when prompted after the first sign-in. The password file is deleted after the change succeeds. If `RKB_ADMIN_PASSWORD` is set, use that value instead. An existing database keeps its existing accounts.

   Accept the deployment with two checks: all four Compose services run, the web home page is reachable, and both health endpoints return `ok`; then import a real document with a working model and confirm that the document status becomes available and its chunks can be retrieved.

## Usage

### Prerequisites

- The deployment is running and the administrator password has been changed
- At least one Embedding model endpoint is reachable from the backend container; an LLM endpoint is required for generated answers

### Register a Model

1. Open `/#/models` and add an Embedding endpoint: base URL, provider model identifier, vector dimension, and credentials.
2. Test the connection. Add and test an LLM model to generate answers, and a Reranker model when a workflow contains a reranking node.

### Create a Knowledge Base and Import Documents

1. Open `/#/knowledge`, create a knowledge base, and select the registered Embedding model.
2. Open the documents page and import a text-bearing Markdown, TXT, or DOCX file.
3. Wait until the document status becomes available, then inspect the chunk count and content. If processing fails, choose reprocess from the document menu; the source file does not need to be uploaded again.

### Build a Graph Knowledge Base

1. Create a knowledge base with `POST /knowledge-bases?type=graph`, or open the graph workspace at `/#/graph`.
2. Manage ontology templates through the graph schema pages: create, update, import, and delete schemas.
3. Submit a graph extraction on a document, or import an existing graph.
4. Query, visualize, edit, and export entities and relations. Exported graphs can be archived or loaded into another environment.

### Compose a Retrieval Workflow

1. Open `/#/flow`, create a workflow, and bind retrieval nodes to the target knowledge bases.
2. Configure Embedding or generation models according to the selected nodes.
3. Save and validate the workflow, then publish it from the list. Saving a published workflow updates the draft only; republish to make the new configuration effective.

### Test with Chat

1. Open `/#/chat` and select a published workflow.
2. Ask a question and inspect the streamed answer, retrieval evidence, and citations.

### Verify Retrieval with the API

All paths are relative to `/api/knowledge-service/v1`. Connect directly to `http://localhost:8091`, or use the same-origin proxy at `http://localhost:8080`. Under the default `AUTH_MODE=local`, sign in with an account whose password has been changed. Sign-in returns an HttpOnly session cookie named `openan_session`. For business `POST`, `PUT`, `PATCH`, and `DELETE` requests that carry the session, the host and port of `Origin` or `Referer` must match the request address.

```bash
studio=http://localhost:8080
api="$studio/api/knowledge-service/v1"
cookies="$(mktemp)"
trap 'rm -f "$cookies"' EXIT

read -rsp 'Administrator password: ' studio_password
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
  "question": "What is the archive period of the test environment?",
  "model": "<registered embedding model name>",
  "type": 0,
  "bases": [{"baseList": ["doc_<knowledge base ID>"], "priority": 0, "top_k": 3}]
}
JSON
```

`type: 0` is vector retrieval; use `type: 1` for keyword retrieval. The `doc_` prefix is required by document retrieval; the `id` returned by the knowledge base list does not include it. The response returns `baseName` and `docs` per knowledge base, where `docs` contains the matched fragments.

## Administration

### Authentication Modes

| `AUTH_MODE` | Behavior |
| --- | --- |
| `local` | Default. Local accounts with session cookies |
| `none` | Local authentication disabled |
| `gateway` | Identity is verified by a trusted front proxy that also handles identity headers |

### Configuration Reference

The complete configuration is in [deploy/docker-compose.yml](../../deploy/docker-compose.yml) and [deploy/.env.example](../../deploy/.env.example).

| Variable | Purpose |
| --- | --- |
| `POSTGRES_PASSWORD`, `RKB_DB_PASSWORD` | Required. Password of the database administrator and of the application database role |
| `RKB_SECRET_KEY` | Required. Encrypts model credentials. Keep the same key when restoring an existing database |
| `RKB_ADMIN_USERNAME`, `RKB_ADMIN_PASSWORD` | Administrator account for a new database. User name defaults to `admin`; an empty password is generated automatically |
| `AUTH_MODE` | Defaults to `local`; `none` disables local authentication; `gateway` relies on a trusted front proxy |
| `WEB_PORT`, `KNOWLEDGE_BASE_PORT` | Host ports, default `8080` and `8091` |
| `WEB_BASE_URL` | Web build path, default `/`. A sub-path requires rebuilding the web application |
| `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION` | Deployment-level defaults for the vector model and dimension. Names and dimensions do not start a model endpoint |
| `MODEL_GATEWAY_URL`, `GENERATION_GATEWAY_URL`, `RERANK_URL` | Optional preconfigured Embedding, LLM, and Reranker endpoints; models can also be registered in Model Management |
| `RKB_STORAGE_BACKEND` | Defaults to `local`; knowledge base files are written to `/data/kb` |

The default Compose volumes are `pgdata` (business data and vectors), `osdata` (search index), `kbdata` (knowledge base files), and `rkbdata` (logs and other runtime files). A plain `docker compose down` keeps the volumes; adding `-v` deletes them.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| OpenSearch fails to start | On the Docker Linux host, check `vm.max_map_count`. If it is below `262144`, run `sudo sysctl -w vm.max_map_count=262144` for a temporary adjustment |
| API returns `403 password_change_required` after the first sign-in | Change the password in the page first, then sign in again with the new password |
| API returns `403 csrf_rejected` | Make `Origin` or `Referer` match the actual request address |
| A document shows vectorization failed | Check the model, endpoint, credentials, and vector dimension of the knowledge base, then choose reprocess |
| Chat test cannot find a workflow, or uses an old configuration | Publish the workflow from Knowledge Retrieval; use republish after updating the draft |
| Processing logs are needed | Run `docker compose --env-file deploy/.env -f deploy/docker-compose.yml logs -f backend` |
