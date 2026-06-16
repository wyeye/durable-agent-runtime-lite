#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

build_one() {
  local app="$1"
  local tag="$2"
  echo "==> Building ${tag} using apps/${app}/Dockerfile"
  docker build -f "apps/${app}/Dockerfile" -t "${tag}" .
}

build_one control-plane durable-agent-runtime/control-plane:local
build_one runtime-api durable-agent-runtime/runtime-api:local
build_one runtime-worker durable-agent-runtime/runtime-worker:local
build_one tool-gateway durable-agent-runtime/tool-gateway:local

echo "All production app images built successfully."
