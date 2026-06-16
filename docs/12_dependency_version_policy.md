# 12 依赖版本治理与升级规范 v1.5

## 1. 版本层级

| 层级 | 锁定方式 | 说明 |
|---|---|---|
| Runtime | `.nvmrc`、`.node-version`、Docker image、`engines` | Node.js 必须一致，避免本地与镜像差异 |
| Package Manager | `packageManager` + Corepack | 团队统一 pnpm 版本 |
| npm 依赖 | `package.json` 主版本范围 + `pnpm-lock.yaml` | 开发阶段允许补丁升级，测试环境锁 lockfile |
| 镜像 | 开发使用 tag，生产使用 digest | 避免中间件镜像漂移 |
| Flow/Agent/Tool/Prompt | 业务版本号 + hash | 每次执行记录版本与 hash |

## 2. 禁止项

- 禁止在生产分支使用 `latest` 依赖。
- 禁止绕过 `pnpm-lock.yaml` 部署。
- 禁止在 app 内重复定义跨服务 DTO。
- 禁止 `runtime-worker` 直接访问业务系统。
- 禁止 Pi 持有业务系统 Token。
- 禁止工具 Adapter 绕过 Tool Gateway 审计。

## 3. 升级流程

1. 创建 `chore/deps-YYYYMMDD` 分支。
2. 升级依赖并更新 lockfile。
3. 运行 lint、typecheck、unit、contract、integration、e2e。
4. 对 Temporal Workflow 执行 replay 检查。
5. 生成依赖变更说明，标注 breaking changes。
6. 先部署测试环境，再灰度生产。
7. 出现异常时回滚镜像与 lockfile。

## 4. 安全补丁策略

- Critical：当天评估，当天或次日完成修复与灰度。
- High：3 个工作日内处理。
- Medium：进入下一个小版本迭代。
- Low：合并到例行依赖升级。
