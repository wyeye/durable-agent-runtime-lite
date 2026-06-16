# Docker Deployment Templates - Multiple Dockerfiles

This template switches the Docker deployment strategy from one generic root Dockerfile to four app-specific Dockerfiles.

Production Dockerfiles:

```text
apps/control-plane/Dockerfile
apps/runtime-api/Dockerfile
apps/runtime-worker/Dockerfile
apps/tool-gateway/Dockerfile
```

Important rule: use the repository root as Docker build context:

```bash
docker build -f apps/runtime-api/Dockerfile -t durable-agent-runtime/runtime-api:local .
```

Do not build with `apps/runtime-api` as the context, because workspace packages and lockfiles live at the repository root.
