# Docker Deployment

生产 app 都有独立 Dockerfile：

```text
apps/control-plane/Dockerfile
apps/runtime-api/Dockerfile
apps/runtime-worker/Dockerfile
apps/tool-gateway/Dockerfile
```

所有 build context 必须是仓库根目录：

```bash
docker build -f apps/runtime-api/Dockerfile -t durable-agent-runtime/runtime-api:local .
```

本地集成栈：

```bash
docker compose -f infra/docker-compose.yml config
docker compose -f infra/docker-compose.yml up --build
```

默认端口：

| Service | URL |
| --- | --- |
| control-plane | http://localhost:3100 |
| runtime-api | http://localhost:3000 |
| tool-gateway | http://localhost:3200 |
| runtime-worker | http://localhost:3300 |
| Temporal UI | http://localhost:8233 |
| PostgreSQL | localhost:15432 |
| Valkey | localhost:16380 |

Pi smoke 使用 development/test override：

```bash
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml config
docker compose -f infra/docker-compose.yml -f infra/docker-compose.pi-smoke.yml up -d mock-server tool-gateway runtime-worker runtime-api control-plane
```

该 override 会把 `runtime-worker` 指向 `mock-server` 的 OpenAI-compatible API。`mock-server` 不在 production compose 中。

Ollama gate 是手动/self-hosted 路径：Ollama 在宿主机，四个生产 app 来自 Docker 镜像。

本地开发若要直接走这条链路，优先使用 `corepack pnpm dar dev up --ollama`；开发态 seed 和聊天验证步骤见 [Local Development](./local-development.md)。

```bash
ollama show qwen2.5:7b-instruct-q4_K_M
corepack pnpm ollama:probe
docker compose -f infra/docker-compose.yml -f infra/docker-compose.ollama.yml config
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm runtime:assert-containerized
corepack pnpm dar smoke suite real
```
