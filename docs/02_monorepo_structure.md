# 02 项目结构目录规范

```text
durable-agent-runtime-lite/
├── apps/
│   ├── control-plane/
│   ├── runtime-api/
│   ├── runtime-worker/
│   └── tool-gateway/
├── packages/
│   ├── contracts/
│   ├── config/
│   ├── db/
│   ├── logger/
│   ├── telemetry/
│   ├── security/
│   └── temporal/
├── db/
│   ├── migrations/
│   └── seeds/
├── examples/
│   ├── flows/
│   ├── routes/
│   ├── agents/
│   ├── prompts/
│   └── tools/
├── infra/
│   ├── docker-compose.yml
│   ├── k8s/
│   └── otel/
├── tests/
│   ├── contract/
│   ├── integration/
│   └── e2e/
├── docs/
└── scripts/
```

## 每个 app 内部目录

```text
apps/<app>/
├── src/
│   ├── bootstrap.ts
│   ├── index.ts
│   ├── config/
│   ├── modules/
│   ├── routes/
│   ├── clients/
│   ├── repositories/
│   ├── services/
│   └── utils/
├── tests/
│   ├── unit/
│   └── integration/
├── docs/
│   ├── DEV_PLAN.md
│   ├── DEV_SPEC.md
│   └── API.md
├── package.json
└── tsconfig.json
```

`runtime-worker` 可以增加：

```text
src/workflows/
src/activities/
src/pi/
src/interpreter/
src/temporal/
```

`control-plane` 如果采用前后端合并，可以增加：

```text
src/pages/ 或 src/app/
src/components/
src/api/
src/server/
```
