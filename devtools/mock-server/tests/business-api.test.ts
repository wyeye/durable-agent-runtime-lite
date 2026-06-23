import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

describe('mock business API', () => {
  it('serves policy lookup with bearer auth and stats', async () => {
    const server = buildServer();
    const unauthorized = await server.inject({ method: 'GET', url: '/business-api/v1/policies?keyword=差旅' });
    expect(unauthorized.statusCode).toBe(401);

    await server.inject({ method: 'POST', url: '/business-api/v1/reset' });
    const response = await server.inject({
      method: 'GET',
      url: '/business-api/v1/policies?keyword=差旅',
      headers: { authorization: 'Bearer business-read-secret' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [{ id: 'policy-1', title: '差旅报销政策' }] });

    const stats = await server.inject({ method: 'GET', url: '/business-api/v1/stats' });
    expect(stats.json()).toMatchObject({ request_count: 1, last_authorization: 'bearer_ok' });
    await server.close();
  });

  it('supports deterministic 429 then success', async () => {
    const server = buildServer();
    await server.inject({ method: 'POST', url: '/business-api/v1/reset' });
    const first = await server.inject({
      method: 'GET',
      url: '/business-api/v1/policies?keyword=rate_limit_then_success',
      headers: { authorization: 'Bearer business-read-secret' },
    });
    const second = await server.inject({
      method: 'GET',
      url: '/business-api/v1/policies?keyword=rate_limit_then_success',
      headers: { authorization: 'Bearer business-read-secret' },
    });
    expect(first.statusCode).toBe(429);
    expect(second.statusCode).toBe(200);
    await server.close();
  });
});
