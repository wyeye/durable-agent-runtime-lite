# @dar/db

共享数据库包，提供 Kysely 连接、事务封装和基础 in-memory repository helper。

## Migration

本地启动 PostgreSQL/pgvector 后执行：

```bash
pnpm db:migrate
```

开发期迁移已整合为 `db/migrations/001_baseline.sql` 单一基线文件。该基线会重建 `public` schema，开发数据不做旧迁移兼容兜底。
