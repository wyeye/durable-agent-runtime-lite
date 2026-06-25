# Current Status

当前平台版本：0.8.0。

当前 migration head：`002_iam_directory.sql`。

已完成能力：

- 四应用架构和 `pnpm` workspace 基线。
- DB-backed Registry、不可变 execution plan、Temporal workflow 与 replay gate。
- Tool Gateway policy/idempotency/audit，含 mock sandbox adapter 与 `http_readonly` adapter。
- Pi Agent Core 分段运行，生产模型路径使用 DB-backed Model Gateway catalog。
- Tenant Runtime Policy、Snapshot Lineage、Admission Control。
- Evaluation 数据模型、运行、证据、评分、Gate Decision 与 UI。
- Control-plane visual configuration。
- Docker 四生产 app 镜像和本地 compose。
- `devtools/repo-cli` 统一 check、smoke、replay、db、ops、dev、iam 命令。
- `devtools/mock-server` 作为外部系统 Mock 唯一服务。
- IAM Directory：租户、用户、成员关系和固定角色的 DB-backed 身份目录。
- DB mode 身份解析：不信任 Header Roles，从数据库查询角色和成员关系。
- IAM 管理 API 和前端页面（租户管理、用户管理、角色说明）。

真实未完成项：

- V1 GA release 尚未创建。
- 真实 live model provider gate 仍需显式 secret 与人工触发。
- 写侧业务 adapter、MCP tools、OAuth tools、SQL/browser automation tools 不在当前范围。
- 密码登录、SSO、JWT 签发不在 IAM-MVP-1 范围。
- Chat 页面和 Conversation 数据模型不在当前范围。

已知风险：

- `record.write.mock` 仍作为唯一 L3 sandbox adapter 例外保留，后续应由真实 sandbox HTTP write adapter 替换。
- Ollama real suite 依赖 self-hosted 环境和宿主机模型，不属于普通 hosted CI。
- IAM_DIRECTORY_MODE=header 仅为开发兼容模式，生产必须使用 db。

下一步一项：

- CHAT-MVP-1：基于 IAM Directory 的用户、租户和会话所有权基础。
