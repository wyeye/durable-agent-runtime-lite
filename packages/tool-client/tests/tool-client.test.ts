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
    let observedServiceId = '';
    let observedAuthorization = '';
    const server = await startTestServer((request, response) => {
      observedUrl = request.url ?? '';
      observedServiceId = String(request.headers['x-service-id'] ?? '');
      observedAuthorization = String(request.headers.authorization ?? '');
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
      const client = new ToolGatewayClient({
        baseUrl: server.baseUrl,
        serviceIdentity: { serviceId: 'runtime-worker', token: 'worker-token' },
      });
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
      expect(observedServiceId).toBe('runtime-worker');
      expect(observedAuthorization).toBe('Bearer worker-token');
      expect(JSON.parse(observedBody)).toMatchObject({ tool_name: 'knowledge.search' });
      expect(result.status).toBe('succeeded');
      expect(result.audit_event_id).toBe('audit_1');
    } finally {
      await server.close();
    }
  });

  it('posts to preview and commit endpoints', async () => {
    const observedUrls: string[] = [];
    const server = await startTestServer((request, response) => {
      observedUrls.push(request.url ?? '');
      request.resume();
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        if ((request.url ?? '').endsWith('/preview')) {
          response.end(JSON.stringify({
            success: true,
            data: {
              tool_call_id: 'tool_call_1',
              tool_name: 'record.write.mock',
              tool_version: '1.0.0',
              mode: 'preview',
              status: 'pending_confirmation',
              policy: {
                decision: 'require_human_confirm',
                risk_level: 'L3',
                reason: 'side_effect_requires_human_confirm',
                requires_human_confirm: true,
              },
              preview: { planned: true },
              audit_event_id: 'audit_1',
              idempotency_key: 'task_1:record.write.mock:preview',
            },
            error: null,
          }));
          return;
        }

        response.end(JSON.stringify({
          success: true,
          data: {
            tool_call_id: 'tool_call_1',
            tool_name: 'record.write.mock',
            tool_version: '1.0.0',
            mode: 'commit',
            status: 'committed',
            result: { written: true },
            audit_event_id: 'audit_2',
            idempotency_key: 'task_1:record.write.mock:commit',
          },
          error: null,
        }));
      });
    });

    try {
      const client = new ToolGatewayClient({ baseUrl: server.baseUrl });
      const preview = await client.preview({
        tool_name: 'record.write.mock',
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_1' },
        arguments: { record: { title: 'demo' } },
        idempotency_key: 'task_1:record.write.mock:preview',
      });
      const commit = await client.commit({
        tool_call_id: preview.tool_call_id,
        tool_name: 'record.write.mock',
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_1' },
        arguments: { record: { title: 'demo' } },
        idempotency_key: 'task_1:record.write.mock:commit',
      });

      expect(observedUrls).toEqual([
        '/v1/tools/record.write.mock/preview',
        '/v1/tools/record.write.mock/commit',
      ]);
      expect(preview.status).toBe('pending_confirmation');
      expect(commit.status).toBe('committed');
    } finally {
      await server.close();
    }
  });

  it('returns standard denied invoke responses instead of throwing', async () => {
    const server = await startTestServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.statusCode = 400;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          success: false,
          data: null,
          error: {
            code: 'TOOL_EVALUATION_CALL_LIMIT_EXCEEDED',
            message: 'Evaluation tool call limit exceeded for this case',
            details: {
              audit_event_id: 'audit_denied',
              idempotency_key: 'task_1:knowledge.search:second',
              tool_name: 'knowledge.search',
              tool_version: '1.0.0',
            },
          },
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
        arguments: { query: 'second' },
        idempotency_key: 'task_1:knowledge.search:second',
        request_id: 'req_1',
      });

      expect(result).toMatchObject({
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        status: 'denied',
        audit_event_id: 'audit_denied',
        idempotency_key: 'task_1:knowledge.search:second',
        error: {
          code: 'TOOL_EVALUATION_CALL_LIMIT_EXCEEDED',
        },
      });
    } finally {
      await server.close();
    }
  });

  it('throws standard non-policy failures instead of converting them to denied tool results', async () => {
    const server = await startTestServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.statusCode = 500;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          success: false,
          data: null,
          error: {
            code: 'INTERNAL_ERROR',
            message: '服务处理失败',
          },
        }));
      });
    });

    try {
      const client = new ToolGatewayClient({ baseUrl: server.baseUrl });
      await expect(client.invoke({
        tool_name: 'knowledge.search',
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_1' },
        arguments: { query: 'second' },
        idempotency_key: 'task_1:knowledge.search:second',
        request_id: 'req_1',
      })).rejects.toThrow('INTERNAL_ERROR: 服务处理失败');
    } finally {
      await server.close();
    }
  });
});
