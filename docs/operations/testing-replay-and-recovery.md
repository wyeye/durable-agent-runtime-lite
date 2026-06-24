# Testing Replay And Recovery

统一命令：

```bash
corepack pnpm dar check all
corepack pnpm dar smoke list
corepack pnpm dar smoke suite core
corepack pnpm dar smoke suite agent
corepack pnpm dar smoke suite governance
corepack pnpm dar smoke suite ui
corepack pnpm dar replay test
```

固定 smoke suites：

- `core`：db-registry、temporal-db、control-plane-api、semantic-router、http-readonly-tool。
- `agent`：pi-readonly、pi-l3、pi-user-input、pi-handoff、pi-model-gateway、worker-crash-resume。
- `governance`：tenant policy/snapshot/concurrency/deep-chain、evaluation、model-catalog、replay。
- `ui`：control-plane-ui、evaluation-ui。
- `real`：Ollama runtime/evaluation、live model provider。

Scenario contract 位于 `devtools/repo-cli/src/smoke/catalog.ts`，结果使用统一 `SmokeResult` 形状，artifact 归 `artifacts/smoke/<scenario>/` 或场景专属 artifact 目录。

Temporal replay：

```bash
corepack pnpm dar replay export
corepack pnpm dar replay test
```

Worker crash/resume smoke 会停止 runtime-worker，在 worker 停止期间写入 Human Task 信号，再重启并验证同一 workflow 恢复完成且无重复 commit、AgentStep、HumanTask 或审计事实。
