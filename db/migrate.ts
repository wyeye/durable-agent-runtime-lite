import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query(`
      create table if not exists schema_migration (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();

    for (const file of files) {
      const version = basename(file, '.sql');
      const migrationSql = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(migrationSql).digest('hex');
      const applied = await client.query<{ checksum: string }>(
        'select checksum from schema_migration where version = $1',
        [version],
      );

      if (applied.rowCount) {
        if (applied.rows[0]?.checksum !== checksum) {
          throw new Error(`migration checksum mismatch: ${version}`);
        }
        console.log(`skip ${file}`);
        continue;
      }

      await client.query('begin');
      try {
        await client.query(migrationSql);
        await client.query('insert into schema_migration(version, checksum) values ($1, $2)', [
          version,
          checksum,
        ]);
        await client.query('commit');
        console.log(`applied ${file}`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
