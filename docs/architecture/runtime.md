# Runtime Architecture

`runtime-api` 负责请求上下文、路由、TaskRun 创建和 Workflow 启动。它不调用外部业务系统、不执行工具、不直接运行 Pi。

`runtime-worker` 负责 Temporal Worker、Workflow、Activity、ConfigDrivenWorkflow、GenericAgentWorkflow、Human Task signal、FlowSpec snapshot 加载、Tool Gateway 调用和 Pi Runner 包装。

重要约束：

- Workflow input 必须稳定，FlowSpec version 在 workflow 启动时锁定。
- Running workflow 不受新发布 FlowSpec 影响。
- DB、HTTP、LLM、Pi、tool call 都在 Activity 或 service adapter 中执行。
- 大文档、长 prompt、大 tool result 和附件不进入 Temporal history，只保存引用。
- `PI_AGENT_MODE=model_gateway` 是生产要求。
- `PI_AGENT_MODE=deterministic` 仅允许测试支持代码，不作为生产 app 内外部响应生成器。

Model call ledger 记录 provider、model、gateway profile、credential fingerprint/revision、response id、attempt 和 fallback index。Replay fixture 由 `pnpm dar replay export` 导出，并由 `pnpm dar replay test` 验证 deterministic workflow compatibility。
