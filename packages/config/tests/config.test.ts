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

  it('parses explicit boolean environment flags without truthy string fallback', () => {
    expect(loadConfig({ CONTROL_PLANE_STATIC_ENABLED: 'true' }).CONTROL_PLANE_STATIC_ENABLED).toBe(true);
    expect(loadConfig({ CONTROL_PLANE_STATIC_ENABLED: 'false' }).CONTROL_PLANE_STATIC_ENABLED).toBe(false);
    expect(loadConfig({ CONTROL_PLANE_STATIC_ENABLED: '' }).CONTROL_PLANE_STATIC_ENABLED).toBe(false);
    expect(loadConfig({ EVALUATION_WORKER_ENABLED: 'true' }).EVALUATION_WORKER_ENABLED).toBe(true);
    expect(loadConfig({ EVALUATION_WORKER_ENABLED: 'false' }).EVALUATION_WORKER_ENABLED).toBe(false);
    expect(loadConfig({ EVALUATION_WORKER_ENABLED: '0' }).EVALUATION_WORKER_ENABLED).toBe(false);
    expect(loadConfig({ TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED: 'off' }).TOOL_GATEWAY_DEBUG_ENDPOINTS_ENABLED).toBe(false);
    expect(loadConfig({ MODEL_GATEWAY_ALLOW_INSECURE_HTTP: 'false' }).MODEL_GATEWAY_ALLOW_INSECURE_HTTP).toBe(false);
    expect(loadConfig({ CONTROL_PLANE_SWAGGER_ENABLED: 'no' }).CONTROL_PLANE_SWAGGER_ENABLED).toBe(false);
  });
});
