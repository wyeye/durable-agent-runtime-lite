import { createLogger } from '@dar/logger';

const logger = createLogger('runtime-api');

async function main() {
  logger.info({ app: 'runtime-api', event: 'startup' }, 'runtime-api starting');
  // TODO: bootstrap runtime-api modules.
}

main().catch((error) => {
  logger.error({ err: error }, 'runtime-api startup failed');
  process.exit(1);
});
