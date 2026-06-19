import type {
  AgentSpec,
  CapabilityRelease,
  FlowSpec,
  GrayPolicy,
  ModelPolicy,
  PaginatedResponse,
  PromptDefinition,
  RegistryResourceType,
  RegistryValidationResult,
  RouteSpec,
  SpecStatus,
  TenantRuntimePolicy,
  ToolManifest,
} from '@dar/contracts';
import type { ApiClient } from './client.js';

export type RegistrySpec = FlowSpec | RouteSpec | ToolManifest | AgentSpec | PromptDefinition | TenantRuntimePolicy | ModelPolicy;

export interface RegistryRecord<TSpec extends RegistrySpec = RegistrySpec> {
  tenant_id: string;
  resource_type: RegistryResourceType;
  resource_id: string;
  version: number;
  status: SpecStatus;
  spec: TSpec;
  sha256: string;
  created_by?: string;
  updated_by?: string;
  published_by?: string;
  created_at: string;
  updated_at: string;
  published_at?: string;
  revision: number;
  gray_policy: GrayPolicy;
}

export interface RegistryListParams {
  status?: SpecStatus;
  resource_id?: string;
  keyword?: string;
  created_by?: string;
  updated_by?: string;
  page?: number;
  page_size?: number;
}

export interface ReleaseListParams {
  resource_type?: RegistryResourceType;
  resource_id?: string;
  action?: CapabilityRelease['action'];
  operator_id?: string;
  start_time?: string;
  end_time?: string;
  page?: number;
  page_size?: number;
}

export interface ReleaseActionInput {
  release_note: string;
  metadata_json?: Record<string, unknown>;
}

export interface GrayActionInput extends ReleaseActionInput {
  tenant_allowlist: string[];
  user_allowlist?: string[];
}

export interface RollbackActionInput extends ReleaseActionInput {
  target_version: number;
}

const resourcePaths: Record<RegistryResourceType, string> = {
  flow: 'flows',
  route: 'routes',
  tool: 'tools',
  agent: 'agents',
  prompt: 'prompts',
  tenant_runtime_policy: 'tenant-runtime-policies',
  model_policy: 'model-policies',
};

export function listResources(
  client: ApiClient,
  resourceType: RegistryResourceType,
  params: RegistryListParams,
): Promise<PaginatedResponse<RegistryRecord>> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}`, { query: params });
}

export function createDraft(
  client: ApiClient,
  resourceType: RegistryResourceType,
  spec: RegistrySpec | unknown,
): Promise<RegistryRecord> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}`, {
    method: 'POST',
    body: { spec },
  });
}

export function listVersions(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
): Promise<RegistryRecord[]> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}/${encodeURIComponent(resourceId)}/versions`);
}

export function getVersion(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  version: number,
): Promise<RegistryRecord> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}/${encodeURIComponent(resourceId)}/versions/${version}`);
}

export function updateDraft(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  version: number,
  spec: RegistrySpec | unknown,
  expectedRevision: number,
): Promise<RegistryRecord> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}/${encodeURIComponent(resourceId)}/versions/${version}`, {
    method: 'PUT',
    body: {
      spec,
      expected_revision: expectedRevision,
    },
  });
}

export function cloneVersion(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  version: number,
  targetVersion?: number,
): Promise<RegistryRecord> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}/${encodeURIComponent(resourceId)}/versions/${version}/clone`, {
    method: 'POST',
    body: targetVersion ? { version: targetVersion } : {},
  });
}

export function validateResource(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  version: number,
): Promise<{ validation: RegistryValidationResult }> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}/${encodeURIComponent(resourceId)}/versions/${version}/validate`, {
    method: 'POST',
    body: { include_warnings: true },
  });
}

export function publishResource(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  version: number,
  input: ReleaseActionInput,
): Promise<CapabilityRelease> {
  return releaseAction(client, resourceType, resourceId, version, 'publish', input);
}

export function grayResource(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  version: number,
  input: GrayActionInput,
): Promise<CapabilityRelease> {
  return releaseAction(client, resourceType, resourceId, version, 'gray', input);
}

export function deprecateResource(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  version: number,
  input: ReleaseActionInput,
): Promise<CapabilityRelease> {
  return releaseAction(client, resourceType, resourceId, version, 'deprecate', input);
}

export function disableResource(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  version: number,
  input: ReleaseActionInput,
): Promise<CapabilityRelease> {
  return releaseAction(client, resourceType, resourceId, version, 'disable', input);
}

export function rollbackResource(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  input: RollbackActionInput,
): Promise<CapabilityRelease> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}/${encodeURIComponent(resourceId)}/rollback`, {
    method: 'POST',
    body: input,
  });
}

export function listReleaseHistory(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
): Promise<CapabilityRelease[]> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}/${encodeURIComponent(resourceId)}/releases`);
}

export function listReleases(client: ApiClient, params: ReleaseListParams): Promise<PaginatedResponse<CapabilityRelease>> {
  return client.request('/api/v1/releases', { query: params });
}

export function getRelease(client: ApiClient, releaseId: string): Promise<CapabilityRelease> {
  return client.request(`/api/v1/releases/${encodeURIComponent(releaseId)}`);
}

export function publishFlowWithRoute(client: ApiClient, input: {
  flow_id: string;
  flow_version: number;
  route_id: string;
  route_version: number;
  release_note: string;
  metadata_json?: Record<string, unknown>;
}): Promise<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }> {
  return client.request('/api/v1/releases/flow-route', {
    method: 'POST',
    body: input,
  });
}

function releaseAction(
  client: ApiClient,
  resourceType: RegistryResourceType,
  resourceId: string,
  version: number,
  action: 'publish' | 'gray' | 'deprecate' | 'disable',
  input: ReleaseActionInput | GrayActionInput,
): Promise<CapabilityRelease> {
  return client.request(`/api/v1/${resourcePaths[resourceType]}/${encodeURIComponent(resourceId)}/versions/${version}/${action}`, {
    method: 'POST',
    body: input,
  });
}
