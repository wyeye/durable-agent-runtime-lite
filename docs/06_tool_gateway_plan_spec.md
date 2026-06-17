# tool-gateway 开发计划

## 定位

`tool-gateway` 是工具安全边界和副作用出口。所有外部系统、数据库、MCP Server、SaaS API、内部 API 都必须通过它调用。它负责工具注册、Schema 校验、权限策略、限流、幂等、审计和 Adapter。

## 阶段计划

| 阶段 | 目标 | 主要任务 | 验收 |
|---|---|---|---|
| TG-M1 | 网关基线 | Tool Invoke API、Manifest 加载、健康检查 | 可调用 Mock 工具 |
| TG-M2 | Schema 校验 | 输入输出 Zod/JSON Schema 校验、错误码 | 非法参数被拦截 |
| TG-M3 | Policy | RBAC/ABAC、风险等级、确认策略、工具白名单 | 无权限工具被拒绝 |
| TG-M4 | Adapter | HTTP Adapter、MCP Adapter 占位、DB/内部 API Adapter 占位 | 可配置化调用外部 API |
| TG-M5 | Audit | 调用日志、耗时、结果摘要、失败原因、成本 | 可按 task_run 查询工具轨迹 |
| TG-M6 | 可靠性 | 限流、熔断、重试、幂等、超时、降级 | 压测和异常测试通过 |

## 工具风险等级

- L0：纯计算、纯格式化。
- L1：只读查询。
- L2：生成草稿或中风险建议。
- L3：有外部副作用的写操作。
- L4：高敏感、不可逆、高权限动作，默认禁止 Agent 自动执行。



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
