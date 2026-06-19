FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY devtools/mock-server ./devtools/mock-server
RUN pnpm install --frozen-lockfile --filter @dar/mock-server...

FROM deps AS build
RUN pnpm --filter @dar/mock-server build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100
RUN corepack enable
COPY --from=build /app /app
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "devtools/mock-server/dist/index.js"]
