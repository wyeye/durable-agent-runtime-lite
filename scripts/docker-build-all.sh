#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_VERSION="${APP_VERSION:-$(node -p "require('./package.json').version")}"
BUILD_SHA="${BUILD_SHA:-$(git rev-parse HEAD)}"
BUILD_TIME="${BUILD_TIME:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"

build_one() {
  local app="$1"
  local tag="$2"
  echo "==> Building ${tag} using apps/${app}/Dockerfile"
  docker build \
    --build-arg "APP_VERSION=${APP_VERSION}" \
    --build-arg "BUILD_SHA=${BUILD_SHA}" \
    --build-arg "BUILD_TIME=${BUILD_TIME}" \
    -f "apps/${app}/Dockerfile" \
    -t "${tag}" \
    .
}

build_one control-plane durable-agent-runtime/control-plane:local
build_one runtime-api durable-agent-runtime/runtime-api:local
build_one runtime-worker durable-agent-runtime/runtime-worker:local
build_one tool-gateway durable-agent-runtime/tool-gateway:local

echo "All production app images built successfully."
