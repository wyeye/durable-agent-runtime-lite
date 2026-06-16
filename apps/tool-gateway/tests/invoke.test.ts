import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

describe('tool-gateway invoke', () => {
  it('invokes knowledge.search through mock adapter', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_1' },
        arguments: { query: 'mvp' },
        idempotency_key: 'task_1:knowledge.search',
        request_id: 'req_1',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('succeeded');
    await server.close();
  });

  it('replays same idempotency key and writes audit event', async () => {
    const server = buildServer();
    const payload = {
      tool_version: '1.0.0',
      tenant_id: 'tenant_1',
      user_context: { user_id: 'user_1' },
      task_context: { task_run_id: 'task_2' },
      arguments: { record: { title: 'demo' } },
      idempotency_key: 'task_2:record.write.mock',
      request_id: 'req_2',
    };
    const first = await server.inject({ method: 'POST', url: '/v1/tools/record.write.mock/invoke', payload });
    const second = await server.inject({ method: 'POST', url: '/v1/tools/record.write.mock/invoke', payload });
    expect(first.json().data.status).toBe('succeeded');
    expect(second.json().data).toEqual(first.json().data);

    const audit = await server.inject({ method: 'GET', url: '/v1/audit-events' });
    expect(audit.json().data).toHaveLength(2);
    expect(audit.json().data[1].reason).toBe('idempotency_replay');
    await server.close();
  });

  it('rejects invalid arguments with standard error', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/knowledge.search/invoke',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_3' },
        arguments: {},
        idempotency_key: 'task_3:knowledge.search',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      data: null,
      error: { code: 'TOOL_ARGUMENT_VALIDATION_FAILED' },
    });

    const audit = await server.inject({ method: 'GET', url: '/v1/audit-events' });
    expect(audit.json().data).toHaveLength(1);
    expect(audit.json().data[0].result).toBe('denied');
    await server.close();
  });

  it('returns standard error for unknown tools', async () => {
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/tools/unknown.tool/invoke',
      payload: {
        tool_version: '1.0.0',
        tenant_id: 'tenant_1',
        user_context: { user_id: 'user_1' },
        task_context: { task_run_id: 'task_4' },
        arguments: {},
        idempotency_key: 'task_4:unknown.tool',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      success: false,
      data: null,
      error: { code: 'TOOL_NOT_FOUND' },
    });
    await server.close();
  });
});
