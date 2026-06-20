import { describe, expect, it } from 'vitest';
import { getAppPort, getBuildInfo, getToolGatewayUrl, loadConfig } from '../src/index.js';

describe('runtime config', () => {
  it('loads local-safe defaults when env is absent', () => {
    const config = loadConfig({});
    expect(config.HOST).toBe('0.0.0.0');
    expect(config.DATABASE_URL).toContain('localhost');
    expect(getAppPort('runtime-api', config)).toBe(3001);
    expect(getToolGatewayUrl(config)).toBe('http://localhost:3003');
    expect(config.RUNTIME_WORKER_MODE).toBe('mock');
    expect(config.RUNTIME_API_WORKFLOW_STARTER).toBe('mock');
    expect(getBuildInfo('runtime-api', config)).toEqual({
      service: 'runtime-api',
      version: '0.8.0',
      build_sha: 'unknown',
      build_time: 'unknown',
    });
  });

  it('treats empty optional environment values as absent', () => {
    const config = loadConfig({ PORT: '', TOOL_GATEWAY_URL: '' });
    expect(config.PORT).toBeUndefined();
    expect(getAppPort('tool-gateway', config)).toBe(3003);
  });

  it('parses explicit control-plane static serving flags', () => {
    expect(loadConfig({ CONTROL_PLANE_STATIC_ENABLED: 'true' }).CONTROL_PLANE_STATIC_ENABLED).toBe(true);
    expect(loadConfig({ CONTROL_PLANE_STATIC_ENABLED: 'false' }).CONTROL_PLANE_STATIC_ENABLED).toBe(false);
    expect(loadConfig({ CONTROL_PLANE_STATIC_ENABLED: '' }).CONTROL_PLANE_STATIC_ENABLED).toBe(false);
  });
});
