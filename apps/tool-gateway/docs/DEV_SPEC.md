# tool-gateway 开发规范

## 模块划分

```text
modules/tool-registry-cache
modules/schema-validator
modules/policy-engine
modules/idempotency
modules/rate-limit
modules/audit
modules/adapters/http
modules/adapters/mcp
modules/adapters/mock
modules/adapters/internal-api
```

## Tool Invoke API

```http
POST /v1/tools/invoke
```

请求必须包含：

```json
{
  "tool_name": "customer.profile.read",
  "tool_version": "1.0.0",
  "tenant_id": "tenant_001",
  "user_context": {},
  "task_context": {},
  "arguments": {},
  "idempotency_key": "task_001:step_003"
}
```

## Policy 决策

工具执行前必须经过 Policy：

```text
allow：直接执行。
confirm：返回需要人工确认。
deny：拒绝执行。
mask：执行但返回结果脱敏。
```

## 审计规范

每次工具调用必须记录：

```text
tool_name, tool_version, tenant_id, user_id, task_run_id, workflow_id,
input_hash, output_hash, risk_level, policy_decision, duration_ms,
status, error_code, adapter_type, idempotency_key
```

## 幂等规范

L3 及以上工具必须校验 `idempotency_key`。重复请求返回第一次执行结果或明确的重复状态，不允许重复提交副作用。

## 禁止事项

- 禁止绕过 Policy 直接执行 Adapter。
- 禁止把完整敏感输出写入日志。
- 禁止在 Tool Gateway 内部执行 Agent Loop。

## 测试要求

- ToolManifest 校验单测。
- Policy 决策单测。
- Adapter 集成测试。
- 幂等并发测试。
- 审计完整性测试。
