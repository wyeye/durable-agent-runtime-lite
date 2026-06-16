# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/runtime-api/package.json apps/runtime-api/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @dar/runtime-api build
# Create a production-only deployable package for this workspace app.
# If pnpm deploy is not yet configured in the repo, Codex should either add it
# or replace this with an equivalent pruned production install.
RUN pnpm deploy --filter @dar/runtime-api --prod /out/runtime-api

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app app
COPY --from=builder /out/runtime-api/ ./
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
