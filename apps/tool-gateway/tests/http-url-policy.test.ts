import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '@dar/contracts';
import { HttpToolUrlPolicy } from '../src/modules/http-url-policy.js';

describe('HttpToolUrlPolicy', () => {
  it('allows explicit https hosts', async () => {
    const policy = new HttpToolUrlPolicy({ allowedHosts: ['example.com'], allowInsecureLocalhost: false });
    await expect(policy.validate(manifest({ base_url: 'https://example.com', path: '/v1/policies' }))).resolves.toMatchObject({
      hostname: 'example.com',
    });
  });

  it('allows localhost http only when test switch is explicit', async () => {
    const policy = new HttpToolUrlPolicy({ allowedHosts: ['localhost'], allowInsecureLocalhost: true });
    await expect(policy.validate(manifest({ base_url: 'http://localhost:4100' }))).resolves.toMatchObject({
      hostname: 'localhost',
    });
  });

  it('allows mock-server http only when test switch is explicit', async () => {
    const policy = new HttpToolUrlPolicy({ allowedHosts: ['mock-server'], allowInsecureLocalhost: true });
    await expect(policy.validate(manifest({ base_url: 'http://mock-server:4100' }))).resolves.toMatchObject({
      hostname: 'mock-server',
    });
  });

  it('denies insecure production http, unlisted host, credentials and metadata IPs', async () => {
    await expect(new HttpToolUrlPolicy({ allowedHosts: ['api.example.com'], allowInsecureLocalhost: false }).validate(manifest({ base_url: 'http://api.example.com' }))).rejects.toMatchObject({ code: 'TOOL_HTTP_INSECURE_URL' });
    await expect(new HttpToolUrlPolicy({ allowedHosts: ['api.example.com'], allowInsecureLocalhost: false }).validate(manifest({ base_url: 'https://other.example.com' }))).rejects.toMatchObject({ code: 'TOOL_HTTP_HOST_NOT_ALLOWED' });
    await expect(new HttpToolUrlPolicy({ allowedHosts: ['api.example.com'], allowInsecureLocalhost: false }).validate(manifest({ base_url: 'https://user:pass@api.example.com' }))).rejects.toMatchObject({ code: 'TOOL_HTTP_INSECURE_URL' });
    await expect(new HttpToolUrlPolicy({ allowedHosts: ['169.254.169.254'], allowInsecureLocalhost: false }).validate(manifest({ base_url: 'https://169.254.169.254' }))).rejects.toMatchObject({ code: 'TOOL_HTTP_HOST_NOT_ALLOWED' });
  });
});

function manifest(adapter: Partial<Extract<ToolManifest['adapter'], { type: 'http_readonly' }>>): ToolManifest {
  return {
    tool_name: 'company.policy.lookup',
    version: '1.0.0',
    risk_level: 'L1',
    side_effect: false,
    adapter: {
      type: 'http_readonly',
      base_url: 'https://example.com',
      path: '/business-api/v1/policies',
      query_mapping: {},
      auth: { type: 'none' },
      timeout_ms: 1000,
      max_response_bytes: 4096,
      retry: { max_attempts: 1, retryable_status_codes: [], backoff_ms: 0 },
      ...adapter,
    },
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    required_permissions: [],
  };
}
