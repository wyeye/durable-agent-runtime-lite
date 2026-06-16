# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /repo
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY packages ./packages
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
RUN pnpm --filter @dar/control-plane build

# Serve static Vite build through unprivileged Nginx.
# The internal container port is 8080. Map it to host port 3100 in compose.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runner
COPY apps/control-plane/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/control-plane/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]
