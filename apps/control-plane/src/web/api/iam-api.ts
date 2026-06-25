import type {
  IamTenant,
  IamUserAccount,
  IamTenantMembership,
  IamRoleCatalogResponse,
  IamResolvedIdentity,
} from '@dar/contracts';
import type { ApiClient } from './client.js';

export async function fetchAuthMe(client: ApiClient): Promise<IamResolvedIdentity> {
  return client.request<IamResolvedIdentity>('/api/v1/auth/me');
}

export async function fetchRoleCatalog(client: ApiClient): Promise<IamRoleCatalogResponse> {
  return client.request<IamRoleCatalogResponse>('/api/v1/iam/roles');
}

export async function listTenants(client: ApiClient, params: Record<string, string> = {}): Promise<{ items: IamTenant[]; total: number }> {
  return client.request('/api/v1/iam/tenants', { query: params });
}

export async function getTenant(client: ApiClient, tenantId: string): Promise<IamTenant> {
  return client.request<IamTenant>(`/api/v1/iam/tenants/${encodeURIComponent(tenantId)}`);
}

export async function createTenant(client: ApiClient, data: { tenant_id: string; display_name: string; description?: string }): Promise<IamTenant> {
  return client.request<IamTenant>('/api/v1/iam/tenants', { method: 'POST', body: data });
}

export async function updateTenant(client: ApiClient, tenantId: string, data: { display_name?: string; description?: string; expected_revision: number }): Promise<IamTenant> {
  return client.request<IamTenant>(`/api/v1/iam/tenants/${encodeURIComponent(tenantId)}`, { method: 'PUT', body: data });
}

export async function activateTenant(client: ApiClient, tenantId: string): Promise<IamTenant> {
  return client.request<IamTenant>(`/api/v1/iam/tenants/${encodeURIComponent(tenantId)}/activate`, { method: 'POST' });
}

export async function disableTenant(client: ApiClient, tenantId: string): Promise<IamTenant> {
  return client.request<IamTenant>(`/api/v1/iam/tenants/${encodeURIComponent(tenantId)}/disable`, { method: 'POST' });
}

export async function listUsers(client: ApiClient, params: Record<string, string> = {}): Promise<{ items: IamUserAccount[]; total: number }> {
  return client.request('/api/v1/iam/users', { query: params });
}

export async function getUser(client: ApiClient, userId: string): Promise<IamUserAccount> {
  return client.request<IamUserAccount>(`/api/v1/iam/users/${encodeURIComponent(userId)}`);
}

export async function createUser(client: ApiClient, data: { user_id: string; display_name: string; email?: string; platform_roles?: string[] }): Promise<IamUserAccount> {
  return client.request<IamUserAccount>('/api/v1/iam/users', { method: 'POST', body: data });
}

export async function updateUser(client: ApiClient, userId: string, data: Record<string, unknown>): Promise<IamUserAccount> {
  return client.request<IamUserAccount>(`/api/v1/iam/users/${encodeURIComponent(userId)}`, { method: 'PUT', body: data });
}

export async function activateUser(client: ApiClient, userId: string): Promise<IamUserAccount> {
  return client.request<IamUserAccount>(`/api/v1/iam/users/${encodeURIComponent(userId)}/activate`, { method: 'POST' });
}

export async function disableUser(client: ApiClient, userId: string): Promise<IamUserAccount> {
  return client.request<IamUserAccount>(`/api/v1/iam/users/${encodeURIComponent(userId)}/disable`, { method: 'POST' });
}

export async function listMemberships(client: ApiClient, params: Record<string, string> = {}): Promise<{ items: IamTenantMembership[]; total: number }> {
  return client.request('/api/v1/iam/memberships', { query: params });
}

export async function getMembership(client: ApiClient, tenantId: string, userId: string): Promise<IamTenantMembership> {
  return client.request<IamTenantMembership>(`/api/v1/iam/memberships/${encodeURIComponent(tenantId)}/${encodeURIComponent(userId)}`);
}

export async function createMembership(client: ApiClient, data: { tenant_id: string; user_id: string; roles?: string[] }): Promise<IamTenantMembership> {
  return client.request<IamTenantMembership>('/api/v1/iam/memberships', { method: 'POST', body: data });
}

export async function updateMembershipRoles(client: ApiClient, tenantId: string, userId: string, data: { roles: string[]; expected_revision: number }): Promise<IamTenantMembership> {
  return client.request<IamTenantMembership>(`/api/v1/iam/memberships/${encodeURIComponent(tenantId)}/${encodeURIComponent(userId)}`, { method: 'PUT', body: data });
}

export async function activateMembership(client: ApiClient, tenantId: string, userId: string): Promise<IamTenantMembership> {
  return client.request<IamTenantMembership>(`/api/v1/iam/memberships/${encodeURIComponent(tenantId)}/${encodeURIComponent(userId)}/activate`, { method: 'POST' });
}

export async function disableMembership(client: ApiClient, tenantId: string, userId: string): Promise<IamTenantMembership> {
  return client.request<IamTenantMembership>(`/api/v1/iam/memberships/${encodeURIComponent(tenantId)}/${encodeURIComponent(userId)}/disable`, { method: 'POST' });
}
