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

export async function handleIam(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') {
    console.log('Usage: pnpm dar iam bootstrap-admin [--user-id <id>] [--display-name <name>] [--email <email>]');
    console.log('       pnpm dar iam seed-local');
    return;
  }
  if (command === 'bootstrap-admin') {
    assertSuccess(
      await runCommand('tsx', ['devtools/repo-cli/src/scripts/iam-bootstrap.ts', ...rest], { inherit: true }),
      'iam bootstrap-admin',
    );
    return;
  }
  if (command === 'seed-local') {
    assertSuccess(
      await runCommand('tsx', ['devtools/repo-cli/src/scripts/iam-seed-local.ts', ...rest], { inherit: true }),
      'iam seed-local',
    );
    return;
  }
  throw new Error(`Unknown iam command: ${command}`);
}

export async function handleDev(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === 'help') {
    console.log('Usage: pnpm dar dev up|down [--ollama]');
    return;
  }
  const useOllama = rest.includes('--ollama');
  const composeArgs = useOllama
    ? ['compose', '-f', 'infra/docker-compose.yml', '-f', 'infra/docker-compose.ollama.yml']
    : ['compose', '-f', 'infra/docker-compose.yml'];
  if (command === 'up') {
    assertSuccess(await runCommand('docker', [...composeArgs, 'up', '-d'], { inherit: true }), useOllama ? 'dev up --ollama' : 'dev up');
    return;
  }
  if (command === 'down') {
    assertSuccess(await runCommand('docker', [...composeArgs, 'down'], { inherit: true }), useOllama ? 'dev down --ollama' : 'dev down');
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
