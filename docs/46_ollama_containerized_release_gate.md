# Ollama Containerized Release Gate

This is the AR-2A-RC local release gate for proving the real runtime path with a host Ollama model and four Dockerized production apps.

## Status

Current status: `AR-2A IMPLEMENTATION COMPLETE`.

The local containerized Ollama final, readonly, and L3 gate passed, and remote CI/Integration passed on `origin/main@27598fe`.

No tag, GitHub Release, or version promotion has been performed. Keep the platform version at `0.8.0` during development.

## Runtime Shape

The gate requires:

- `control-plane`, `runtime-api`, `runtime-worker`, and `tool-gateway` run from Docker images.
- PostgreSQL, Valkey, Temporal, and Temporal UI run from Docker Compose.
- Ollama runs on the host machine only.
- The host model is exactly `qwen2.5:7b-instruct-q4_K_M`.
- `runtime-worker` uses `PI_AGENT_MODE=model_gateway`.
- `runtime-worker` uses `MODEL_GATEWAY_BASE_URL=http://host.docker.internal:11434/v1`.
- `mock-server` is not running.
- deterministic Pi is not enabled.

Host-built runtime smokes prove current source behavior, but they do not prove image provenance. This gate proves the request path goes through the app containers by checking Docker container health, `/version` build metadata, runtime-worker model gateway environment, and DB evidence.

## Build

Build from the repository root:

```bash
APP_VERSION=$(node -p "require('./package.json').version")
BUILD_SHA=$(git rev-parse HEAD)
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

docker compose -f infra/docker-compose.yml build \
  --build-arg APP_VERSION="$APP_VERSION" \
  --build-arg BUILD_SHA="$BUILD_SHA" \
  --build-arg BUILD_TIME="$BUILD_TIME" \
  control-plane runtime-api runtime-worker tool-gateway
```

When testing uncommitted changes locally, use a dirty build id:

```bash
BUILD_SHA="$(git rev-parse HEAD)-dirty"
```

All four Dockerfiles expose OCI labels and `/version` returns:

```json
{
  "service": "runtime-worker",
  "version": "0.8.0",
  "build_sha": "...",
  "build_time": "..."
}
```

Runner images use a trimmed workspace layout: package `dist`, package `package.json`, production dependency symlinks, and app `dist`. They must not copy `.git`, `.env`, tests, app source, package source, or Ollama models.

## Ollama Prerequisites

```bash
ollama --version
ollama list
ollama show qwen2.5:7b-instruct-q4_K_M
curl --fail --silent http://localhost:11434/api/tags
curl --fail --silent http://localhost:11434/v1/models
corepack pnpm ollama:probe
```

Do not substitute `latest`, an unquantized model, deterministic Pi, or mock-server.

## Start The Stack

```bash
docker compose -f infra/docker-compose.yml up -d postgres valkey temporal temporal-ui
corepack pnpm db:migrate
SEED_LOCAL_OLLAMA_MODEL_POLICY=true corepack pnpm seed:examples

docker compose \
  -f infra/docker-compose.yml \
  -f infra/docker-compose.ollama.yml \
  up -d tool-gateway runtime-worker runtime-api control-plane
```

Then assert container provenance:

```bash
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm runtime:assert-containerized
```

For uncommitted local gate runs:

```bash
BUILD_SHA="$(git rev-parse HEAD)-dirty" corepack pnpm runtime:assert-containerized
```

## Container E2E

Run the full Ollama container gate:

```bash
BUILD_SHA="$(git rev-parse HEAD)" corepack pnpm smoke:ollama-containerized-e2e
```

The command runs:

1. `corepack pnpm ollama:probe`
2. `corepack pnpm runtime:assert-containerized`
3. `corepack pnpm smoke:ollama-runtime-final-e2e`
4. `corepack pnpm smoke:ollama-runtime-readonly-e2e`
5. `corepack pnpm smoke:ollama-runtime-l3-e2e`
6. DB checks for `task_run`, `agent_run`, `model_call_log`, `model_call_attempt`, `tool_call_log`, `human_task`, `audit_event`, and `idempotency_record`
7. log checks for no deterministic or mock model gateway markers

Expected evidence:

- final: one completed TaskRun and AgentRun, one successful `local-ollama` model call, no tool call.
- readonly: at least two successful model calls, exactly one `knowledge.search` tool call, exactly one idempotency record.
- L3: at least two successful model calls, exactly one `record.write.mock` tool call, one approved Human Task, one committed tool call, one idempotency record.

## Build Troubleshooting

This repository can be slow on Docker classic builder because the local Docker installation may not have the buildx plugin and therefore cannot use BuildKit cache mounts. In that case:

- `docker compose` prints `Docker Compose requires buildx plugin to be installed`.
- `RUN --mount=type=cache` is not usable.
- Each app Dockerfile may download pnpm dependencies when `COPY packages ./packages` changes.

Do not increase timeouts blindly. Check buildx availability, pnpm store behavior, and whether a package change invalidated the dependency layer.

`pnpm deploy` was evaluated, but pnpm 10 requires lockfile settings that this repository does not currently use. The Dockerfiles therefore use frozen workspace install, app build, production prune, offline production symlink restore, and a trimmed runtime package copy.

## GitHub Workflows

Ordinary hosted CI and Integration must not download or run the 7B Ollama model. Integration continues to use deterministic/mock gateway smoke paths.

The optional workflow `.github/workflows/ollama-runtime.yml` is manual only:

```text
workflow_dispatch
runs-on: [self-hosted, ollama]
```

The self-hosted runner must already have Docker, Ollama, and `qwen2.5:7b-instruct-q4_K_M`.

## Development Completion Rule

AR-2A implementation evidence requires:

- four production images build;
- container provenance assertion passes;
- containerized Ollama final/readonly/L3 pass;
- readonly and L3 have second-turn real model call evidence;
- no mock-server or deterministic runtime is used;
- old smoke, Pi smoke, tenant/deep-chain smoke, crash recovery, and replay pass;
- latest CI and latest Integration pass on the committed diff.

This status does not imply a package version bump, Git tag, or GitHub Release.
