# OpenAN Knowledge Service

OpenAN 知识服务提供知识库和目录管理、文档解析及文本切片。

## 本地启动

需要 Docker 和 Docker Compose。复制 `deploy/.env.example` 为 `deploy/.env`，
填写数据库和应用账号凭据，然后从仓库根目录运行。

```sh
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build
```

服务默认监听 8091。可以用健康检查确认后端已启动。

```sh
curl http://localhost:8091/api/knowledge-service/v1/health
```

文档解析和切片可通过后端模块调用。HTTP 接口提供知识库和目录管理。

## 后端测试

在 Linux 环境的 `backend/` 目录下用 Python 3.11 安装依赖并运行测试。

```sh
python -m pip install -r requirements.txt -r requirements-dev.txt
python -m compileall -q src tests
python -m pytest tests -q
```

## 许可

Apache-2.0。版权与归属声明见 [NOTICE](NOTICE)。
