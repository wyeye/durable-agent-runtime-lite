import { createLogger } from '@dar/logger';

const logger = createLogger('runtime-worker');

async function main() {
  logger.info({ app: 'runtime-worker', event: 'startup' }, 'runtime-worker starting');
  // TODO: bootstrap runtime-worker modules.
}

main().catch((error) => {
  logger.error({ err: error }, 'runtime-worker startup failed');
  process.exit(1);
});
