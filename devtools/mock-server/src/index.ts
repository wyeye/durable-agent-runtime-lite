import { pathToFileURL } from 'node:url';
import { buildServer } from './app.js';

export { buildServer } from './app.js';

async function start() {
  const server = buildServer();
  await server.listen({
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 4100),
  });
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  start().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
