# Configuration Variables

本文只保留当前仍然值得关注的配置项，并把脚本/seed/Compose 辅助变量与统一运行时配置分开说明。

主要事实源：

- `packages/config/src/index.ts`
- `.env.example`
- `infra/docker-compose*.yml`
- 相关 app 的启动、鉴权、readiness 与 adapter 调用代码

## 使用方式

- 优先关注“常用运行时配置”；本地启动、容器部署和生产检查通常只需要这一层。
- “高级运行时配置”仍然有效，但只在特定链路、容量限制或安全边界下需要调整。
- seed、smoke、Compose 端口映射等变量不属于统一 `RuntimeConfig`，统一放在“辅助变量”一节。

## 常用运行时配置

| 变量 | 默认值 | 主要使用方 | 用途 |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | 全部应用 | 区分 `development` / `test` / `production`。 |
| `APP_ENV` | `local` | 全部应用 | 标记部署环境标签。 |
| `HOST` | `0.0.0.0` | 全部应用 | 服务监听地址。 |
| `PORT` | 空 | 全部应用 | 通用覆盖端口；设置后优先于应用专属端口。 |
| `DATABASE_URL` | `postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime` | 四个生产 app | PostgreSQL 连接串。 |
| `TEMPORAL_ADDRESS` | `localhost:7233` | `runtime-api`、`runtime-worker` | Temporal server 地址。 |
| `TEMPORAL_NAMESPACE` | `default` | `runtime-api`、`runtime-worker` | Temporal namespace。 |
| `TOOL_GATEWAY_URL` | 空 | `runtime-worker`、`control-plane` | 调用 tool-gateway 的下游地址；未设置时 helper 默认回退 `http://localhost:3003`。 |
| `RUNTIME_API_URL` | 空 | `control-plane` | control-plane 调用 runtime-api 的下游地址；未设置时 helper 默认回退 `http://localhost:3001`。 |
| `RUNTIME_WORKER_MODE` | `mock` | `runtime-worker` | 控制 worker 只起 mock handle 还是连接 Temporal。 |
| `RUNTIME_API_WORKFLOW_STARTER` | `mock` | `runtime-api` | 控制 workflow starter 走 mock 还是 Temporal client。 |
| `RUNTIME_API_AUTH_MODE` | `disabled` | `runtime-api` | 控制是否要求 header 身份。 |
| `TOOL_GATEWAY_AUTH_MODE` | `disabled` | `tool-gateway` | 控制服务间 token 鉴权。 |
| `CONTROL_PLANE_AUTH_MODE` | `header` | `control-plane` | control-plane 的鉴权方式。 |
| `IAM_DIRECTORY_MODE` | `header` | `control-plane`、`runtime-api` | 身份目录解析方式；`header` 走请求头，`db` 从数据库解析。 |
| `MODEL_CREDENTIAL_MASTER_KEY` | `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=` | `control-plane`、`runtime-api`、`runtime-worker` | 模型凭据主密钥。 |
| `LOG_LEVEL` | `info` | 全部应用 | 日志级别。 |
| `DEFAULT_LOCALE` | `zh-CN` | 全部应用 | 默认返回语言。 |
| `LOG_LOCALE` | `zh-CN` | 全部应用 | 结构化日志使用的语言。 |

## 高级运行时配置

### 聊天与 Pi

| 变量 | 默认值 | 主要使用方 | 用途 |
| --- | --- | --- | --- |
| `CHAT_CONTEXT_MAX_MESSAGES` | `20` | `runtime-api` | 聊天上下文最多保留的消息数。 |
| `CHAT_CONTEXT_MAX_BYTES` | `32768` | `runtime-api` | 聊天上下文字节上限。 |
| `CHAT_MESSAGE_MAX_CHARS` | `8000` | `runtime-api` | 单条聊天消息字符上限。 |
| `PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW` | `20` | `runtime-worker` | 达到上限后 workflow 触发 continue-as-new。 |

### 模型调用

| 变量 | 默认值 | 主要使用方 | 用途 |
| --- | --- | --- | --- |
| `MODEL_GATEWAY_CLIENT_CACHE_TTL_MS` | `60000` | `runtime-worker` | 模型客户端缓存 TTL。 |
| `MODEL_GATEWAY_TIMEOUT_MS` | `30000` | `runtime-worker` | 单次模型调用超时。 |
| `MODEL_GATEWAY_MAX_RETRIES` | `1` | `runtime-worker` | 模型调用最大重试次数。 |
| `MODEL_GATEWAY_MAX_RESPONSE_BYTES` | `1000000` | `runtime-worker`、`runtime-api`、`control-plane` | 模型响应体大小上限。 |
| `MODEL_CALL_LEDGER_MAX_RESPONSE_BYTES` | `1048576` | `runtime-worker` | 模型调用台账允许落库的响应大小上限。 |
| `MODEL_GATEWAY_ALLOW_INSECURE_HTTP` | `true` | `runtime-worker`、`runtime-api`、`control-plane` | 是否允许开发场景下的非 HTTPS 模型网关。 |
| `MODEL_GATEWAY_IDEMPOTENCY_HEADER` | `Idempotency-Key` | `runtime-worker` | 调用模型网关时使用的幂等 header 名称。 |
| `MODEL_GATEWAY_USER_AGENT` | `durable-agent-runtime-lite/runtime-worker` | `runtime-worker` | 模型网关请求的 User-Agent。 |

### 路由与评测

| 变量 | 默认值 | 主要使用方 | 用途 |
| --- | --- | --- | --- |
| `ROUTER_EMBEDDING_MODEL_ID` | `mock-embedding-1536` | `runtime-api`、`control-plane` | 路由 embedding 使用的模型 ID。本地 Docker 开发栈默认指向 mock embedding 模型。 |
| `ROUTER_EMBEDDING_MODEL_VERSION` | `1` | `runtime-api`、`control-plane` | 路由 embedding 使用的模型版本。本地 Docker 开发栈默认指向 mock embedding 模型版本。 |
| `ROUTER_VECTOR_TOP_K` | `5` | `runtime-api`、`control-plane` | 语义召回 Top-K。 |
| `ROUTER_SEMANTIC_MATCH_THRESHOLD` | `0.8` | `runtime-api`、`control-plane` | 语义命中阈值。 |
| `ROUTER_SEMANTIC_CLARIFY_THRESHOLD` | `0.65` | `runtime-api`、`control-plane` | 进入 clarify 的阈值。 |
| `ROUTER_SEMANTIC_MIN_MARGIN` | `0.05` | `runtime-api`、`control-plane` | 第一候选与第二候选的最小分差要求。 |
| `ROUTER_EMBEDDING_TIMEOUT_MS` | `10000` | `runtime-api`、`control-plane` | embedding 调用超时。 |
| `EVALUATION_WORKER_ENABLED` | `false` | `runtime-worker` | 是否启用 evaluation worker。 |
| `EVALUATION_TASK_QUEUE` | `evaluation-worker-main` | `runtime-api`、`runtime-worker` | evaluation workflow/worker 使用的任务队列。 |
| `EVALUATION_MAX_CONCURRENT_CASES` | `2` | `runtime-worker` | 单 run 下 case 最大并发数。 |
| `EVALUATION_CASE_TIMEOUT_MS` | `120000` | `runtime-worker` | 单个评测 case 超时。 |
| `EVALUATION_GATE_MODE` | `advisory` | `runtime-worker`、`control-plane` | 评测门禁模式。 |
| `EVALUATION_OUTPUT_MAX_BYTES` | `1000000` | `runtime-worker` | 评测输出大小上限。 |
| `EVALUATION_EVIDENCE_MAX_BYTES` | `2000000` | `runtime-worker` | 评测证据大小上限。 |

### Tool Gateway 与服务 token

| 变量 | 默认值 | 主要使用方 | 用途 |
| --- | --- | --- | --- |
| `TENANT_RUNTIME_POLICY_MODE` | `optional` | `runtime-api`、`tool-gateway`、`runtime-worker` | 租户运行策略是可选还是必需。 |
| `TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED` | `false` | `tool-gateway` | 是否暴露调试接口。 |
| `TOOL_GATEWAY_RUNTIME_WORKER_TOKEN` | 空 | `tool-gateway` | tool-gateway 接受 `runtime-worker` 身份时使用的 token。 |
| `TOOL_GATEWAY_CONTROL_PLANE_TOKEN` | 空 | `tool-gateway` | tool-gateway 接受 `control-plane` 身份时使用的 token。 |
| `RUNTIME_WORKER_TOOL_GATEWAY_TOKEN` | 空 | `runtime-worker` | runtime-worker 调用 tool-gateway 时携带的服务 token。 |
| `CONTROL_PLANE_TOOL_GATEWAY_TOKEN` | 空 | `control-plane` | control-plane 调用 tool-gateway 时携带的服务 token。 |
| `TOOL_HTTP_ALLOWED_HOSTS` | 空 | `tool-gateway` | `http_readonly` adapter 允许访问的 Host allowlist。 |
| `TOOL_HTTP_ALLOW_INSECURE_LOCALHOST` | `false` | `tool-gateway` | 是否允许开发场景下通过 HTTP 访问 localhost / mock-server。 |
| `TOOL_HTTP_MAX_TIMEOUT_MS` | `15000` | `tool-gateway` | `http_readonly` adapter 允许的最大超时。 |
| `TOOL_HTTP_MAX_RESPONSE_BYTES` | `1048576` | `tool-gateway` | `http_readonly` adapter 允许的最大响应体大小。 |

### 构建与应用专属端口

| 变量 | 默认值 | 主要使用方 | 用途 |
| --- | --- | --- | --- |
| `APP_VERSION` | `0.8.0` | 全部应用 | 写入 build info 与 `/version` 输出。 |
| `BUILD_SHA` | `unknown` | 全部应用 | 标记构建提交 SHA。 |
| `BUILD_TIME` | `unknown` | 全部应用 | 标记构建时间。 |
| `CONTROL_PLANE_PORT` | `3000` | `control-plane` | control-plane 默认监听端口。 |
| `RUNTIME_API_PORT` | `3001` | `runtime-api` | runtime-api 默认监听端口。 |
| `RUNTIME_WORKER_PORT` | `3002` | `runtime-worker` | runtime-worker health server 默认监听端口。 |
| `TOOL_GATEWAY_PORT` | `3003` | `tool-gateway` | tool-gateway 默认监听端口。 |
| `CONTROL_PLANE_LOCAL_DEV_LOGIN_ENABLED` | `false` | `control-plane` | 是否打开本地开发密码登录入口。 |
| `CONTROL_PLANE_LOCAL_DEV_PASSWORD` | 空 | `control-plane` | 本地开发密码登录使用的密码。 |
| `CONTROL_PLANE_SWAGGER_ENABLED` | `true` | `control-plane` | 是否暴露 Swagger 文档。 |
| `CONTROL_PLANE_STATIC_ENABLED` | `false` | `control-plane` | 是否托管前端静态资源。 |

## 辅助变量

这些变量不在统一 `RuntimeConfig` 中，但当前仓库仍在脚本、seed、smoke 或 Compose 中使用。

| 变量 | 默认值 | 主要使用方 | 用途 |
| --- | --- | --- | --- |
| `RUN_POSTGRES_TESTS` | 空 | 测试 | 控制是否运行依赖真实 PostgreSQL 的测试。 |
| `TOOL_SECRET_*` | 无统一默认值 | `tool-gateway` | 为 `http_readonly` adapter 注入外部 API 密钥。 |
| `MODEL_GATEWAY_BASE_URL` | 依场景而定 | seed、smoke、Compose override | 本地 mock/Ollama seed 与 smoke 使用的模型网关基础地址。 |
| `MODEL_GATEWAY_API_KEY` | 依场景而定 | live provider smoke、Compose override | 脚本或外部 provider 使用的模型网关 API Key。 |
| `SEED_LOCAL_OLLAMA_MODEL_POLICY` | `false` | `devtools/repo-cli` | 控制 seed 脚本是否写入本地 Ollama 模型策略与样例资源。 |
| `SEED_MOCK_EMBEDDING_GATEWAY_BASE_URL` | `http://mock-server:4100/gateway-a` | `devtools/repo-cli` | seed 脚本中 mock embedding gateway 的 base URL。 |
| `SEED_MOCK_EMBEDDING_GATEWAY_API_KEY` | `gateway-a-secret` | `devtools/repo-cli` | seed 脚本中 mock embedding gateway 的 API key。 |
| `SEED_DETERMINISTIC_MODEL_GATEWAY_BASE_URL` | `http://mock-server:4100` | seed、smoke | deterministic model gateway 的 seed/smoke 地址。 |
| `SEED_HTTP_READONLY_MODEL_GATEWAY_BASE_URL` | `http://mock-server:4100` | smoke | `http_readonly` smoke seed 的模型网关地址。 |
| `TENANT_ADMISSION_STALE_AFTER_MS` | `300000` | `devtools/repo-cli` | tenant admission reconcile 脚本的过期判定窗口。 |
| `TENANT_ADMISSION_MAX_RECONCILE_BATCH` | `50` | `devtools/repo-cli` | tenant admission reconcile 脚本的单批处理上限。 |
| `POSTGRES_HOST_PORT` | `15432` | Docker Compose | 宿主机映射 PostgreSQL 端口。 |
| `VALKEY_HOST_PORT` | `16380` | Docker Compose | 宿主机映射 Valkey 端口。 |
| `TEMPORAL_HOST_PORT` | `7233` | Docker Compose | 宿主机映射 Temporal gRPC 端口。 |
| `TEMPORAL_UI_HOST_PORT` | `8233` | Docker Compose | 宿主机映射 Temporal UI 端口。 |
| `RUNTIME_API_HOST_PORT` | `3000` | Docker Compose | 宿主机映射 runtime-api 容器端口。 |
| `CONTROL_PLANE_HOST_PORT` | `3100` | Docker Compose | 宿主机映射 control-plane 容器端口。 |
| `TOOL_GATEWAY_HOST_PORT` | `3200` | Docker Compose | 宿主机映射 tool-gateway 容器端口。 |
| `RUNTIME_WORKER_HOST_PORT` | `3300` | Docker Compose | 宿主机映射 runtime-worker health 端口。 |
| `MOCK_SERVER_HOST_PORT` | `4100` | `infra/docker-compose.pi-smoke.yml` | 宿主机映射 mock-server 端口。 |

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
