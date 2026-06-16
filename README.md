# Durable Agent Runtime Lite v1.4

本目录是一套压缩后的通用 Agent Runtime 工程落地目录。生产自研服务压缩为 4 个：

| App | 定位 | 合并能力 |
|---|---|---|
| `control-plane` | 控制面 | 能力运营端、Flow/Agent/Tool/Prompt Registry、发布灰度、Human Task、看板 |
| `runtime-api` | 运行入口 | API Gateway、Session、Intent Router、Flow Router、Workflow Starter、流式返回 |
| `runtime-worker` | 执行面 | Temporal Worker、ConfigDrivenWorkflow、GenericAgentWorkflow、Activity、Pi Runner、Model Adapter |
| `tool-gateway` | 工具安全边界 | Tool Gateway、Policy、Schema 校验、Adapter、Audit、幂等、限流 |

核心原则：服务可以压缩，但职责边界不能混乱。Runtime Worker 可以调 Pi，但不能绕过 Tool Gateway 直连业务系统；Tool Gateway 是所有副作用动作的唯一出口。


## 快速启动建议

```bash
pnpm install
pnpm lint
pnpm test
./scripts/dev-up.sh
./scripts/db-migrate.sh
pnpm dev
```

## 目录优先级

1. 先读 `docs/00_overall_plan.md` 和 `docs/01_engineering_standards.md`。
2. 再读各 app 下的 `docs/DEV_PLAN.md` 与 `docs/DEV_SPEC.md`。
3. 按 `docs/10_milestones_acceptance.md` 建立迭代验收。

## v1.5 技术栈定版

本版本补充技术栈定版与依赖版本治理：

- `docs/11_technology_stack_matrix.md`：总体技术栈矩阵、每个 app 技术栈、共享 packages、数据中间件基线。
- `docs/12_dependency_version_policy.md`：依赖版本锁定、升级、安全补丁、审批规范。
- `docs/TECH_STACK_QUICK_REFERENCE.md`：研发速查表。

生产自研服务仍保持 4 个：`control-plane`、`runtime-api`、`runtime-worker`、`tool-gateway`。
