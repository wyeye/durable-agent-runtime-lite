import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { FastifyInstance } from 'fastify';

const excludedPrefixes = ['/api/', '/healthz', '/readyz', '/version', '/openapi.json', '/docs'];

export async function staticFilesPlugin(server: FastifyInstance, options: { rootDir: string }): Promise<void> {
  server.setNotFoundHandler(async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply.code(404);
      return {
        success: false,
        data: null,
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      };
    }

    if (excludedPrefixes.some((prefix) => request.url === prefix || request.url.startsWith(prefix))) {
      reply.code(404);
      return {
        success: false,
        data: null,
        error: { code: 'NOT_FOUND', message: 'Route not found' },
      };
    }

    const pathname = decodeURIComponent(request.url.split('?')[0] ?? '/');
    const filePath = await resolveAssetPath(options.rootDir, pathname);
    const content = await readFile(filePath);
    reply.type(contentType(filePath));
    return content;
  });
}

async function resolveAssetPath(rootDir: string, pathname: string): Promise<string> {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]/, '');
  const candidate = join(rootDir, safePath || 'index.html');
  if (candidate.startsWith(rootDir)) {
    const file = await stat(candidate).catch(() => undefined);
    if (file?.isFile()) {
      return candidate;
    }
  }
  return join(rootDir, 'index.html');
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  if (filePath.endsWith('.js')) {
    return 'text/javascript; charset=utf-8';
  }
  if (filePath.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (filePath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (filePath.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (filePath.endsWith('.png')) {
    return 'image/png';
  }
  return 'application/octet-stream';
}
