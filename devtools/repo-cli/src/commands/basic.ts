import { assertSuccess, runCommand } from '../support/process.js';

export async function handleDb(args: string[]): Promise<void> {
  const [command] = args;
  if (!command || command === '--help' || command === 'help') {
    console.log('Usage: pnpm dar db migrate|seed');
    return;
  }
  if (command === 'migrate') {
    assertSuccess(await runCommand('tsx', ['db/migrate.ts'], { inherit: true }), 'db migrate');
    return;
  }
  if (command === 'seed') {
    assertSuccess(await runCommand('tsx', ['devtools/repo-cli/src/scripts/seed-examples.ts'], { inherit: true }), 'db seed');
    return;
  }
  throw new Error(`Unknown db command: ${command}`);
}

export async function handleDev(args: string[]): Promise<void> {
  const [command] = args;
  if (!command || command === '--help' || command === 'help') {
    console.log('Usage: pnpm dar dev up|down');
    return;
  }
  if (command === 'up') {
    assertSuccess(await runCommand('docker', ['compose', '-f', 'infra/docker-compose.yml', 'up', '-d'], { inherit: true }), 'dev up');
    return;
  }
  if (command === 'down') {
    assertSuccess(await runCommand('docker', ['compose', '-f', 'infra/docker-compose.yml', 'down'], { inherit: true }), 'dev down');
    return;
  }
  throw new Error(`Unknown dev command: ${command}`);
}

export async function handleOps(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') {
    console.log('Usage: pnpm dar ops reconcile-admissions [args]');
    return;
  }
  if (command === 'reconcile-admissions') {
    if (rest.includes('--help') || rest.includes('help')) {
      console.log('Usage: pnpm dar ops reconcile-admissions [--apply] [--tenant-id <id>] [--batch-size <n>] [--stale-after-ms <ms>]');
      return;
    }
    assertSuccess(
      await runCommand('tsx', ['devtools/repo-cli/src/scripts/reconcile-tenant-agent-admissions.ts', ...rest], { inherit: true }),
      'ops reconcile-admissions',
    );
    return;
  }
  throw new Error(`Unknown ops command: ${command}`);
}

export async function handleReplay(args: string[]): Promise<void> {
  const [command] = args;
  if (!command || command === '--help' || command === 'help') {
    console.log('Usage: pnpm dar replay export|test');
    return;
  }
  if (command === 'export') {
    assertSuccess(await runCommand('tsx', ['devtools/repo-cli/src/scripts/export-temporal-replay-fixtures.ts'], { inherit: true }), 'replay export');
    return;
  }
  if (command === 'test') {
    assertSuccess(await runCommand('vitest', ['run', 'tests/temporal-replay', '--config', 'vitest.root.config.ts'], { inherit: true }), 'replay test');
    return;
  }
  throw new Error(`Unknown replay command: ${command}`);
}
