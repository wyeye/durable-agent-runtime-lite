# Docker Deployment - Multiple Dockerfiles

## Strategy

Use one Dockerfile per production app:

```text
apps/control-plane/Dockerfile
apps/runtime-api/Dockerfile
apps/runtime-worker/Dockerfile
apps/tool-gateway/Dockerfile
```

All builds must use the repository root as the build context:

```bash
docker build -f apps/runtime-api/Dockerfile -t durable-agent-runtime/runtime-api:local .
```

This keeps each image explicit while preserving access to `packages/`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, and shared TypeScript configs.

## Local build

```bash
scripts/docker-build-all.sh
```

## Local run

```bash
docker compose -f infra/docker-compose.yml up --build
```

## Ports

| Service | Container port | Host port |
|---|---:|---:|
| control-plane | 8080 | 3100 |
| runtime-api | 3000 | 3000 |
| tool-gateway | 3200 | 3200 |
| runtime-worker | 3300 | 3300 |
| Temporal | 7233 | 7233 |
| Temporal UI | 8080 | 8233 |
| PostgreSQL | 5432 | 5432 |
| Valkey | 6379 | 6379 |

## Notes for Codex

When modifying Docker support:

1. Do not replace app-specific Dockerfiles with a single root Dockerfile.
2. Keep the root build context.
3. Do not introduce a fifth production image.
4. Do not place secrets in Dockerfiles or compose files.
5. Update `.env.example` and app docs when new environment variables are introduced.
6. Validate `/healthz` and `/readyz` after changing startup behavior.
