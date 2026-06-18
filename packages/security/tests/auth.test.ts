import { describe, expect, it } from 'vitest';
import {
  AuthError,
  hasControlPlanePermission,
  parseAuthContext,
  requireAuthContext,
  requireControlPlanePermission,
} from '../src/index.js';

describe('control-plane header auth and RBAC', () => {
  it('parses identity, roles, and request id from headers', () => {
    const auth = parseAuthContext({
      'x-user-id': 'operator_1',
      'x-tenant-id': 'tenant_1',
      'x-roles': 'platform_admin, auditor',
      'x-request-id': 'req_1',
    });

    expect(auth).toMatchObject({
      user_id: 'operator_1',
      tenant_id: 'tenant_1',
      request_id: 'req_1',
      roles: ['platform_admin', 'auditor'],
    });
  });

  it('rejects missing header identity and production disabled mode', () => {
    expect(() => requireAuthContext({}, { authMode: 'header', nodeEnv: 'production' })).toThrow(AuthError);
    expect(() =>
      requireAuthContext({}, {
        authMode: 'disabled',
        nodeEnv: 'production',
        testIdentity: { tenant_id: 'tenant_1', user_id: 'admin', roles: ['platform_admin'] },
      }),
    ).toThrow(/not allowed in production/);
  });

  it('allows disabled auth only outside production with explicit test identity', () => {
    const auth = requireAuthContext({}, {
      authMode: 'disabled',
      nodeEnv: 'test',
      testIdentity: { tenant_id: 'tenant_1', user_id: 'test_admin', roles: ['platform_admin'] },
    });

    expect(auth.user_id).toBe('test_admin');
    expect(hasControlPlanePermission(auth, 'registry:disable')).toBe(true);
  });

  it('enforces platform_admin, capability_operator, and auditor permissions', () => {
    const admin = { tenant_id: 'tenant_1', user_id: 'admin', roles: ['platform_admin'] };
    const operator = { tenant_id: 'tenant_1', user_id: 'operator', roles: ['capability_operator'] };
    const auditor = { tenant_id: 'tenant_1', user_id: 'auditor', roles: ['auditor'] };

    expect(hasControlPlanePermission(admin, 'registry:disable')).toBe(true);
    expect(hasControlPlanePermission(operator, 'registry:publish')).toBe(true);
    expect(hasControlPlanePermission(operator, 'registry:disable')).toBe(false);
    expect(hasControlPlanePermission(auditor, 'registry:read')).toBe(true);
    expect(hasControlPlanePermission(auditor, 'registry:write')).toBe(false);
    expect(() => requireControlPlanePermission(auditor, 'human_task:decide')).toThrow(AuthError);
  });
});
