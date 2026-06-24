# Technology Stack

当前 v1.5 技术基线：

| Area | Baseline |
| --- | --- |
| Runtime | Node.js 24 LTS |
| Package manager | `pnpm` workspace |
| Build | Turborepo |
| Language | TypeScript 5.x strict |
| Backend | Fastify 5.x, Zod 4 |
| Frontend | React 19, Vite, Ant Design |
| DB | PostgreSQL 17, pgvector, Kysely |
| Cache | Valkey 8.x |
| Durable execution | Temporal TypeScript SDK |
| Agent loop | Pi Agent Loop |
| Telemetry/logging | OpenTelemetry, Pino |
| Test | Vitest, Playwright |

不要在未获明确批准时切换框架、ORM、package manager、测试框架或语言运行时。
