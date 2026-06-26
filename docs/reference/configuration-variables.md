# Configuration Variables

本文整理项目当前环境变量与配置变量，覆盖统一配置 schema、`.env.example` 示例值，以及少量 schema 外辅助变量。

主要事实源：

- `packages/config/src/index.ts`
- `.env.example`
- `infra/docker-compose*.yml`
- 相关 app 的启动、鉴权、readiness 与 adapter 调用代码

## 说明

- “默认值”来自统一 schema 或 `.env.example`。
- “使用方”表示主要消费该变量的应用或脚本，不代表唯一调用点。
- “用途”描述运行时作用，不等于生产推荐值。
- 生产约束以代码中的 readiness / startup fail-closed 逻辑为准。

## 统一配置变量

| 变量 | 默认值 | 使用方 | 用途 |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | 全部应用 | 区分 `development` / `test` / `production`，影响启动校验与安全门禁。 |
| `APP_ENV` | `local` | 全部应用 | 标记部署环境标签，供日志与运行元数据使用。 |
| `APP_VERSION` | `0.8.0` | 全部应用 | 写入 build info 与 `/version` 输出。 |
| `BUILD_SHA` | `unknown` | 全部应用 | 标记构建提交 SHA。 |
| `BUILD_TIME` | `unknown` | 全部应用 | 标记构建时间。 |
| `HOST` | `0.0.0.0` | 全部应用 | 服务监听地址。 |
| `PORT` | 空 | 全部应用 | 通用覆盖端口；设置后优先于各应用专属端口。 |
| `DATABASE_URL` | `postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime` | `control-plane`、`runtime-api`、`runtime-worker`、`tool-gateway` | PostgreSQL 连接串，供 repository、service、worker activity 和 readiness 使用。 |
| `VALKEY_URL` | `redis://localhost:16380` | 基础设施相关模块 | Valkey 连接地址，作为缓存/队列类基础设施配置保留。 |
| `TEMPORAL_ADDRESS` | `localhost:7233` | `runtime-api`、`runtime-worker` | Temporal server 地址；`runtime-api` 用于 starter/signal，`runtime-worker` 用于 worker 连接。 |
| `TEMPORAL_NAMESPACE` | `default` | `runtime-api`、`runtime-worker` | Temporal namespace。 |
| `MODEL_GATEWAY_BASE_URL` | `http://localhost:4100` | `runtime-worker`、seed 脚本 | 模型网关基础地址。 |
| `MODEL_GATEWAY_API_KEY` | `dev-only-placeholder` | `runtime-worker`、seed 脚本 | 模型网关 API Key 或占位符。 |
| `MODEL_CREDENTIAL_MASTER_KEY` | `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` | `control-plane`、`runtime-api`、`runtime-worker` | 模型凭据主密钥，用于凭据加解密与有效性校验。 |
| `MODEL_GATEWAY_CLIENT_CACHE_TTL_MS` | `60000` | `runtime-worker` | 模型客户端缓存 TTL。 |
| `MODEL_GATEWAY_MODE` | `disabled` | `runtime-worker` | 模型网关模式开关，控制是否禁用、mock 或走 openai-compatible。 |
| `MODEL_GATEWAY_PROTOCOL` | `dar_generate` | `runtime-worker` | 与模型网关交互使用的协议。 |
| `MODEL_GATEWAY_TIMEOUT_MS` | `30000` | `runtime-worker` | 单次模型调用超时。 |
| `MODEL_GATEWAY_MAX_RETRIES` | `1` | `runtime-worker` | 模型调用最大重试次数。 |
| `MODEL_GATEWAY_MAX_RESPONSE_BYTES` | `1000000` | `runtime-worker` | 模型响应体大小上限。 |
| `MODEL_CALL_LEDGER_MAX_RESPONSE_BYTES` | `1048576` | `runtime-worker` | 模型调用台账允许落库的响应大小上限。 |
| `MODEL_GATEWAY_ALLOW_INSECURE_HTTP` | `true` | `runtime-worker` | 是否允许开发场景下的非 HTTPS 模型网关。 |
| `MODEL_GATEWAY_IDEMPOTENCY_HEADER` | `Idempotency-Key` | `runtime-worker` | 调用模型网关时使用的幂等 header 名称。 |
| `MODEL_GATEWAY_USER_AGENT` | `durable-agent-runtime-lite/runtime-worker` | `runtime-worker` | 模型网关请求的 User-Agent。 |
| `CHAT_CONTEXT_MAX_MESSAGES` | `20` | `runtime-api` | 聊天上下文最多保留的消息数。 |
| `CHAT_CONTEXT_MAX_BYTES` | `32768` | `runtime-api` | 聊天上下文字节上限。 |
| `CHAT_MESSAGE_MAX_CHARS` | `8000` | `runtime-api` | 单条聊天消息字符上限。 |
| `CHAT_TITLE_MAX_CHARS` | `100` | `runtime-api`、`control-plane` | 聊天标题字符上限。 |
| `CHAT_POLL_INTERVAL_MS` | `1500` | `control-plane` | 前端轮询聊天进度的间隔。 |
| `PI_CONTEXT_MAX_BYTES` | `262144` | `runtime-worker` | Pi context snapshot 最大字节数。 |
| `PI_SEGMENT_TIMEOUT_MS` | `120000` | `runtime-worker` | 单个 Pi segment 超时。 |
| `PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW` | `20` | `runtime-worker` | 达到上限后 workflow 触发 continue-as-new。 |
| `TOOL_GATEWAY_BASE_URL` | `http://localhost:3003` | `runtime-worker`、`control-plane` | 调用 tool-gateway 的首选基础地址。 |
| `TOOL_GATEWAY_URL` | `http://localhost:3003` | `runtime-worker`、`control-plane` | 兼容性地址；在 helper 中作为 `TOOL_GATEWAY_BASE_URL` 的回退。 |
| `RUNTIME_API_URL` | `http://localhost:3001` | `control-plane` | control-plane 调用 runtime-api 的下游地址。 |
| `RUNTIME_API_AUTH_MODE` | `disabled` | `runtime-api` | `runtime-api` 的鉴权方式，控制是否要求 header 身份。 |
| `JWT_ISSUER` | `http://localhost:3000` | `runtime-api`、`tool-gateway` | JWT `iss` 校验值。 |
| `JWT_AUDIENCE` | `durable-agent-runtime-lite` | `runtime-api`、`tool-gateway` | JWT `aud` 校验值。 |
| `DEFAULT_LOCALE` | `zh-CN` | 全部应用 | 默认返回语言。 |
| `LOG_LOCALE` | `zh-CN` | 全部应用 | 结构化日志使用的语言。 |
| `LOG_LEVEL` | `info` | 全部应用 | 日志级别。 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | 观测性相关模块 | OpenTelemetry OTLP 上报地址。 |
| `CONTROL_PLANE_PORT` | `3000` | `control-plane` | control-plane 默认监听端口。 |
| `RUNTIME_API_PORT` | `3001` | `runtime-api` | runtime-api 默认监听端口。 |
| `RUNTIME_WORKER_PORT` | `3002` | `runtime-worker` | runtime-worker health server 默认监听端口。 |
| `TOOL_GATEWAY_PORT` | `3003` | `tool-gateway` | tool-gateway 默认监听端口。 |
| `RUNTIME_WORKER_MODE` | `mock` | `runtime-worker` | 控制 runtime-worker 只起 mock handle 还是连接 Temporal。 |
| `RUNTIME_API_WORKFLOW_STARTER` | `mock` | `runtime-api` | 控制 workflow starter 走 mock 还是 Temporal client。 |
| `RUNTIME_API_ROUTE_SOURCE` | `memory` | `runtime-api` | 路由定义从内存还是数据库读取。 |
| `ROUTER_SEMANTIC_ENABLED` | `false` | `runtime-api` | 是否启用向量语义路由。 |
| `ROUTER_EMBEDDING_MODEL_ID` | 空 | `runtime-api` | 路由 embedding 使用的模型 ID。 |
| `ROUTER_EMBEDDING_MODEL_VERSION` | 空 | `runtime-api` | 路由 embedding 使用的模型版本。 |
| `ROUTER_VECTOR_TOP_K` | `5` | `runtime-api` | 语义召回 Top-K。 |
| `ROUTER_SEMANTIC_MATCH_THRESHOLD` | `0.8` | `runtime-api` | 语义命中阈值。 |
| `ROUTER_SEMANTIC_CLARIFY_THRESHOLD` | `0.65` | `runtime-api` | 进入 clarify 的阈值。 |
| `ROUTER_SEMANTIC_MIN_MARGIN` | `0.05` | `runtime-api` | 第一候选与第二候选的最小分差要求。 |
| `ROUTER_EMBEDDING_TIMEOUT_MS` | `10000` | `runtime-api` | embedding 调用超时。 |
| `TOOL_GATEWAY_REGISTRY_SOURCE` | `memory` | `tool-gateway` | Tool Manifest 从内存还是数据库读取。 |
| `TOOL_GATEWAY_AUTH_MODE` | `disabled` | `tool-gateway` | 是否启用服务间 token 鉴权。 |
| `TENANT_RUNTIME_POLICY_MODE` | `optional` | `runtime-api`、`tool-gateway`、`runtime-worker` | 租户运行策略是可选还是必需。 |
| `TENANT_POLICY_CACHE_TTL_MS` | `5000` | `runtime-api`、`tool-gateway`、`runtime-worker` | 租户策略缓存 TTL。 |
| `TENANT_ADMISSION_RECONCILE_ENABLED` | `false` | `runtime-worker` | 是否启用 tenant admission 对账/修复。 |
| `TENANT_ADMISSION_STALE_AFTER_MS` | `300000` | `runtime-worker` | tenant admission 记录多久后视为过期。 |
| `TENANT_ADMISSION_MAX_RECONCILE_BATCH` | `50` | `runtime-worker` | 单次 reconcile 最大处理批量。 |
| `EVALUATION_WORKER_ENABLED` | `false` | `runtime-worker` | 是否启用 evaluation worker。 |
| `EVALUATION_TASK_QUEUE` | `evaluation-worker-main` | `runtime-api`、`runtime-worker` | evaluation workflow/worker 使用的任务队列。 |
| `EVALUATION_MAX_CONCURRENT_RUNS` | `1` | `runtime-worker` | 评测运行最大并发数。 |
| `EVALUATION_MAX_CONCURRENT_CASES` | `2` | `runtime-worker` | 单 run 下 case 最大并发数。 |
| `EVALUATION_CASE_TIMEOUT_MS` | `120000` | `runtime-worker` | 单个评测 case 超时。 |
| `EVALUATION_GATE_MODE` | `advisory` | `runtime-worker` | 评测门禁模式，控制只提示还是强约束。 |
| `EVALUATION_OUTPUT_MAX_BYTES` | `1000000` | `runtime-worker` | 评测输出大小上限。 |
| `EVALUATION_EVIDENCE_MAX_BYTES` | `2000000` | `runtime-worker` | 评测证据大小上限。 |
| `EVALUATION_REGEX_TIMEOUT_MS` | `250` | `runtime-worker` | 评测正则匹配超时。 |
| `SEED_EVALUATION_DATASETS` | `false` | seed 脚本、`runtime-worker` | 是否在开发/测试阶段自动写入评测数据集。 |
| `TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED` | `false` | `tool-gateway` | 是否暴露调试接口。 |
| `TOOL_GATEWAY_RUNTIME_WORKER_TOKEN` | 空 | `tool-gateway` | tool-gateway 接受 `runtime-worker` 身份时使用的 token。 |
| `TOOL_GATEWAY_CONTROL_PLANE_TOKEN` | 空 | `tool-gateway` | tool-gateway 接受 `control-plane` 身份时使用的 token。 |
| `TOOL_HTTP_ALLOWED_HOSTS` | 空 | `tool-gateway` | `http_readonly` adapter 允许访问的 Host allowlist，逗号分隔。 |
| `TOOL_HTTP_ALLOW_INSECURE_LOCALHOST` | `false` | `tool-gateway` | 是否允许开发场景下通过 HTTP 访问 localhost / mock-server。 |
| `TOOL_HTTP_MAX_TIMEOUT_MS` | `15000` | `tool-gateway` | `http_readonly` adapter 允许的最大超时。 |
| `TOOL_HTTP_MAX_RESPONSE_BYTES` | `1048576` | `tool-gateway` | `http_readonly` adapter 允许的最大响应体大小。 |
| `RUNTIME_WORKER_TOOL_GATEWAY_TOKEN` | 空 | `runtime-worker` | runtime-worker 调用 tool-gateway 时携带的服务 token。 |
| `CONTROL_PLANE_TOOL_GATEWAY_TOKEN` | 空 | `control-plane` | control-plane 调用 tool-gateway 时携带的服务 token。 |
| `CONTROL_PLANE_AUTH_MODE` | `header` | `control-plane` | control-plane 的鉴权方式。 |
| `CONTROL_PLANE_LOCAL_DEV_LOGIN_ENABLED` | `false` | `control-plane` | 是否打开本地开发密码登录入口。 |
| `CONTROL_PLANE_LOCAL_DEV_PASSWORD` | 空 | `control-plane` | 本地开发密码登录使用的密码。 |
| `IAM_DIRECTORY_MODE` | `header` | `control-plane`、`runtime-api` | 身份目录解析方式；`header` 走请求头，`db` 从数据库解析。 |
| `CONTROL_PLANE_SWAGGER_ENABLED` | `true` | `control-plane` | 是否暴露 Swagger 文档。 |
| `CONTROL_PLANE_STATIC_ENABLED` | `false` | `control-plane` | 是否托管前端静态资源。 |

## Schema 外辅助变量

这些变量不在 `runtimeConfigSchema` 中，但当前仓库仍在脚本、测试或 Compose 中使用。

| 变量 | 默认值 | 使用方 | 用途 |
| --- | --- | --- | --- |
| `RUN_POSTGRES_TESTS` | 空 | 测试 | 控制是否运行依赖真实 PostgreSQL 的测试。 |
| `TOOL_SECRET_*` | 无统一默认值 | `tool-gateway` | 为 `http_readonly` adapter 注入外部 API 密钥；例如 `.env.example` 中的 `TOOL_SECRET_BUSINESS_API`。 |
| `SEED_LOCAL_OLLAMA_MODEL_POLICY` | `false` | `devtools/repo-cli` | 控制 seed 脚本是否写入本地 Ollama 模型策略与样例资源。 |
| `SEED_MOCK_EMBEDDING_GATEWAY_BASE_URL` | `http://mock-server:4100/gateway-a` | `devtools/repo-cli` | seed 脚本中 mock embedding gateway 的 base URL。 |
| `SEED_MOCK_EMBEDDING_GATEWAY_API_KEY` | `gateway-a-secret` | `devtools/repo-cli` | seed 脚本中 mock embedding gateway 的 API key。 |
| `POSTGRES_HOST_PORT` | `15432` | Docker Compose | 宿主机映射 PostgreSQL 端口。 |
| `VALKEY_HOST_PORT` | `16380` | Docker Compose | 宿主机映射 Valkey 端口。 |
| `TEMPORAL_HOST_PORT` | `7233` | Docker Compose | 宿主机映射 Temporal gRPC 端口。 |
| `TEMPORAL_UI_HOST_PORT` | `8233` | Docker Compose | 宿主机映射 Temporal UI 端口。 |
| `RUNTIME_API_HOST_PORT` | `3000` | Docker Compose | 宿主机映射 runtime-api 容器端口。 |
| `CONTROL_PLANE_HOST_PORT` | `3100` | Docker Compose | 宿主机映射 control-plane 容器端口。 |
| `TOOL_GATEWAY_HOST_PORT` | `3200` | Docker Compose | 宿主机映射 tool-gateway 容器端口。 |
| `RUNTIME_WORKER_HOST_PORT` | `3300` | Docker Compose | 宿主机映射 runtime-worker health 端口。 |
| `MOCK_SERVER_HOST_PORT` | `4100` | `infra/docker-compose.pi-smoke.yml` | 宿主机映射 mock-server 端口。 |

## 关键用途说明

### 服务启动与监听

- `HOST`、`PORT`、`CONTROL_PLANE_PORT`、`RUNTIME_API_PORT`、`RUNTIME_WORKER_PORT`、`TOOL_GATEWAY_PORT` 共同决定本地直跑时的监听地址与端口。
- Docker Compose 场景下，应用容器内部端口保持固定，宿主机端口由 `*_HOST_PORT` 控制映射。

### 数据库、Temporal 与下游地址

- `DATABASE_URL` 是三大后端应用的核心依赖。
- `TEMPORAL_ADDRESS` 与 `TEMPORAL_NAMESPACE` 共同决定 workflow starter 和 worker 实际连接的 Temporal 集群位置。
- `RUNTIME_API_URL`、`TOOL_GATEWAY_BASE_URL`、`TOOL_GATEWAY_URL` 用于服务间 HTTP 调用。

### 鉴权与身份目录

- `RUNTIME_API_AUTH_MODE` 控制 `runtime-api` 是否要求请求头身份。
- `CONTROL_PLANE_AUTH_MODE` 控制 `control-plane` 的 header 鉴权行为。
- `IAM_DIRECTORY_MODE` 决定身份与角色是从 header 信任输入，还是从数据库解析。
- `TOOL_GATEWAY_AUTH_MODE`、`TOOL_GATEWAY_RUNTIME_WORKER_TOKEN`、`TOOL_GATEWAY_CONTROL_PLANE_TOKEN`、`RUNTIME_WORKER_TOOL_GATEWAY_TOKEN`、`CONTROL_PLANE_TOOL_GATEWAY_TOKEN` 共同组成 tool-gateway 的服务间鉴权链路。

### Workflow 与 Worker 模式

- `RUNTIME_WORKER_MODE=mock|temporal` 控制 worker 是否真的连接 Temporal。
- `RUNTIME_API_WORKFLOW_STARTER=mock|temporal` 控制 API 是返回 mock run id，还是通过 Temporal client 启动真实 workflow。
- `RUNTIME_API_ROUTE_SOURCE` 与 `TOOL_GATEWAY_REGISTRY_SOURCE` 决定路由和工具注册信息是来自内存还是数据库。

### 模型、Pi 与聊天

- `MODEL_GATEWAY_*` 系列变量控制模型网关地址、协议、超时、凭据和客户端缓存。
- `MODEL_CREDENTIAL_MASTER_KEY` 是模型凭据安全边界的核心变量。
- Pi 运行时固定走 `model_gateway`；`PI_*` 系列变量限定 Pi loop 的预算。
- `CHAT_*` 系列变量控制聊天消息大小、轮询频率和上下文截断策略。

### Tool Gateway 安全边界

- `TOOL_HTTP_ALLOWED_HOSTS`、`TOOL_HTTP_ALLOW_INSECURE_LOCALHOST`、`TOOL_HTTP_MAX_TIMEOUT_MS`、`TOOL_HTTP_MAX_RESPONSE_BYTES` 只作用于 `http_readonly` adapter。
- `TOOL_SECRET_*` 用于把密钥从环境注入 adapter，而不是让用户直接传入。

### Evaluation

- `EVALUATION_WORKER_ENABLED`、`EVALUATION_TASK_QUEUE`、`EVALUATION_MAX_CONCURRENT_*`、`EVALUATION_CASE_TIMEOUT_MS` 定义评测执行能力与并发。
- `EVALUATION_GATE_MODE` 决定评测结果是 advisory 还是 required。
- `SEED_EVALUATION_DATASETS` 仅用于开发/测试阶段的种子数据准备。

## 生产约束摘要

以下约束由代码中的 startup/readiness 逻辑直接 enforce：

- `RUNTIME_WORKER_MODE` 在生产必须为 `temporal`。
- `RUNTIME_API_AUTH_MODE` 在生产必须为 `header`。
- `RUNTIME_API_WORKFLOW_STARTER` 在生产应为 `temporal`。
- `TOOL_GATEWAY_AUTH_MODE` 在生产必须为 `service_token`。
- `CONTROL_PLANE_AUTH_MODE` 在生产必须为 `header`。
- `IAM_DIRECTORY_MODE` 在生产必须为 `db`。
- `MODEL_CREDENTIAL_MASTER_KEY` 在生产必须为有效主密钥。
- `TOOL_GATEWAY_RUNTIME_WORKER_TOKEN`、`TOOL_GATEWAY_CONTROL_PLANE_TOKEN`、`RUNTIME_WORKER_TOOL_GATEWAY_TOKEN`、`CONTROL_PLANE_TOOL_GATEWAY_TOKEN` 在生产应提供真实服务 token，不能继续使用示例占位值。

## 相关文档

- [Configuration Contracts And Errors](./configuration-contracts-and-errors.md)
- [Local Development](../guides/local-development.md)
- [Docker Deployment](../guides/docker-deployment.md)
- [Model And Routing](../guides/model-and-routing.md)
