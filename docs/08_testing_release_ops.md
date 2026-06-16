# 08 测试、发布与运维规范

## 测试分层

| 类型 | 目标 | 必跑时机 |
|---|---|---|
| Unit | 函数、Schema、策略、解释器 | 每次提交 |
| Integration | DB、Temporal、Tool Gateway、Router | PR 合入前 |
| Contract | API、事件、Spec Schema | PR 合入前 |
| E2E | 发布到执行到审计闭环 | 每个迭代结束 |
| Load | Router QPS、Tool Gateway 并发、Worker 吞吐 | 试点前 |

## CI 流程

```text
install -> lint -> typecheck -> unit -> contract -> build -> image scan -> integration -> publish artifact
```

## CD 流程

```text
dev -> test -> staging -> pilot -> production
```

生产发布必须支持：灰度、回滚、配置冻结、数据库迁移回退方案。

## 运维指标

- Router 命中率、低置信度率、澄清率。
- Workflow 成功率、失败率、平均耗时、重试次数。
- Agent Loop 步数、Token 成本、工具请求次数。
- Tool Gateway 成功率、失败率、拒绝率、确认率、P95 延迟。
- Human Task 待处理量、超时量、确认通过率。
