import { describe, expect, it } from 'vitest';
import {
  AuthError,
  ServiceAuthError,
  StaticServiceTokenVerifier,
  buildServiceIdentityHeaders,
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
    ).toThrow(/Header authentication is required in production/);
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

describe('service token auth', () => {
  it('verifies service identity with constant-time token path and permissions', () => {
    const verifier = new StaticServiceTokenVerifier({
      authMode: 'service_token',
      nodeEnv: 'production',
      tokens: {
        'runtime-worker': 'worker-token',
        'control-plane': 'control-token',
      },
    });

    const identity = verifier.verify({
      ...buildServiceIdentityHeaders({
        serviceId: 'runtime-worker',
        token: 'worker-token',
        requestId: 'req_1',
        tenantId: 'tenant_1',
        userId: 'user_1',
      }),
    }, 'tool:invoke');

    expect(identity).toMatchObject({
      service_id: 'runtime-worker',
      request_id: 'req_1',
      tenant_id: 'tenant_1',
      user_id: 'user_1',
    });
  });

  it('rejects missing, mismatched, and unauthorized service tokens', () => {
    const verifier = new StaticServiceTokenVerifier({
      authMode: 'service_token',
      nodeEnv: 'production',
      tokens: {
        'runtime-worker': 'worker-token',
        'control-plane': 'control-token',
      },
    });

    expect(() => verifier.verify({ 'x-service-id': 'runtime-worker' }, 'tool:invoke')).toThrow(ServiceAuthError);
    expect(() =>
      verifier.verify(buildServiceIdentityHeaders({ serviceId: 'runtime-worker', token: 'control-token' }), 'tool:invoke'),
    ).toThrow(/Invalid service bearer token/);
    expect(() =>
      verifier.verify(buildServiceIdentityHeaders({ serviceId: 'control-plane', token: 'control-token' }), 'tool:invoke'),
    ).toThrow(/not allowed/);
  });

  it('does not allow disabled service auth in production', () => {
    const verifier = new StaticServiceTokenVerifier({
      authMode: 'disabled',
      nodeEnv: 'production',
      tokens: {},
    });

    expect(() => verifier.verify({}, 'tool:invoke')).toThrow(/not allowed in production/);
  });
});
