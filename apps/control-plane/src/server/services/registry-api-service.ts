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
  ToolManifest,
} from '@dar/contracts';
import {
  agentSpecSchema,
  flowSpecSchema,
  promptDefinitionSchema,
  registryListRequestSchema,
  routeSpecSchema,
  toolManifestSchema,
  type PublishResourceRequest,
} from '@dar/contracts';
import {
  AgentSpecRepository,
  CapabilityReleaseRepository,
  FlowDefinitionRepository,
  PromptDefinitionRepository,
  RouteConfigRepository,
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

type RegistrySpec = FlowSpec | RouteSpec | ToolManifest | AgentSpec | PromptDefinition;
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
  readonly releases: CapabilityReleaseRepository;
  readonly validation: RegistryValidationService;
  readonly release: RegistryReleaseService;

  constructor(private readonly db: Kysely<Database>) {
    this.flows = new FlowDefinitionRepository(db);
    this.routes = new RouteConfigRepository(db);
    this.tools = new ToolManifestRepository(db);
    this.agents = new AgentSpecRepository(db);
    this.prompts = new PromptDefinitionRepository(db);
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
    return this.repository(resourceType).listVersions(resourceId, { tenantId: actor.tenantId }) as Promise<RegistryRecord[]>;
  }

  async getVersion(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    actor: Pick<ActorOptions, 'tenantId'>,
  ): Promise<RegistryRecord> {
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
    return this.release.validate(resourceType, resourceId, version, actor.tenantId);
  }

  async publish(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    input: PublishResourceRequest,
    actor: ActorOptions,
  ): Promise<CapabilityRelease> {
    return this.release.publish(resourceType, resourceId, version, releaseOptions(actor, input));
  }

  async gray(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    input: GrayResourceRequest,
    actor: ActorOptions,
  ): Promise<CapabilityRelease> {
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
    return this.release.deprecate(resourceType, resourceId, version, releaseOptions(actor, input));
  }

  async disable(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    input: PublishResourceRequest,
    actor: ActorOptions,
  ): Promise<CapabilityRelease> {
    return this.release.disable(resourceType, resourceId, version, releaseOptions(actor, input));
  }

  async rollback(
    resourceType: RegistryResourceType,
    resourceId: string,
    input: RollbackResourceRequest,
    actor: ActorOptions,
  ): Promise<CapabilityRelease> {
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
  return promptDefinitionSchema.parse(spec);
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
