#!/usr/bin/env node
import { handleDb, handleDev, handleOps, handleReplay } from './commands/basic.js';
import { handleCheck } from './commands/check.js';
import { handleSmoke } from './commands/smoke.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'check') {
    await handleCheck(args);
    return;
  }
  if (command === 'smoke') {
    await handleSmoke(args);
    return;
  }
  if (command === 'dev') {
    await handleDev(args);
    return;
  }
  if (command === 'db') {
    await handleDb(args);
    return;
  }
  if (command === 'ops') {
    await handleOps(args);
    return;
  }
  if (command === 'replay') {
    await handleReplay(args);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

function printHelp(): void {
  console.log(`Usage:
  pnpm dar check all|docs|mocks|version|i18n|visual-config
  pnpm dar smoke list|run|suite
  pnpm dar dev up|down
  pnpm dar db migrate|seed
  pnpm dar ops reconcile-admissions
  pnpm dar replay export|test`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
