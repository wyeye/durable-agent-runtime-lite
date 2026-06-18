import { pathToFileURL } from 'node:url';
import { getAppPort, loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { createApp } from './app.js';

const appName = 'control-plane' as const;
const logger = createLogger(appName);

export async function start(): Promise<void> {
  const config = loadConfig();
  const handle = await createApp({ config });
  const port = getAppPort(appName, config);

  const shutdown = async () => {
    await handle.close();
    logger.info({ app: appName }, `${appName} stopped`);
  };
  process.once('SIGTERM', () => {
    shutdown().catch((error: unknown) => {
      logger.error({ err: error }, `${appName} shutdown failed`);
      process.exit(1);
    });
  });

  await handle.app.listen({ host: config.HOST, port });
  logger.info({ app: appName, port, host: config.HOST }, `${appName} listening`);
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  start().catch((error: unknown) => {
    logger.error({ err: error }, `${appName} startup failed`);
    process.exit(1);
  });
}
