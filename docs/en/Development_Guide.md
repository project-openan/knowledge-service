# Development Guide

## Feature Overview

OpenAN Knowledge Service provides document and graph knowledge bases, retrieval workflow orchestration, and question answering over the knowledge bases. The repository contains the Knowledge Studio web application, the FastAPI backend, and the deployment assets. This guide is for developers who extend the backend, add REST endpoints, work on the web application, or build the service into a deployment. For user-facing behavior, see the [User Guide](User_Guide.md).

## Constraints and Limitations

- The backend requires Python 3.11 and runs on Linux; the frontend requires Node.js 22.
- The main application does not expose `/openapi.json` or `/docs`. The external OpenAPI contract is generated from the route table and pinned by snapshot tests.
- Route registration order is part of the API contract. FastAPI matches in registration order, and the OpenAPI generator emits paths in the same order. The composition root registers domain routers before the catch-all route.
- Business errors use RFC 9457 problem details with the `application/problem+json` media type. Successful responses follow the status codes declared by each router, including `201` for creation, `202` for accepted asynchronous work, and `204` for deletion.
- Under `AUTH_MODE=local`, business `POST`, `PUT`, `PATCH`, and `DELETE` requests that carry the session cookie require the host and port of `Origin` or `Referer` to match the request address. Under `AUTH_MODE=none` local authentication is disabled; under `AUTH_MODE=gateway` a trusted front proxy verifies identity.
- `POST /query` with `stream: true` returns Server-Sent Events. A reverse proxy in front of the web port must disable response buffering for this path.
- OpenSearch requires `vm.max_map_count` of at least `262144` on the Docker Linux host.

## Environment Preparation

### Environment Requirements

| Component | Requirement |
| --- | --- |
| Backend runtime | Python 3.11 on Linux |
| Frontend runtime | Node.js 22 |
| Database | PostgreSQL with pgvector, provided by the Compose deployment |
| Search | OpenSearch, provided by the Compose deployment |
| Container runtime | Docker Engine with Docker Compose v2 |

### Setting Up the Environment

The backend commands run in `backend/`.

```bash
python -m pip install -r requirements.txt -r requirements-dev.txt
```

The frontend commands run in `frontend/`.

```bash
npm ci
```

### Verifying the Environment Setup

Compile and lint the backend, then run both test suites.

```bash
python -m compileall -q src tests
ruff check src tests
python -m pytest tests -q
python -m pytest src/ingestion/tests -q
```

Start the frontend development server and run its unit tests.

```bash
npm run serve
npm run test:unit
```

The development page is served at `http://localhost:8808` and proxies API requests to `http://localhost:8091` by default. Set `VUE_APP_API` in `frontend/.env.local` to point at another backend. The production build is written to `frontend/dist/`.

## Usage Scenario: Extending the Backend

### Scenario Overview

A backend change usually adds or modifies one REST domain, for example a new endpoint on the knowledge base domain or a new domain module. The backend is organized by domain so that routes, services, repositories, and domain rules stay together.

### System Architecture

At deployment time, four Compose services run: `postgresql` with pgvector, `opensearch`, `backend`, and `web`. The web service serves the built frontend and forwards same-origin `/api/knowledge-service/v1` requests to the backend. The backend owns the REST surface and talks to PostgreSQL for business data and vectors and to OpenSearch for keyword retrieval. Knowledge base files are written to the `kbdata` volume.

The backend source is organized by domain under `backend/src/`. Every external path is relative to the `/api/knowledge-service/v1` prefix.

| Module | Responsibility |
| --- | --- |
| `system` | Health check, deployment information, model and file-size metadata |
| `auth` | Local accounts, sessions, password change, authentication middleware |
| `knowledge_base` | Knowledge base metadata, directories, documents, chunks, graph bridge |
| `retrieval` | Document retrieval endpoint and retrieval services |
| `graph` | Graph schemas, extraction, import, graph query, entity and relation editing, export |
| `chat` | Orchestrated `POST /query`, query traces |
| `workflow` | Retrieval workflow family under `/workflows` |
| `model` | Model registry and management under `/models` |
| `operators` | Operator registry, publishing, visibility, templates |
| `operator_api` | Sandbox APIs exposed to operators |
| `ingestion` | Parsing, splitting, vectorization, and index writing pipeline |
| `parsing` | Document parsers and block splitters |
| `engine` | Shared engine services: gateways, retrieval evidence, utilities |
| `infrastructure` | Database, search, HTTP, filesystem, logging, cache, i18n |
| `shared` | Prefixes, chunk schema, error model, problem details |

The composition root is `backend/src/http_api.py`. It registers, in order: system, knowledge base collection routes, retrieval, knowledge base content routes, operators, graph routes, chat query routers, workflow routes, model routes, and authentication routes. The catch-all route is registered last.

### Development Flow

1. Locate the owning domain module and read its `api.py` or `router.py` plus the related `service/` and `repository/` packages.
2. Add or modify the endpoint in the domain router. Raise domain errors defined by the module so that the shared handlers return problem details.
3. If the change introduces a new domain module, call its `build_router()` from `http_api.py` before the catch-all registration. Keep the registration order stable when inserting a route into an existing domain, because the order is part of the OpenAPI contract.
4. Add tests next to the existing suites: `backend/tests/` for cross-domain and contract tests, `backend/src/ingestion/tests/` for the ingestion pipeline.
5. Run the verification commands from the previous section. Keep the OpenAPI snapshot test passing when routes are added or changed.

### Interface Description

The full REST surface, grouped by domain, is documented in the [API Reference](API_Reference.md). All paths are relative to `/api/knowledge-service/v1`. Authentication uses the `openan_session` cookie under `AUTH_MODE=local`. Errors are returned as `application/problem+json`.

## Usage Scenario: Working on the Web Application

The web application is a Vue single-page project under `frontend/`. The development server runs on port `8808` and proxies API calls to `8091`. The workspaces are routed as `/#/knowledge`, `/#/graph`, `/#/flow`, `/#/chat`, and `/#/models`.

1. Install dependencies with `npm ci`.
2. Start the development server with `npm run serve`.
3. Run unit tests with `npm run test:unit`.
4. Build production assets with `npm run build`; the output goes to `frontend/dist/`.

The web build path defaults to `/`. When `WEB_BASE_URL` is set to a sub-path, rebuild the web application so that its asset paths match the deployment.

## Build and Deployment

The deployment assets are in `deploy/`. `docker-compose.yml` defines the four services and the `pgdata`, `osdata`, `kbdata`, and `rkbdata` volumes; `.env.example` lists the environment variables. The backend image is built from `backend/Dockerfile`, and the web image serves the built frontend.

To rebuild after a code change on the deployment host:

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build --wait
```

Health checks and acceptance steps are described in the [User Guide](User_Guide.md).

## License

The project is released under the Apache License 2.0. The frontend and the extended backend are based on the Co-Knowledge migration from the upstream project. See [LICENSE](../../LICENSE), [NOTICE](../../NOTICE), and [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) for details.
