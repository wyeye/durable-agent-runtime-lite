import { createLogger } from '@dar/logger';

const logger = createLogger('tool-gateway');

async function main() {
  logger.info({ app: 'tool-gateway', event: 'startup' }, 'tool-gateway starting');
  // TODO: bootstrap tool-gateway modules.
}

main().catch((error) => {
  logger.error({ err: error }, 'tool-gateway startup failed');
  process.exit(1);
});
