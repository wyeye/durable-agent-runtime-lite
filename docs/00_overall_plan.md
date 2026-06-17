# 00 总体计划

## 1. 建设目标

建设一套通用、可复用、可治理的 Durable Agent Runtime Lite。它以 Temporal 负责可靠流程生命周期，以 Pi 负责受限 Agent Loop，以 Tool Gateway 负责工具安全边界，以 Control Plane 负责能力运营和发布治理。

## 2. 一期服务边界

生产服务保持 4 个：

- `control-plane`：控制面与能力运营端。
- `runtime-api`：统一运行入口与路由。
- `runtime-worker`：Temporal Workflow / Activity 执行与 Pi 封装。
- `tool-gateway`：工具治理、策略、审计、适配器。

`devtools/mock-server` 仅用于本地开发，不进入生产部署清单。

## 3. 关键链路

### 3.1 预置流程链路

用户请求进入 `runtime-api`，Router 命中 `flow_id + version`，启动 Temporal `ConfigDrivenWorkflow`。`runtime-worker` 加载 FlowSpec 快照，按步骤调用 Activity、Pi、Tool Gateway 和 Human Task。执行完成后审计落库并返回结果。

### 3.2 Agent Loop 兜底链路

Router 未命中预置流程时，启动 Temporal `GenericAgentWorkflow`。Worker 调用 Pi 进行受限规划，Pi 只能提出工具调用建议或最终答案；所有工具执行仍然经过 Tool Gateway。

### 3.3 编排自动加载链路

`control-plane` 发布 FlowSpec 后写入 Registry，生成 RouteIndex 和 Example Embedding，发布 `FlowPublished` 事件。`runtime-api` 热加载 Router 缓存。新增编排不新增 Temporal Workflow Type，而由 `ConfigDrivenWorkflow` 解释执行。

## 4. 里程碑

| 阶段 | 周期 | 目标 | 验收 |
|---|---:|---|---|
| M0 工程基线 | 1 周 | Monorepo、CI、数据库、Temporal、日志链路 | 本地一键启动，健康检查通过 |
| M1 控制面基础 | 2 周 | Flow/Route/Tool/Agent/Prompt Registry 草稿与发布 | 可创建、校验、发布一个 FlowSpec |
| M2 路由与启动 | 2 周 | Runtime API、意图路由、向量召回、Workflow Starter | 文本请求可命中流程并启动 Workflow |
| M3 执行引擎 | 2 周 | ConfigDrivenWorkflow、GenericAgentWorkflow、Pi 调用 | 可完成预置流程和 Agent 兜底流程 |
| M4 工具治理 | 2 周 | Tool Gateway、Policy、Audit、Adapter、幂等 | 工具调用全链路可审计、可拒绝、可确认 |
| M5 端到端场景 | 2 周 | 2-3 条示例流程闭环 | 从发布到执行到审计完整跑通 |
| M6 加固验收 | 1-2 周 | 灰度、回滚、压测、安全、异常 | 进入试点环境 |

## 5. MVP 裁剪建议

MVP 可以先做：Flow 发布、规则路由、ConfigDrivenWorkflow、Tool Gateway HTTP Adapter、审计日志、人工确认。向量召回、LLM Top-K 判别、评测看板可以后置，但接口和数据模型要预留。
