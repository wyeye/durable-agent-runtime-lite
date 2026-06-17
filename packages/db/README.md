# @dar/db

共享数据库包，提供 Kysely 连接、事务封装和基础 in-memory repository helper。

## Migration

本地启动 PostgreSQL/pgvector 后执行：

```bash
pnpm db:migrate
```

迁移文件位于 `db/migrations/`。生产环境应由发布流水线执行迁移，并保留 checksum 校验。
