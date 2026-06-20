# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/tool-gateway/package.json apps/tool-gateway/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @dar/tool-gateway... --workspace-concurrency=1 build && \
  test -f apps/tool-gateway/dist/index.js && \
  CI=true pnpm prune --prod && \
  pnpm --filter @dar/tool-gateway... install --prod --frozen-lockfile --offline && \
  mkdir -p /repo/runtime-packages && \
  for package_dir in packages/*; do \
    package_name="$(basename "$package_dir")"; \
    if [ -d "$package_dir/dist" ]; then \
      mkdir -p "/repo/runtime-packages/$package_name"; \
      cp "$package_dir/package.json" "/repo/runtime-packages/$package_name/package.json"; \
      cp -R "$package_dir/dist" "/repo/runtime-packages/$package_name/dist"; \
      if [ -d "$package_dir/node_modules" ]; then cp -R "$package_dir/node_modules" "/repo/runtime-packages/$package_name/node_modules"; fi; \
    fi; \
  done

FROM node:24-bookworm-slim AS runner
ARG APP_VERSION=0.8.0
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.revision="${BUILD_SHA}" \
  org.opencontainers.image.created="${BUILD_TIME}" \
  org.opencontainers.image.source="https://github.com/wyeye/durable-agent-runtime-lite"
ENV NODE_ENV=production
ENV APP_VERSION=${APP_VERSION}
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}
ENV HOST=0.0.0.0
ENV PORT=3200
WORKDIR /repo/apps/tool-gateway
RUN groupadd --system app && useradd --system --gid app app
COPY --from=builder --chown=app:app /repo/package.json /repo/pnpm-lock.yaml /repo/pnpm-workspace.yaml /repo/
COPY --from=builder --chown=app:app /repo/node_modules /repo/node_modules
COPY --from=builder --chown=app:app /repo/runtime-packages /repo/packages
COPY --from=builder --chown=app:app /repo/apps/tool-gateway/package.json /repo/apps/tool-gateway/package.json
COPY --from=builder --chown=app:app /repo/apps/tool-gateway/dist /repo/apps/tool-gateway/dist
COPY --from=builder --chown=app:app /repo/apps/tool-gateway/node_modules /repo/apps/tool-gateway/node_modules
USER app
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3200') + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
