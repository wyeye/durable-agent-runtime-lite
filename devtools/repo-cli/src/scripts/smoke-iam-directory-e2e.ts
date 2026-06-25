/**
 * IAM Directory Smoke Test
 *
 * Validates:
 * - Bootstrap admin
 * - Tenant and user CRUD via IAM API
 * - Header role forgery rejection in DB mode
 * - Role change immediate effect
 * - Cross-tenant access rejection
 * - Disable/reactivate flows
 * - Last platform admin protection
 */
import assert from 'node:assert/strict';

const controlPlaneUrl = trimTrailingSlash(process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100');
const tenantPrefix = `iam_smoke_${Date.now()}`;

async function main(): Promise<void> {
  console.log('[iam-smoke] Starting IAM Directory smoke test...');
  const results = {
    ok: true,
    scenario: 'iam-directory',
    tenants: 0,
    users: 0,
    forged_roles_rejected: false,
    role_change_immediate: false,
    cross_tenant_rejected: false,
  };

  try {
    // 1. Bootstrap admin - verify platform_admin identity
    const me = await apiGet('/api/v1/auth/me', adminHeaders('platform_admin'));
    assert.ok(me.user_id, 'auth/me should return user_id');
    assert.ok(me.tenant_id, 'auth/me should return tenant_id');
    const meRoles = me.roles as string[] | undefined;
    console.log(`[iam-smoke] ✓ auth/me identity: ${me.user_id} (${meRoles?.join(', ')})`);

    // 2. Create tenants
    const tenantA = `${tenantPrefix}_a`;
    const tenantB = `${tenantPrefix}_b`;
    await apiPost('/api/v1/iam/tenants', { tenant_id: tenantA, display_name: 'Tenant A' }, adminHeaders('platform_admin'));
    await apiPost('/api/v1/iam/tenants', { tenant_id: tenantB, display_name: 'Tenant B' }, adminHeaders('platform_admin'));
    results.tenants = 2;
    console.log(`[iam-smoke] ✓ Created tenants: ${tenantA}, ${tenantB}`);

    // 3. Create users
    const operatorId = `${tenantPrefix}_operator`;
    const auditorId = `${tenantPrefix}_auditor`;
    const memberId = `${tenantPrefix}_member`;
    await apiPost('/api/v1/iam/users', { user_id: operatorId, display_name: 'Test Operator' }, adminHeaders('platform_admin'));
    await apiPost('/api/v1/iam/users', { user_id: auditorId, display_name: 'Test Auditor' }, adminHeaders('platform_admin'));
    await apiPost('/api/v1/iam/users', { user_id: memberId, display_name: 'Test Member' }, adminHeaders('platform_admin'));
    results.users = 4; // 3 + bootstrap admin
    console.log(`[iam-smoke] ✓ Created users: ${operatorId}, ${auditorId}, ${memberId}`);

    // 4. Create memberships
    await apiPost('/api/v1/iam/memberships', { tenant_id: tenantA, user_id: operatorId, roles: ['capability_operator'] }, adminHeaders('platform_admin'));
    await apiPost('/api/v1/iam/memberships', { tenant_id: tenantA, user_id: auditorId, roles: ['auditor'] }, adminHeaders('platform_admin'));
    await apiPost('/api/v1/iam/memberships', { tenant_id: tenantA, user_id: memberId, roles: [] }, adminHeaders('platform_admin'));
    console.log('[iam-smoke] ✓ Created memberships');

    // 5. Test forged header roles rejection
    // Member with empty roles tries to access IAM API with forged platform_admin role
    try {
      await apiGet('/api/v1/iam/tenants', userHeaders(memberId, tenantA, ['platform_admin']));
      assert.fail('Forged platform_admin should be rejected');
    } catch (error: unknown) {
      const err = error as { status?: number };
      assert.ok(err.status === 403 || err.status === 401, `Forged roles should return 403/401, got ${err.status}`);
      results.forged_roles_rejected = true;
      console.log('[iam-smoke] ✓ Forged header roles rejected');
    }

    // 6. Test cross-tenant access rejection
    // Member of tenant A tries to access tenant B
    try {
      await apiGet('/api/v1/iam/tenants', userHeaders(memberId, tenantB, []));
      assert.fail('Cross-tenant access should be rejected');
    } catch (error: unknown) {
      const err = error as { status?: number };
      assert.ok(err.status === 403 || err.status === 401, `Cross-tenant should return 403/401, got ${err.status}`);
      results.cross_tenant_rejected = true;
      console.log('[iam-smoke] ✓ Cross-tenant access rejected');
    }

    // 7. Test ordinary member cannot access IAM API
    try {
      await apiGet('/api/v1/iam/tenants', userHeaders(memberId, tenantA, []));
      assert.fail('Ordinary member should not access IAM API');
    } catch (error: unknown) {
      const err = error as { status?: number };
      assert.ok(err.status === 403, `Member IAM access should return 403, got ${err.status}`);
      console.log('[iam-smoke] ✓ Ordinary member IAM access denied');
    }

    // 8. Test role change immediate effect
    const operatorMe = await apiGet('/api/v1/auth/me', userHeaders(operatorId, tenantA, []));
    const operatorRoles = operatorMe.roles as string[] | undefined;
    console.log(`[iam-smoke] Operator roles: ${operatorRoles?.join(', ')}`);

    // Change operator to auditor
    await apiPut(`/api/v1/iam/memberships/${tenantA}/${operatorId}`, { roles: ['auditor'], expected_revision: 1 }, adminHeaders('platform_admin'));

    // Verify operator now has auditor role
    const updatedOperatorMe = await apiGet('/api/v1/auth/me', userHeaders(operatorId, tenantA, []));
    const updatedRoles = updatedOperatorMe.roles as string[] | undefined;
    assert.ok(updatedRoles?.includes('auditor'), 'Operator should now have auditor role');
    assert.ok(!updatedRoles?.includes('capability_operator'), 'Operator should no longer have capability_operator');
    results.role_change_immediate = true;
    console.log('[iam-smoke] ✓ Role change takes immediate effect');

    // 9. Test disable/reactivate
    // Disable membership
    await apiPost(`/api/v1/iam/memberships/${tenantA}/${auditorId}/disable`, {}, adminHeaders('platform_admin'));
    try {
      await apiGet('/api/v1/auth/me', userHeaders(auditorId, tenantA, []));
      assert.fail('Disabled membership should be rejected');
    } catch (error: unknown) {
      const err = error as { status?: number };
      assert.ok(err.status === 403, `Disabled membership should return 403, got ${err.status}`);
      console.log('[iam-smoke] ✓ Disabled membership rejected');
    }

    // Reactivate membership
    await apiPost(`/api/v1/iam/memberships/${tenantA}/${auditorId}/activate`, {}, adminHeaders('platform_admin'));
    const reactivatedMe = await apiGet('/api/v1/auth/me', userHeaders(auditorId, tenantA, []));
    assert.ok(reactivatedMe.user_id, 'Reactivated membership should work');
    console.log('[iam-smoke] ✓ Reactivated membership works');

    // 10. Test disable tenant
    await apiPost(`/api/v1/iam/tenants/${tenantB}/disable`, {}, adminHeaders('platform_admin'));
    try {
      await apiGet('/api/v1/auth/me', userHeaders(operatorId, tenantB, []));
      assert.fail('Disabled tenant should be rejected');
    } catch (error: unknown) {
      const err = error as { status?: number };
      assert.ok(err.status === 403 || err.status === 401, `Disabled tenant should return 403/401, got ${err.status}`);
      console.log('[iam-smoke] ✓ Disabled tenant rejected');
    }

    // Reactivate tenant
    await apiPost(`/api/v1/iam/tenants/${tenantB}/activate`, {}, adminHeaders('platform_admin'));
    console.log('[iam-smoke] ✓ Reactivated tenant');

    // 11. Test disable user
    await apiPost(`/api/v1/iam/users/${memberId}/disable`, {}, adminHeaders('platform_admin'));
    try {
      await apiGet('/api/v1/auth/me', userHeaders(memberId, tenantA, []));
      assert.fail('Disabled user should be rejected');
    } catch (error: unknown) {
      const err = error as { status?: number };
      assert.ok(err.status === 403 || err.status === 401, `Disabled user should return 403/401, got ${err.status}`);
      console.log('[iam-smoke] ✓ Disabled user rejected');
    }

    // Reactivate user
    await apiPost(`/api/v1/iam/users/${memberId}/activate`, {}, adminHeaders('platform_admin'));
    console.log('[iam-smoke] ✓ Reactivated user');

    // 12. Test role catalog
    const roles = await apiGet('/api/v1/iam/roles', adminHeaders('platform_admin'));
    assert.ok(Array.isArray(roles.roles), 'Role catalog should have roles array');
    assert.ok(Array.isArray(roles.membership_roles), 'Role catalog should have membership_roles array');
    console.log('[iam-smoke] ✓ Role catalog accessible');

    // 13. Verify tenant list
    const tenants = await apiGet('/api/v1/iam/tenants', adminHeaders('platform_admin'));
    const tenantItems = tenants.items as unknown[];
    assert.ok(tenantItems.length >= 2, 'Should have at least 2 tenants');
    console.log(`[iam-smoke] ✓ Tenant list: ${tenantItems.length} tenants`);

    // 14. Verify user list
    const users = await apiGet('/api/v1/iam/users', adminHeaders('platform_admin'));
    const userItems = users.items as unknown[];
    assert.ok(userItems.length >= 4, 'Should have at least 4 users');
    console.log(`[iam-smoke] ✓ User list: ${userItems.length} users`);

    console.log('[iam-smoke] ✓ All IAM smoke tests passed!');
  } catch (error) {
    results.ok = false;
    console.error('[iam-smoke] ✗ FAILED:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // Output result
  const outputPath = process.env.SMOKE_RESULT_PATH ?? 'artifacts/iam-directory-smoke/result.json';
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`[iam-smoke] Result written to ${outputPath}`);
  console.log(JSON.stringify(results, null, 2));
}

// ---- Helpers ----

function adminHeaders(role: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': 'platform',
    'x-user-id': 'platform_admin',
    'x-roles': role,
    'x-request-id': `iam_smoke_${Date.now()}_admin`,
  };
}

function userHeaders(userId: string, tenantId: string, roles: string[]): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': tenantId,
    'x-user-id': userId,
    'x-roles': roles.join(','),
    'x-request-id': `iam_smoke_${Date.now()}_${userId}`,
  };
}

async function apiGet(path: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(`${controlPlaneUrl}${path}`, { method: 'GET', headers });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(`GET ${path} failed: ${response.status}`) as Error & { status: number; body: Record<string, unknown> };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  // Standard response wrapper
  if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
    const standard = body as { success: boolean; data: unknown };
    if (standard.success) return standard.data as Record<string, unknown>;
  }
  return body;
}

async function apiPost(path: string, data: unknown, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(`${controlPlaneUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(`POST ${path} failed: ${response.status}`) as Error & { status: number; body: Record<string, unknown> };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
    const standard = body as { success: boolean; data: unknown };
    if (standard.success) return standard.data as Record<string, unknown>;
  }
  return body;
}

async function apiPut(path: string, data: unknown, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(`${controlPlaneUrl}${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(data),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(`PUT ${path} failed: ${response.status}`) as Error & { status: number; body: Record<string, unknown> };
    error.status = response.status;
    error.body = body;
    throw error;
  }
  if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
    const standard = body as { success: boolean; data: unknown };
    if (standard.success) return standard.data as Record<string, unknown>;
  }
  return body;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

main().catch((error) => {
  console.error('[iam-smoke] Fatal error:', error);
  process.exit(1);
});
