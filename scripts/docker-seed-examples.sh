#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DATABASE_URL="${DATABASE_URL:-postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime}" \
  corepack pnpm seed:examples
