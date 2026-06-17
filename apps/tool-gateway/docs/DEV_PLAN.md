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
