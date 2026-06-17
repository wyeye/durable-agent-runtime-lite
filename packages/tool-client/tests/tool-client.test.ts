import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ToolGatewayClient } from '../src/index.js';

async function startTestServer(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind to tcp port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

describe('ToolGatewayClient', () => {
  it('posts to tool-specific invoke endpoint and unwraps standard response', async () => {
    let observedUrl = '';
    let observedBody = '';
    const server = await startTestServer((request, response) => {
      observedUrl = request.url ?? '';
      request.on('data', (chunk: Buffer) => {
        observedBody += chunk.toString('utf8');
      });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          success: true,
          data: {
            tool_name: 'knowledge.search',
            tool_version: '1.0.0',
            status: 'succeeded',
            result: { items: [] },
            audit_event_id: 'audit_1',
            idempotency_key: 'task_1:knowledge.search',
          },
          error: null,
        }));
      });
    });

    try {
      const client = new ToolGatewayClient({ baseUrl: server.baseUrl });
      const result = await client.invoke({
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_1' },
        arguments: { query: 'mvp' },
        idempotency_key: 'task_1:knowledge.search',
        request_id: 'req_1',
      });

      expect(observedUrl).toBe('/v1/tools/knowledge.search/invoke');
      expect(JSON.parse(observedBody)).toMatchObject({ tool_name: 'knowledge.search' });
      expect(result.status).toBe('succeeded');
      expect(result.audit_event_id).toBe('audit_1');
    } finally {
      await server.close();
    }
  });
});
