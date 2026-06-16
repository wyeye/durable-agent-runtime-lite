# 01 整体开发规范

## 1. 技术栈定版

从 v1.5 起，默认技术栈统一为：Node.js 24 LTS、TypeScript 5.x、pnpm workspace、Fastify 5.x、React 19 + Vite 8 + Ant Design 6、Zod 4、PostgreSQL 17 + pgvector、Kysely、Valkey 8.x、Temporal TypeScript SDK、Pi、OpenTelemetry + Pino。详细矩阵见 `docs/11_technology_stack_matrix.md`。

## 1. 技术栈建议

- 语言：TypeScript 5.x。
- 运行时：Node.js 20 LTS。
- 包管理：pnpm workspace。
- 后端框架：Fastify 或 NestJS 二选一；默认建议 Fastify，轻量、插件化、适合网关和运行时服务。
- 校验：Zod 作为入参、配置、事件、工具 Schema 的运行时校验层。
- 数据库：PostgreSQL，向量召回一期可用 pgvector。
- 工作流：Temporal TypeScript SDK。
- Agent Loop：Pi，通过 `runtime-worker` 内部封装，不在业务服务中散落调用。
- 可观测：OpenTelemetry + 结构化 JSON 日志。

## 2. Monorepo 规范

### 2.1 包边界

- `apps/*`：可独立启动和部署的应用。
- `packages/contracts`：跨服务共享 DTO、Zod Schema、错误码、事件定义。
- `packages/config`：环境变量、配置加载、配置校验。
- `packages/db`：数据库连接、Repository 基类、迁移辅助。
- `packages/logger`：统一日志。
- `packages/telemetry`：OpenTelemetry 初始化。
- `packages/security`：租户、身份、签名、权限上下文工具函数。
- `packages/temporal`：Temporal client、task queue 名称、workflow payload 类型。

### 2.2 依赖方向

允许：`apps -> packages`。
禁止：`packages -> apps`，`apps/control-plane -> apps/runtime-worker` 这类跨 app 直接引用。
跨服务通信必须通过 HTTP API、事件、数据库只读视图或 SDK Client，不允许直接 import 另一个 app 的内部代码。

## 3. API 规范

### 3.1 统一请求头

- `X-Request-Id`：全链路请求 ID。
- `X-Tenant-Id`：租户 ID。
- `X-User-Id`：用户 ID。
- `X-Idempotency-Key`：有副作用请求必须携带。

### 3.2 统一响应结构

```json
{
  "success": true,
  "data": {},
  "error": null,
  "trace_id": "trace_xxx"
}
```

错误响应：

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "FLOW_NOT_FOUND",
    "message": "流程不存在或不可用",
    "details": {}
  },
  "trace_id": "trace_xxx"
}
```

## 4. 配置规范

- 所有环境变量必须在 `packages/config` 中声明 Schema。
- 禁止在代码中直接读取未校验的 `process.env.X`。
- 本地配置放 `.env.local`，示例配置放 `.env.example`。
- 密钥不入库，不进 Git，不写日志。

## 5. 日志规范

每条日志至少包含：

```text
trace_id, request_id, tenant_id, user_id, app, module, operation, status, duration_ms
```

禁止记录明文 Token、密钥、敏感业务数据。需要定位问题时记录引用 ID 或脱敏值。

## 6. 测试规范

- 单元测试覆盖核心纯函数、Schema、策略判断。
- 集成测试覆盖数据库、Temporal、Tool Gateway 调用。
- 契约测试覆盖跨服务 API 与事件 Schema。
- E2E 测试覆盖：发布 Flow、路由命中、启动 Workflow、调用工具、人工确认、审计查询。

## 7. Git 与发布规范

- 主干：`main`。
- 需求分支：`feat/<ticket>-<short-name>`。
- 修复分支：`fix/<ticket>-<short-name>`。
- 提交格式：`feat(runtime-api): add flow routing`。
- 合入前必须通过：lint、typecheck、unit test、contract test。
- 版本发布以 Git tag + Docker image digest 记录。

## 8. 安全边界

- Runtime Worker 不允许直连业务系统。
- Pi 不持有业务系统凭据。
- Tool Gateway 是所有外部副作用动作的唯一出口。
- 高风险工具必须执行 preview -> confirm -> commit。
- FlowSpec、ToolManifest、AgentSpec、Prompt 均需版本化。
