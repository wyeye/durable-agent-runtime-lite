# Current Status

当前平台版本：0.8.0。

当前 migration head：`001_baseline.sql`。

已完成能力：

- 四应用架构和 `pnpm` workspace 基线。
- DB-backed Registry、不可变 execution plan、Temporal workflow 与 replay gate。
- Tool Gateway policy/idempotency/audit，含 mock sandbox adapter 与 `http_readonly` adapter。
- Pi Agent Core 分段运行，生产模型路径使用 DB-backed Model Gateway catalog。
- Tenant Runtime Policy、Snapshot Lineage、Admission Control。
- Evaluation 数据模型、运行、证据、评分、Gate Decision 与 UI。
- Control-plane visual configuration。
- Docker 四生产 app 镜像和本地 compose。
- `devtools/repo-cli` 统一 check、smoke、replay、db、ops、dev 命令。
- `devtools/mock-server` 作为外部系统 Mock 唯一服务。

真实未完成项：

- V1 GA release 尚未创建。
- 真实 live model provider gate 仍需显式 secret 与人工触发。
- 写侧业务 adapter、MCP tools、OAuth tools、SQL/browser automation tools 不在当前范围。

已知风险：

- `record.write.mock` 仍作为唯一 L3 sandbox adapter 例外保留，后续应由真实 sandbox HTTP write adapter 替换。
- Ollama real suite 依赖 self-hosted 环境和宿主机模型，不属于普通 hosted CI。

下一步一项：

- 在不改变业务语义的前提下，继续收敛 sandbox write adapter 的替代方案。
