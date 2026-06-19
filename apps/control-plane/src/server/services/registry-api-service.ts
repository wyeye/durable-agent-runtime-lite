import type {
  AgentSpec,
  CapabilityRelease,
  FlowSpec,
  GrayResourceRequest,
  PaginatedResponse,
  PromptDefinition,
  RegistryListRequest,
  RegistryResourceType,
  RegistryValidationResult,
  RollbackResourceRequest,
  RouteSpec,
  SpecStatus,
  TenantRuntimePolicy,
  ToolManifest,
} from '@dar/contracts';
import {
  agentSpecSchema,
  flowSpecSchema,
  promptDefinitionSchema,
  registryListRequestSchema,
  routeSpecSchema,
  tenantRuntimePolicySchema,
  toolManifestSchema,
  type PublishResourceRequest,
} from '@dar/contracts';
import {
  AgentSpecRepository,
  CapabilityReleaseRepository,
  FlowDefinitionRepository,
  hashTenantRuntimePolicy,
  PromptDefinitionRepository,
  RouteConfigRepository,
  TenantRuntimePolicyRepository,
  TenantRuntimePolicyReleaseService,
  TenantRuntimePolicyValidationService,
  ToolManifestRepository,
  type Database,
} from '@dar/db';
import type { RegistryResourceRecord } from '@dar/db';
import type { Kysely } from 'kysely';
import {
  RegistryReleaseService,
  type RegistryReleaseServiceOptions,
} from '../../modules/registry/registry-release-service.js';
import { RegistryValidationService } from '../../modules/registry/registry-validation-service.js';
import { ControlPlaneHttpError } from '../utils/http.js';

type RegistrySpec = FlowSpec | RouteSpec | ToolManifest | AgentSpec | PromptDefinition | TenantRuntimePolicy;
type RegistryRecord = RegistryResourceRecord<RegistrySpec>;

export interface ActorOptions {
  tenantId: string;
  operatorId: string;
  requestId?: string;
}

export interface RegistryApi {
  list(resourceType: RegistryResourceType, input: unknown, actor: Pick<ActorOptions, 'tenantId'>): Promise<PaginatedResponse<RegistryRecord>>;
  listVersions(resourceType: RegistryResourceType, resourceId: string, actor: Pick<ActorOptions, 'tenantId'>): Promise<RegistryRecord[]>;
  getVersion(resourceType: RegistryResourceType, resourceId: string, version: number, actor: Pick<ActorOptions, 'tenantId'>): Promise<RegistryRecord>;
  createDraft(resourceType: RegistryResourceType, spec: unknown, actor: ActorOptions): Promise<RegistryRecord>;
  updateDraft(resourceType: RegistryResourceType, resourceId: string, version: number, input: { spec: unknown; expected_revision: number }, actor: ActorOptions): Promise<RegistryRecord>;
  cloneVersion(resourceType: RegistryResourceType, resourceId: string, version: number, input: { version?: number }, actor: ActorOptions): Promise<RegistryRecord>;
  validate(resourceType: RegistryResourceType, resourceId: string, version: number, actor: Pick<ActorOptions, 'tenantId'>): Promise<RegistryValidationResult>;
  publish(resourceType: RegistryResourceType, resourceId: string, version: number, input: PublishResourceRequest, actor: ActorOptions): Promise<CapabilityRelease>;
  gray(resourceType: RegistryResourceType, resourceId: string, version: number, input: GrayResourceRequest, actor: ActorOptions): Promise<CapabilityRelease>;
  deprecate(resourceType: RegistryResourceType, resourceId: string, version: number, input: PublishResourceRequest, actor: ActorOptions): Promise<CapabilityRelease>;
  disable(resourceType: RegistryResourceType, resourceId: string, version: number, input: PublishResourceRequest, actor: ActorOptions): Promise<CapabilityRelease>;
  rollback(resourceType: RegistryResourceType, resourceId: string, input: RollbackResourceRequest, actor: ActorOptions): Promise<CapabilityRelease>;
  publishFlowWithRoute(input: { flow_id: string; flow_version: number; route_id: string; route_version: number; release_note: string; metadata_json?: Record<string, unknown> }, actor: ActorOptions): Promise<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }>;
  releaseHistory(resourceType: RegistryResourceType, resourceId: string, actor: Pick<ActorOptions, 'tenantId'>): Promise<CapabilityRelease[]>;
  listReleases(input: { tenantId: string; resourceType?: RegistryResourceType; resourceId?: string; action?: CapabilityRelease['action']; operatorId?: string; startTime?: string; endTime?: string; page: number; pageSize: number }): Promise<PaginatedResponse<CapabilityRelease>>;
  getRelease(releaseId: string): Promise<CapabilityRelease>;
  registryCounts(tenantId: string): Promise<{ flows_published: number; routes_published: number; tools_published: number; agents_published: number; prompts_published: number }>;
}

export class RegistryApiService implements RegistryApi {
  readonly flows: FlowDefinitionRepository;
  readonly routes: RouteConfigRepository;
  readonly tools: ToolManifestRepository;
  readonly agents: AgentSpecRepository;
  readonly prompts: PromptDefinitionRepository;
  readonly tenantPolicies: TenantRuntimePolicyRepository;
  readonly tenantPolicyValidation: TenantRuntimePolicyValidationService;
  readonly tenantPolicyRelease: TenantRuntimePolicyReleaseService;
  readonly releases: CapabilityReleaseRepository;
  readonly validation: RegistryValidationService;
  readonly release: RegistryReleaseService;

  constructor(private readonly db: Kysely<Database>) {
    this.flows = new FlowDefinitionRepository(db);
    this.routes = new RouteConfigRepository(db);
    this.tools = new ToolManifestRepository(db);
    this.agents = new AgentSpecRepository(db);
    this.prompts = new PromptDefinitionRepository(db);
    this.tenantPolicies = new TenantRuntimePolicyRepository(db);
    this.tenantPolicyValidation = new TenantRuntimePolicyValidationService(db);
    this.tenantPolicyRelease = new TenantRuntimePolicyReleaseService(db);
    this.releases = new CapabilityReleaseRepository(db);
    const repositories = {
      flows: this.flows,
      routes: this.routes,
      tools: this.tools,
      agents: this.agents,
      prompts: this.prompts,
    };
    this.validation = new RegistryValidationService(repositories);
    this.release = new RegistryReleaseService(db, repositories, this.validation);
  }

  async list(
    resourceType: RegistryResourceType,
    input: unknown,
    actor: Pick<ActorOptions, 'tenantId'>,
  ): Promise<PaginatedResponse<RegistryRecord>> {
    const request = registryListRequestSchema.parse(input);
    if (resourceType === 'tenant_runtime_policy') {
      const rows = await this.tenantPolicies.list({ tenantId: actor.tenantId, limit: 100 });
      const filtered = rows
        .filter((row) => !request.status || row.status === request.status)
        .map(toTenantPolicyRegistryRecord)
        .filter((row) => matchesRegistryList(row, request));
      return paginate(filtered, request.page, request.page_size);
    }
    const rows = await this.repository(resourceType).list({
      tenantId: actor.tenantId,
      ...(request.status ? { status: request.status } : {}),
    });
    const filtered = rows.filter((row) => matchesRegistryList(row, request));
    return paginate(filtered as RegistryRecord[], request.page, request.page_size);
  }

  async listVersions(
    resourceType: RegistryResourceType,
    resourceId: string,
    actor: Pick<ActorOptions, 'tenantId'>,
  ): Promise<RegistryRecord[]> {
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      return (await this.tenantPolicies.listVersions(actor.tenantId)).map(toTenantPolicyRegistryRecord);
    }
    return this.repository(resourceType).listVersions(resourceId, { tenantId: actor.tenantId }) as Promise<RegistryRecord[]>;
  }

  async getVersion(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    actor: Pick<ActorOptions, 'tenantId'>,
  ): Promise<RegistryRecord> {
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      const policy = await this.tenantPolicies.getByTenantAndVersion(actor.tenantId, version);
      if (!policy) {
        throw new ControlPlaneHttpError(404, 'REGISTRY_VERSION_NOT_FOUND', 'Registry resource version not found', {
          resource_type: resourceType,
          resource_id: resourceId,
          version,
        });
      }
      return toTenantPolicyRegistryRecord(policy);
    }
    const record = await this.repository(resourceType).getByIdAndVersion(resourceId, version, { tenantId: actor.tenantId });
    if (!record) {
      throw new ControlPlaneHttpError(404, 'REGISTRY_VERSION_NOT_FOUND', 'Registry resource version not found', {
        resource_type: resourceType,
        resource_id: resourceId,
        version,
      });
    }
    return record as RegistryRecord;
  }

  async createDraft(resourceType: RegistryResourceType, spec: unknown, actor: ActorOptions): Promise<RegistryRecord> {
    const parsed = parseSpec(resourceType, spec);
    if (resourceType === 'tenant_runtime_policy') {
      const policy = tenantRuntimePolicySchema.parse(parsed);
      assertTenantPolicyResource(policy.tenant_id, actor.tenantId);
      return toTenantPolicyRegistryRecord(await this.tenantPolicies.createDraft(policy, {
        tenantId: actor.tenantId,
        operatorId: actor.operatorId,
      }));
    }
    return this.repository(resourceType).createDraft(parsed as never, {
      tenantId: actor.tenantId,
      operatorId: actor.operatorId,
    }) as Promise<RegistryRecord>;
  }

  async updateDraft(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    input: { spec: unknown; expected_revision: number },
    actor: ActorOptions,
  ): Promise<RegistryRecord> {
    const parsed = parseSpec(resourceType, input.spec);
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      return toTenantPolicyRegistryRecord(await this.tenantPolicies.updateDraft(actor.tenantId, version, {
        expectedRevision: input.expected_revision,
        policy: tenantRuntimePolicySchema.parse(parsed),
        tenantId: actor.tenantId,
        operatorId: actor.operatorId,
      }));
    }
    return this.repository(resourceType).updateDraft(resourceId, version, {
      spec: parsed as never,
      expectedRevision: input.expected_revision,
      tenantId: actor.tenantId,
      operatorId: actor.operatorId,
    }) as Promise<RegistryRecord>;
  }

  async cloneVersion(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    input: { version?: number },
    actor: ActorOptions,
  ): Promise<RegistryRecord> {
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      const cloned = await this.tenantPolicies.cloneVersion(actor.tenantId, version, {
        tenantId: actor.tenantId,
        operatorId: actor.operatorId,
        ...(input.version ? { version: input.version } : {}),
      });
      return toTenantPolicyRegistryRecord(cloned);
    }
    return this.repository(resourceType).cloneVersion(resourceId, version, {
      tenantId: actor.tenantId,
      operatorId: actor.operatorId,
      ...(input.version ? { version: input.version } : {}),
    }) as Promise<RegistryRecord>;
  }

  async validate(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    actor: Pick<ActorOptions, 'tenantId'>,
  ): Promise<RegistryValidationResult> {
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      const policy = await this.tenantPolicies.getByTenantAndVersion(actor.tenantId, version);
      if (!policy) {
        return {
          valid: false,
          can_publish: false,
          errors: [{ code: 'REGISTRY_VERSION_NOT_FOUND', message: 'Registry version not found', severity: 'error' }],
          warnings: [],
          dependency_graph: { nodes: [], edges: [] },
        };
      }
      return this.tenantPolicyValidation.validate(policy);
    }
    return this.release.validate(resourceType, resourceId, version, actor.tenantId);
  }

  async publish(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    input: PublishResourceRequest,
    actor: ActorOptions,
  ): Promise<CapabilityRelease> {
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      await this.tenantPolicyRelease.publish(actor.tenantId, version, {
        operatorId: actor.operatorId,
        releaseNote: input.release_note,
        metadataJson: {
          ...input.metadata_json,
          ...(actor.requestId ? { request_id: actor.requestId } : {}),
        },
      });
      return this.latestTenantPolicyRelease(actor.tenantId);
    }
    return this.release.publish(resourceType, resourceId, version, releaseOptions(actor, input));
  }

  async gray(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    input: GrayResourceRequest,
    actor: ActorOptions,
  ): Promise<CapabilityRelease> {
    if (resourceType === 'tenant_runtime_policy') {
      throw new ControlPlaneHttpError(400, 'TENANT_RUNTIME_POLICY_GRAY_UNSUPPORTED', 'Tenant runtime policy does not support gray release');
    }
    return this.release.setGray(resourceType, resourceId, version, {
      ...releaseOptions(actor, input),
      tenantAllowlist: input.tenant_allowlist,
      userAllowlist: input.user_allowlist,
    });
  }

  async deprecate(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    input: PublishResourceRequest,
    actor: ActorOptions,
  ): Promise<CapabilityRelease> {
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      await this.tenantPolicyRelease.deprecate(actor.tenantId, version, {
        operatorId: actor.operatorId,
        releaseNote: input.release_note,
      });
      return this.latestTenantPolicyRelease(actor.tenantId);
    }
    return this.release.deprecate(resourceType, resourceId, version, releaseOptions(actor, input));
  }

  async disable(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    input: PublishResourceRequest,
    actor: ActorOptions,
  ): Promise<CapabilityRelease> {
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      await this.tenantPolicyRelease.disable(actor.tenantId, version, {
        operatorId: actor.operatorId,
        releaseNote: input.release_note,
      });
      return this.latestTenantPolicyRelease(actor.tenantId);
    }
    return this.release.disable(resourceType, resourceId, version, releaseOptions(actor, input));
  }

  async rollback(
    resourceType: RegistryResourceType,
    resourceId: string,
    input: RollbackResourceRequest,
    actor: ActorOptions,
  ): Promise<CapabilityRelease> {
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      await this.tenantPolicyRelease.rollback(actor.tenantId, {
        targetVersion: input.target_version,
        operatorId: actor.operatorId,
        releaseNote: input.release_note,
        metadataJson: {
          ...input.metadata_json,
          ...(actor.requestId ? { request_id: actor.requestId } : {}),
        },
      });
      return this.latestTenantPolicyRelease(actor.tenantId);
    }
    return this.release.rollback(resourceType, resourceId, input.target_version, releaseOptions(actor, input));
  }

  async publishFlowWithRoute(input: {
    flow_id: string;
    flow_version: number;
    route_id: string;
    route_version: number;
    release_note: string;
    metadata_json?: Record<string, unknown>;
  }, actor: ActorOptions): Promise<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }> {
    return this.release.publishFlowWithRoute(
      input.flow_id,
      input.flow_version,
      input.route_id,
      input.route_version,
      releaseOptions(actor, {
        release_note: input.release_note,
        metadata_json: input.metadata_json ?? {},
      }),
    );
  }

  async releaseHistory(
    resourceType: RegistryResourceType,
    resourceId: string,
    actor: Pick<ActorOptions, 'tenantId'>,
  ): Promise<CapabilityRelease[]> {
    if (resourceType === 'tenant_runtime_policy') {
      assertTenantPolicyResource(resourceId, actor.tenantId);
      return this.tenantPolicies.listReleaseHistory(actor.tenantId);
    }
    return this.repository(resourceType).listReleaseHistory(resourceId, { tenantId: actor.tenantId });
  }

  async listReleases(input: {
    tenantId: string;
    resourceType?: RegistryResourceType;
    resourceId?: string;
    action?: CapabilityRelease['action'];
    operatorId?: string;
    startTime?: string;
    endTime?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResponse<CapabilityRelease>> {
    const releases = await this.releases.list({
      tenantId: input.tenantId,
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.operatorId ? { operatorId: input.operatorId } : {}),
      ...(input.startTime ? { startTime: input.startTime } : {}),
      ...(input.endTime ? { endTime: input.endTime } : {}),
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    return {
      items: releases,
      page: input.page,
      page_size: input.pageSize,
    };
  }

  async getRelease(releaseId: string): Promise<CapabilityRelease> {
    const release = await this.releases.get(releaseId);
    if (!release) {
      throw new ControlPlaneHttpError(404, 'CAPABILITY_RELEASE_NOT_FOUND', 'Capability release not found');
    }
    return release;
  }

  async registryCounts(tenantId: string): Promise<{
    flows_published: number;
    routes_published: number;
    tools_published: number;
    agents_published: number;
    prompts_published: number;
  }> {
    const [flows, routes, tools, agents, prompts] = await Promise.all([
      this.flows.list({ tenantId, status: 'published' }),
      this.routes.list({ tenantId, status: 'published' }),
      this.tools.list({ tenantId, status: 'published' }),
      this.agents.list({ tenantId, status: 'published' }),
      this.prompts.list({ tenantId, status: 'published' }),
    ]);
    return {
      flows_published: flows.length,
      routes_published: routes.length,
      tools_published: tools.length,
      agents_published: agents.length,
      prompts_published: prompts.length,
    };
  }

  private repository(resourceType: RegistryResourceType) {
    if (resourceType === 'flow') {
      return this.flows;
    }
    if (resourceType === 'route') {
      return this.routes;
    }
    if (resourceType === 'tool') {
      return this.tools;
    }
    if (resourceType === 'agent') {
      return this.agents;
    }
    return this.prompts;
  }

  private async latestTenantPolicyRelease(tenantId: string): Promise<CapabilityRelease> {
    const [release] = await this.tenantPolicies.listReleaseHistory(tenantId);
    if (!release) {
      throw new ControlPlaneHttpError(500, 'TENANT_POLICY_RELEASE_NOT_FOUND', 'Tenant policy release record was not created');
    }
    return release;
  }
}

function parseSpec(resourceType: RegistryResourceType, spec: unknown): RegistrySpec {
  if (resourceType === 'flow') {
    return flowSpecSchema.parse(spec);
  }
  if (resourceType === 'route') {
    return routeSpecSchema.parse(spec);
  }
  if (resourceType === 'tool') {
    return toolManifestSchema.parse(spec);
  }
  if (resourceType === 'agent') {
    return agentSpecSchema.parse(spec);
  }
  if (resourceType === 'tenant_runtime_policy') {
    return tenantRuntimePolicySchema.parse(spec);
  }
  return promptDefinitionSchema.parse(spec);
}

function assertTenantPolicyResource(resourceId: string, tenantId: string): void {
  if (resourceId !== tenantId) {
    throw new ControlPlaneHttpError(403, 'TENANT_POLICY_TENANT_MISMATCH', 'Tenant runtime policy resource must match authenticated tenant', {
      resource_id: resourceId,
    });
  }
}

function toTenantPolicyRegistryRecord(policy: TenantRuntimePolicy): RegistryRecord {
  return {
    tenant_id: policy.tenant_id,
    resource_type: 'tenant_runtime_policy',
    resource_id: policy.tenant_id,
    version: policy.version,
    status: policy.status as SpecStatus,
    spec: policy,
    sha256: hashTenantRuntimePolicy(policy),
    ...(policy.created_by ? { created_by: policy.created_by } : {}),
    ...(policy.updated_by ? { updated_by: policy.updated_by } : {}),
    ...(policy.published_by ? { published_by: policy.published_by } : {}),
    created_at: policy.created_at ?? new Date(0).toISOString(),
    updated_at: policy.updated_at ?? new Date(0).toISOString(),
    ...(policy.published_at ? { published_at: policy.published_at } : {}),
    revision: policy.revision,
    gray_policy: { tenant_allowlist: [], user_allowlist: [] },
  };
}

function releaseOptions(actor: ActorOptions, input: PublishResourceRequest): RegistryReleaseServiceOptions {
  return {
    tenantId: actor.tenantId,
    operatorId: actor.operatorId,
    releaseNote: input.release_note,
    metadata: {
      ...input.metadata_json,
      ...(actor.requestId ? { request_id: actor.requestId } : {}),
    },
  };
}

function matchesRegistryList(row: RegistryRecord, request: RegistryListRequest): boolean {
  if (request.resource_id && row.resource_id !== request.resource_id) {
    return false;
  }
  if (request.created_by && row.created_by !== request.created_by) {
    return false;
  }
  if (request.updated_by && row.updated_by !== request.updated_by) {
    return false;
  }
  if (request.keyword) {
    const keyword = request.keyword.toLowerCase();
    const haystack = `${row.resource_id} ${JSON.stringify(row.spec)}`.toLowerCase();
    if (!haystack.includes(keyword)) {
      return false;
    }
  }
  return true;
}

function paginate<T>(items: T[], page: number, pageSize: number): PaginatedResponse<T> {
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    page_size: pageSize,
    total: items.length,
  };
}

export function parseVersionParam(value: string): number {
  const major = value.includes('.') ? value.split('.')[0] : value;
  const version = Number(major);
  if (!Number.isInteger(version) || version <= 0) {
    throw new ControlPlaneHttpError(400, 'INVALID_VERSION', 'Version must be a positive integer or semantic major version');
  }
  return version;
}

export function resourceStatus(record: RegistryRecord): SpecStatus {
  return record.status;
}
