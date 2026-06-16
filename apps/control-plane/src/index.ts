import { createLogger } from '@dar/logger';

const logger = createLogger('control-plane');

async function main() {
  logger.info({ app: 'control-plane', event: 'startup' }, 'control-plane starting');
  // TODO: bootstrap control-plane modules.
}

main().catch((error) => {
  logger.error({ err: error }, 'control-plane startup failed');
  process.exit(1);
});
