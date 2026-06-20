import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentExecutionMode,
  AgentExecutionPlan,
  AgentStepStatus,
  AgentRunRecord,
  AgentStepRecord,
  AgentToolResultReference,
  AgentUsage,
  AuditEvent,
  FlowExecutionPlan,
  FlowSpec,
  HumanTask,
  HumanTaskCreateRequest,
  IdempotencyRecord,
  ModelCallAttempt,
  ModelCallAttemptStatus,
  ModelCallRecord,
  ModelCallStatus,
  ModelPolicy,
  ModelPolicyStatus,
  ModelUsage,
  PiContextSnapshotRef,
  PromptDefinition,
  ResolvedModelPolicy,
  ResolvedAgentPlan,
  RouteSpec,
  TaskRun,
  TenantAgentAdmission,
  TenantAdmissionStatus,
  TenantPolicySnapshotDerivationType,
  TenantRuntimePolicy,
  TenantRuntimePolicySnapshot,
  ToolCallLog,
  ToolManifest,
} from '@dar/contracts';
import {
  type CapabilityRelease,
  agentBudgetSchema,
  agentExecutionPlanSchema,
  agentRunRecordSchema,
  agentRunStatusSchema,
  agentSpecSchema,
  agentStepRecordSchema,
  agentUsageSchema,
  auditEventSchema,
  flowExecutionPlanSchema,
  flowSpecSchema,
  grayPolicySchema,
  humanTaskCreateRequestSchema,
  humanTaskRespondRequestSchema,
  humanTaskSchema,
  idempotencyRecordSchema,
  modelCallAttemptSchema,
  modelCallRecordSchema,
  modelFallbackPolicySchema,
  modelPolicySchema,
  modelRequestPolicySchema,
  modelRetryPolicySchema,
  resolvedModelPolicySchema,
  piContextSnapshotRefSchema,
  promptDefinitionSchema,
  resolvedAgentPlanSchema,
  routeSpecSchema,
  type SpecStatus,
  taskRunSchema,
  tenantAgentAdmissionSchema,
  tenantRuntimeBudgetCapSchema,
  tenantRuntimePolicySchema,
  tenantRuntimePolicySnapshotSchema,
  tenantRuntimePolicyStatusSchema,
  taskRunStatusSchema,
  toolCallLogSchema,
  toolManifestSchema,
  type AgentSpec,
  type FlowExecutionPlanAgent,
  type FlowExecutionPlanTool,
  type ModelTarget,
  type RouteResult,
  type WorkflowStartResponse,
} from '@dar/contracts';
import { sql, type Insertable, type Kysely, type Selectable, type Updateable } from 'kysely';
import type {
  AgentSpecTable,
  AgentContextSnapshotTable,
  AgentExecutionPlanTable,
  AgentRunTable,
  AgentStepTable,
  AuditEventTable,
  Database,
  FlowExecutionPlanTable,
  FlowDefinitionTable,
  FlowRouteConfigTable,
  HumanTaskTable,
  IdempotencyRecordTable,
  ModelCallAttemptTable,
  ModelCallLogTable,
  ModelPolicyTable,
  PromptDefinitionTable,
  TaskRunTable,
  TenantAgentAdmissionTable,
  TenantRuntimePolicySnapshotTable,
  TenantRuntimePolicyTable,
  ToolCallLogTable,
  ToolManifestTable,
} from './index.js';
import { withTransaction } from './index.js';
import {
  CapabilityReleaseRepository,
  RegistryRepositoryError,
  type RegistryCloneOptions,
  type RegistryListOptions,
  type RegistryResourceRecord,
  type RegistryRollbackOptions,
  type RegistryStatusOptions,
  type RegistryUpdateDraftInput,
  type RegistryWriteOptions,
  VersionedRegistryRepository,
} from './registry.js';

export const executableSpecStatuses = ['published', 'gray'] as const;
export type ExecutableSpecStatus = (typeof executableSpecStatuses)[number];

export interface RepositoryTenantOptions {
  tenantId?: string;
}

export interface UpsertSpecOptions extends RepositoryTenantOptions {
  status?: ExecutableSpecStatus | 'draft' | 'validated' | 'deprecated' | 'disabled';
  createdBy?: string;
}

export interface CreateTaskRunInput {
  taskRun: TaskRun;
  input: unknown;
  routeResult?: RouteResult;
  workflowStart?: WorkflowStartResponse;
  executionPlanRef?: string;
  tenantPolicySnapshotRef?: string;
  tenantPolicyHash?: string;
  tenantAdmissionId?: string;
}

export interface UpdateTaskRunStatusInput {
  status: TaskRun['status'];
  errorCode?: string;
  errorMessage?: string;
}

export interface ListTaskRunsOptions extends RepositoryTenantOptions {
  status?: TaskRun['status'];
  flowId?: string;
  workflowId?: string;
  limit?: number;
  offset?: number;
}

export interface IdempotencyReplayInput {
  idempotencyKey: string;
  tenantId: string;
  targetType: string;
  targetId: string;
  requestHash: string;
}

export type IdempotencyReplayDecision =
  | { decision: 'miss' }
  | { decision: 'replay'; record: IdempotencyRecord }
  | { decision: 'conflict'; record: IdempotencyRecord };

export interface HumanTaskDecisionInput {
  tenantId?: string;
  decidedBy: string;
  decisionReason?: string;
  payload?: Record<string, unknown>;
}

export interface HumanTaskRespondInput {
  tenantId?: string;
  userId: string;
  response: Record<string, unknown>;
  responseIdempotencyKey: string;
}

export interface ToolCallLogCreateInput {
  tool_call_id?: string;
  task_run_id?: string;
  workflow_id?: string;
  tenant_id: string;
  user_id?: string;
  tool_name: string;
  tool_version: string;
  risk_level: ToolCallLog['risk_level'];
  policy_decision: ToolCallLog['policy_decision'];
  status: ToolCallLog['status'];
  mode?: ToolCallLog['mode'];
  duration_ms?: number;
  idempotency_key?: string;
  input_hash?: string;
  output_hash?: string;
  error_code?: string;
  adapter_type?: string;
  preview_json?: unknown;
  result_json?: unknown;
  tenant_policy_snapshot_ref?: string;
  policy_decision_code?: string;
}

export interface ToolCallLogUpdateInput {
  status?: ToolCallLog['status'];
  policy_decision?: ToolCallLog['policy_decision'];
  mode?: ToolCallLog['mode'];
  duration_ms?: number;
  output_hash?: string;
  error_code?: string;
  preview_json?: unknown;
  result_json?: unknown;
  tenant_policy_snapshot_ref?: string;
  policy_decision_code?: string;
}

export interface ListHumanTasksOptions extends RepositoryTenantOptions {
  taskRunId?: string;
  status?: HumanTask['status'];
  limit?: number;
  offset?: number;
}

export interface ListAuditEventsOptions extends RepositoryTenantOptions {
  targetType?: string;
  targetId?: string;
  taskRunId?: string;
  toolName?: string;
  action?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}

export interface ListToolCallLogsOptions extends RepositoryTenantOptions {
  taskRunId?: string;
  toolName?: string;
  status?: ToolCallLog['status'];
  limit?: number;
  offset?: number;
}

export interface ModelPolicyListOptions extends RepositoryTenantOptions {
  status?: ModelPolicyStatus;
  limit?: number;
  offset?: number;
}

export interface ModelPolicyWriteOptions extends RepositoryTenantOptions {
  operatorId: string;
  version?: number;
}

export interface ModelPolicyUpdateDraftInput extends ModelPolicyWriteOptions {
  expectedRevision: number;
  policy: Partial<
    Omit<
      ModelPolicy,
      'model_policy_id' | 'version' | 'revision' | 'created_at' | 'updated_at' | 'published_at'
    >
  >;
}

export interface ModelPolicyReleaseOptions extends ModelPolicyWriteOptions {
  expectedRevision?: number;
  releaseNote?: string;
  metadataJson?: Record<string, unknown>;
}

export interface ModelPolicyRollbackOptions extends ModelPolicyReleaseOptions {
  targetVersion: number;
}

export interface ModelCallCreateOrGetInput {
  model_call_id?: string;
  model_request_key: string;
  tenant_id: string;
  user_id?: string;
  task_run_id?: string;
  workflow_id?: string;
  workflow_run_id?: string;
  agent_run_id?: string;
  segment_index?: number;
  model_turn_index?: number;
  model_policy_id: string;
  model_policy_version: number;
  model_policy_hash: string;
  protocol: ModelCallRecord['protocol'];
  request_hash: string;
  fallback_index?: number;
}

export type ModelCallCreateOrGetResult =
  | { decision: 'created'; record: ModelCallRecord }
  | { decision: 'existing'; record: ModelCallRecord }
  | { decision: 'replay'; record: ModelCallRecord }
  | { decision: 'conflict'; record: ModelCallRecord };

export interface ModelCallListOptions extends RepositoryTenantOptions {
  taskRunId?: string;
  agentRunId?: string;
  modelPolicyId?: string;
  modelId?: string;
  provider?: string;
  status?: ModelCallStatus;
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}

export interface ModelCallAttemptStartInput {
  attempt_id?: string;
  model_call_id: string;
  global_attempt_index: number;
  target_attempt_index: number;
  fallback_index: number;
  target_id: string;
  provider?: string;
  model_id: string;
}

export interface ModelCallAttemptCompleteInput {
  status: ModelCallAttemptStatus;
  http_status?: number;
  error_class?: string;
  error_code?: string;
  latency_ms?: number;
  response_id?: string;
}

export interface BuildAgentExecutionPlanInput extends RepositoryTenantOptions {
  agentId: string;
  agentVersion: number;
  operatorId?: string;
  generatedAt?: string;
}

export interface CreateAgentRunInput {
  agentRunId?: string;
  tenantId: string;
  userId: string;
  taskRunId: string;
  workflowId: string;
  workflowRunId?: string;
  parentWorkflowId?: string;
  executionMode?: AgentExecutionMode;
  executionPlan: AgentExecutionPlan;
  tenantPolicySnapshotRef?: string;
  tenantPolicyVersion?: number;
  tenantPolicyHash?: string;
  tenantAdmissionId?: string;
}

export interface UpdateAgentRunInput {
  status?: AgentRunRecord['status'];
  workflowRunId?: string;
  currentSegmentIndex?: number;
  modelTurnCount?: number;
  toolCallCount?: number;
  handoffCount?: number;
  fallbackCount?: number;
  modelCallCount?: number;
  selectedModelId?: string;
  selectedProvider?: string;
  usage?: Partial<AgentUsage>;
  completed?: boolean;
  errorCode?: string;
  errorMessage?: string;
  tenantPolicySnapshotRef?: string;
  tenantPolicyVersion?: number;
  tenantPolicyHash?: string;
  tenantAdmissionId?: string;
}

export interface TenantPolicyListOptions extends RepositoryTenantOptions {
  status?: TenantRuntimePolicy['status'];
  limit?: number;
  offset?: number;
}

export interface TenantPolicyWriteOptions extends RepositoryTenantOptions {
  operatorId: string;
  version?: number;
}

export interface TenantPolicyUpdateDraftInput extends TenantPolicyWriteOptions {
  expectedRevision: number;
  policy: Partial<
    Omit<
      TenantRuntimePolicy,
      'tenant_id' | 'version' | 'revision' | 'created_at' | 'updated_at' | 'published_at'
    >
  >;
}

export interface TenantPolicyReleaseOptions extends TenantPolicyWriteOptions {
  releaseNote?: string;
  metadataJson?: Record<string, unknown>;
}

export interface TenantPolicyRollbackOptions extends TenantPolicyReleaseOptions {
  targetVersion: number;
}

export interface CreateTenantPolicySnapshotInput {
  tenantId: string;
  policy: TenantRuntimePolicy;
  policyHash: string;
  executionPlanRef: string;
  executionPlanHash: string;
  executionPlanType: 'flow' | 'agent';
  rootSnapshotRef?: string;
  parentSnapshotRef?: string;
  derivationType?: TenantPolicySnapshotDerivationType;
  lineageDepth?: number;
  resolvedPolicy: Omit<
    TenantRuntimePolicySnapshot,
    | 'snapshot_id'
    | 'snapshot_ref'
    | 'tenant_id'
    | 'root_snapshot_ref'
    | 'parent_snapshot_ref'
    | 'derivation_type'
    | 'lineage_depth'
    | 'source_policy_version'
    | 'source_policy_hash'
    | 'execution_plan_ref'
    | 'execution_plan_hash'
    | 'execution_plan_type'
    | 'snapshot_hash'
    | 'created_at'
  >;
}

export interface TenantAdmissionReserveInput {
  tenantId: string;
  taskRunId: string;
  policySnapshotRef: string;
  maxConcurrentAgentRuns: number;
}

export interface TenantAdmissionListOptions extends RepositoryTenantOptions {
  status?: TenantAdmissionStatus;
  taskRunId?: string;
  agentRunId?: string;
  workflowId?: string;
  limit?: number;
  offset?: number;
  staleBefore?: string;
  acquiredFrom?: string;
  acquiredTo?: string;
}

export interface TenantPolicySnapshotListOptions extends RepositoryTenantOptions {
  executionPlanRef?: string;
  sourcePolicyVersion?: number;
  status?: TenantRuntimePolicy['status'];
  derivationType?: TenantPolicySnapshotDerivationType;
  rootSnapshotRef?: string;
  parentSnapshotRef?: string;
  createdFrom?: string;
  createdTo?: string;
  limit?: number;
  offset?: number;
}

export interface ListAgentRunsOptions extends RepositoryTenantOptions {
  taskRunId?: string;
  agentId?: string;
  status?: AgentRunRecord['status'];
  limit?: number;
  offset?: number;
}

export interface CreateAgentStepInput extends Omit<
  AgentStepRecord,
  'agent_step_id' | 'created_at' | 'updated_at'
> {
  agent_step_id?: string;
}

export interface UpdateAgentStepBoundaryInput {
  stableStepKey: string;
  segmentStatus?: AgentStepStatus;
  decisionSummary?: string;
  proposedToolCalls?: AgentStepRecord['proposed_tool_calls'];
  toolResultRefs?: AgentToolResultReference[];
  authoritativeToolResultRefs?: AgentToolResultReference[];
  humanTaskIds?: string[];
  contextSnapshotBefore?: AgentStepRecord['context_snapshot_before'];
  contextSnapshotAfter?: AgentStepRecord['context_snapshot_after'];
  contextSnapshotRef?: AgentStepRecord['context_snapshot_ref'];
  handoffRefs?: Array<Record<string, unknown>>;
  outputRef?: string;
  usage?: Partial<AgentUsage>;
  errorCode?: string;
  errorMessage?: string;
}

export interface CreateAgentContextSnapshotInput {
  snapshotId?: string;
  agentRunId: string;
  previousSnapshotId?: string;
  schemaVersion: 'pi-context/v1';
  sanitizedMessages: unknown[];
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function buildDbFlowSnapshotRef(flowId: string, version: number): string {
  return `db://flow/${encodeURIComponent(flowId)}/versions/${version}`;
}

export function parseDbFlowSnapshotRef(
  ref: string,
): { flowId: string; version: number } | undefined {
  const match = /^db:\/\/flow\/([^/]+)\/versions\/([1-9]\d*)$/u.exec(ref);
  if (!match) {
    return undefined;
  }

  return {
    flowId: decodeURIComponent(match[1] ?? ''),
    version: Number(match[2]),
  };
}

export function buildToolVersionRef(toolName: string, toolVersion: string): string {
  return `${toolName}@${toolVersion}`;
}

export function buildExecutionPlanRef(executionPlanId: string): string {
  return `db://flow-execution-plan/${encodeURIComponent(executionPlanId)}`;
}

export function parseExecutionPlanRef(ref: string): { executionPlanId: string } | undefined {
  const match = /^db:\/\/flow-execution-plan\/([^/]+)$/u.exec(ref);
  if (!match) {
    return undefined;
  }

  return { executionPlanId: decodeURIComponent(match[1] ?? '') };
}

export function buildAgentExecutionPlanRef(executionPlanId: string): string {
  return `db://agent-execution-plan/${encodeURIComponent(executionPlanId)}`;
}

export function parseAgentExecutionPlanRef(ref: string): { executionPlanId: string } | undefined {
  const match = /^db:\/\/agent-execution-plan\/([^/]+)$/u.exec(ref);
  if (!match) {
    return undefined;
  }

  return { executionPlanId: decodeURIComponent(match[1] ?? '') };
}

export class FlowDefinitionRepository {
  private readonly registry: VersionedRegistryRepository<FlowSpec>;

  constructor(private readonly db: Kysely<Database>) {
    this.registry = new VersionedRegistryRepository(db, {
      resourceType: 'flow',
      tableName: 'flow_definition',
      idColumn: 'flow_id',
      versionColumn: 'version',
      jsonColumn: 'spec_json',
      schema: flowSpecSchema,
      getSpecId: (spec) => spec.flow_id,
      getSpecVersion: (spec) => spec.version,
      withIdentity: (spec, resourceId, version, status) => ({
        ...spec,
        flow_id: resourceId,
        version,
        status,
      }),
    });
  }

  list(options: RegistryListOptions = {}): Promise<RegistryResourceRecord<FlowSpec>[]> {
    return this.registry.list(options);
  }

  getByIdAndVersion(
    flowId: string,
    version: number,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<FlowSpec> | undefined> {
    return this.registry.getByIdAndVersion(flowId, version, options);
  }

  getLatestVersion(
    flowId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<FlowSpec> | undefined> {
    return this.registry.getLatestVersion(flowId, options);
  }

  getLatestPublishedVersion(
    flowId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<FlowSpec> | undefined> {
    return this.registry.getLatestPublishedVersion(flowId, options);
  }

  listVersions(
    flowId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<FlowSpec>[]> {
    return this.registry.listVersions(flowId, options);
  }

  createDraft(
    flowSpec: FlowSpec,
    options: RegistryWriteOptions,
  ): Promise<RegistryResourceRecord<FlowSpec>> {
    return this.registry.createDraft(flowSpec, options);
  }

  updateDraft(
    flowId: string,
    version: number,
    input: RegistryUpdateDraftInput<FlowSpec>,
  ): Promise<RegistryResourceRecord<FlowSpec>> {
    return this.registry.updateDraft(flowId, version, input);
  }

  cloneVersion(
    flowId: string,
    version: number,
    options: RegistryCloneOptions,
  ): Promise<RegistryResourceRecord<FlowSpec>> {
    return this.registry.cloneVersion(flowId, version, options);
  }

  markValidated(
    flowId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<FlowSpec>> {
    return this.registry.markValidated(flowId, version, options);
  }

  publish(
    flowId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<FlowSpec>> {
    return this.registry.publish(flowId, version, options);
  }

  setGray(
    flowId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<FlowSpec>> {
    return this.registry.setGray(flowId, version, options);
  }

  deprecate(
    flowId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<FlowSpec>> {
    return this.registry.deprecate(flowId, version, options);
  }

  disable(
    flowId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<FlowSpec>> {
    return this.registry.disable(flowId, version, options);
  }

  rollback(
    flowId: string,
    targetVersion: number,
    options: RegistryRollbackOptions,
  ): Promise<RegistryResourceRecord<FlowSpec>> {
    return this.registry.rollback(flowId, targetVersion, options);
  }

  listReleaseHistory(
    flowId: string,
    options: RegistryListOptions = {},
  ): Promise<CapabilityRelease[]> {
    return this.registry.listReleaseHistory(flowId, options);
  }

  selectVersionForRequest(
    flowId: string,
    input: { tenantId?: string; userId?: string },
  ): Promise<RegistryResourceRecord<FlowSpec> | undefined> {
    return this.registry.selectVersionForRequest(flowId, input);
  }

  async listPublished(options: RepositoryTenantOptions = {}): Promise<FlowSpec[]> {
    const rows = await this.db
      .selectFrom('flow_definition')
      .select(['spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('status', 'in', executableSpecStatuses)
      .orderBy('flow_id', 'asc')
      .orderBy('version', 'desc')
      .execute();

    return rows.map((row) => flowSpecSchema.parse(row.spec_json));
  }

  async getPublished(
    flowId: string,
    version: number,
    options: RepositoryTenantOptions = {},
  ): Promise<FlowSpec | undefined> {
    const row = await this.db
      .selectFrom('flow_definition')
      .select(['spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('flow_id', '=', flowId)
      .where('version', '=', version)
      .where('status', 'in', executableSpecStatuses)
      .executeTakeFirst();

    return row ? flowSpecSchema.parse(row.spec_json) : undefined;
  }

  async upsert(flowSpec: FlowSpec, options: UpsertSpecOptions = {}): Promise<FlowSpec> {
    const status = normalizeWriteStatus(options.status ?? flowSpec.status ?? 'published');
    const parsed = flowSpecSchema.parse({ ...flowSpec, status });
    const row: Insertable<FlowDefinitionTable> = {
      tenant_id: tenant(options),
      flow_id: parsed.flow_id,
      version: parsed.version,
      status,
      spec_json: parsed,
      sha256: parsed.sha256 ?? hashJson(parsed),
      created_by: options.createdBy ?? null,
      updated_by: options.createdBy ?? null,
      published_by: executableSpecStatuses.includes(status as ExecutableSpecStatus)
        ? (options.createdBy ?? null)
        : null,
      updated_at: new Date(),
      published_at: executableSpecStatuses.includes(status as ExecutableSpecStatus)
        ? new Date()
        : null,
      revision: 1,
      gray_policy_json: grayPolicySchema.parse({}),
    };

    const saved = await this.db
      .insertInto('flow_definition')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'flow_id', 'version']).doUpdateSet({
          status: row.status,
          spec_json: row.spec_json,
          sha256: row.sha256,
          created_by: row.created_by,
          updated_by: row.updated_by,
          published_by: row.published_by,
          updated_at: row.updated_at,
          published_at: row.published_at,
          gray_policy_json: row.gray_policy_json,
        }),
      )
      .returning(['spec_json'])
      .executeTakeFirstOrThrow();

    return flowSpecSchema.parse(saved.spec_json);
  }
}

export interface BuildFlowExecutionPlanInput extends RepositoryTenantOptions {
  flowId: string;
  flowVersion: number;
  operatorId?: string;
  tenantAllowedTools?: readonly string[];
  generatedAt?: string;
}

interface VersionRef {
  id: string;
  version: number;
}

interface ToolVersionRef {
  name: string;
  version: string;
}

interface ToolPlanEntryInput {
  stepId?: string;
  toolName: string;
  toolVersion: string;
  tenantId: string;
}

export async function buildFlowExecutionPlan(
  db: Kysely<Database>,
  input: BuildFlowExecutionPlanInput,
): Promise<FlowExecutionPlan> {
  const tenantId = tenant(input);
  const flow = await new FlowDefinitionRepository(db).getByIdAndVersion(
    input.flowId,
    input.flowVersion,
    { tenantId },
  );
  if (!flow) {
    throw new Error(`FlowSpec exact version not found: ${input.flowId}@${input.flowVersion}`);
  }
  if (!isDependencyPublishable(flow.status)) {
    throw new Error(
      `FlowSpec is not executable for plan generation: ${input.flowId}@${input.flowVersion}`,
    );
  }

  const agents: FlowExecutionPlanAgent[] = [];
  const toolEntries = new Map<string, FlowExecutionPlanTool>();
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  for (const step of flow.spec.steps) {
    if (step.type === 'tool') {
      if (!step.tool) {
        throw new Error(`Flow tool step missing tool name: ${step.id}`);
      }
      if (!step.tool_version) {
        throw new Error(`Flow tool step missing exact tool_version: ${step.id}`);
      }
      addToolEntry(
        toolEntries,
        await resolveToolPlanEntry(db, {
          stepId: step.id,
          toolName: step.tool,
          toolVersion: step.tool_version,
          tenantId,
        }),
      );
    }

    if (step.type === 'agent') {
      if (!step.agent_id) {
        throw new Error(`Flow agent step missing agent_id: ${step.id}`);
      }
      const agentVersion = numberFromUnknown(step.input?.agent_version);
      if (!agentVersion) {
        throw new Error(`Flow agent step missing exact input.agent_version: ${step.id}`);
      }
      const agentRecord = await new AgentSpecRepository(db).getByIdAndVersion(
        step.agent_id,
        agentVersion,
        { tenantId },
      );
      if (!agentRecord) {
        throw new Error(`AgentSpec exact version not found: ${step.agent_id}@${agentVersion}`);
      }
      if (!isDependencyPublishable(agentRecord.status)) {
        throw new Error(
          `AgentSpec is not executable for plan generation: ${step.agent_id}@${agentVersion}`,
        );
      }

      const promptRef = parseVersionRef(agentRecord.spec.prompt_ref);
      if (!promptRef) {
        throw new Error(
          `Agent prompt_ref must use prompt_id@version: ${agentRecord.spec.agent_id}@${agentRecord.spec.version}`,
        );
      }
      const promptRecord = await new PromptDefinitionRepository(db).getByIdAndVersion(
        promptRef.id,
        promptRef.version,
        { tenantId },
      );
      if (!promptRecord) {
        throw new Error(`PromptDefinition exact version not found: ${agentRecord.spec.prompt_ref}`);
      }
      if (!isDependencyPublishable(promptRecord.status)) {
        throw new Error(
          `PromptDefinition is not executable for plan generation: ${agentRecord.spec.prompt_ref}`,
        );
      }

      const allowedToolRefs = resolveAllowedToolRefs(
        agentRecord.spec.allowed_tools,
        flowAllowedToolOverrides(flow.spec, step.id, agentRecord.spec.agent_id),
        input.tenantAllowedTools,
      );
      const allowedTools: string[] = [];
      for (const allowedTool of allowedToolRefs) {
        const tool = await resolveToolPlanEntry(db, {
          toolName: allowedTool.name,
          toolVersion: allowedTool.version,
          tenantId,
        });
        addToolEntry(toolEntries, tool);
        allowedTools.push(tool.tool_name);
      }

      const agentExecutionPlan = await new AgentExecutionPlanRepository(db).createForAgent({
        agentId: agentRecord.spec.agent_id,
        agentVersion: agentRecord.spec.version,
        tenantId,
        ...(input.operatorId ? { operatorId: input.operatorId } : {}),
        generatedAt,
      });

      agents.push({
        step_id: step.id,
        agent_id: agentRecord.spec.agent_id,
        agent_version: agentRecord.spec.version,
        agent_sha256: agentRecord.sha256,
        prompt_id: promptRecord.spec.prompt_id,
        prompt_version: promptRecord.spec.version,
        prompt_sha256: promptRecord.sha256,
        model_policy: agentRecord.spec.model_policy,
        model_policy_id: agentExecutionPlan.model_policy_id,
        model_policy_version: agentExecutionPlan.model_policy_version,
        model_policy_hash: agentExecutionPlan.model_policy_hash,
        resolved_model_policy: agentExecutionPlan.resolved_model_policy,
        allowed_tools: allowedTools,
        agent_execution_plan_ref: agentExecutionPlan.execution_plan_ref,
        allowed_handoffs: agentRecord.spec.allowed_handoffs,
        budget: {
          max_steps: agentRecord.spec.max_steps,
          max_tokens: agentRecord.spec.max_tokens,
        },
      });
    }
  }

  const executionPlanId = `plan_${randomUUID()}`;
  const executionPlanRef = buildExecutionPlanRef(executionPlanId);
  const tools = [...toolEntries.values()].sort(comparePlanTools);
  const planWithoutHash = {
    execution_plan_id: executionPlanId,
    execution_plan_ref: executionPlanRef,
    tenant_id: tenantId,
    flow_id: flow.resource_id,
    flow_version: flow.version,
    flow_sha256: flow.sha256,
    flow_spec: flow.spec,
    agents,
    tools,
    allowed_tools: [...new Set(agents.flatMap((agent) => agent.allowed_tools))].sort(),
    budget: {
      max_steps: agents.reduce((sum, agent) => sum + agent.budget.max_steps, 0),
      max_tokens: agents.reduce((sum, agent) => sum + agent.budget.max_tokens, 0),
    },
    generated_at: generatedAt,
  };

  return flowExecutionPlanSchema.parse({
    ...planWithoutHash,
    execution_plan_hash: hashJson(planWithoutHash),
  });
}

export class FlowExecutionPlanRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createForFlow(input: BuildFlowExecutionPlanInput): Promise<FlowExecutionPlan> {
    const plan = await buildFlowExecutionPlan(this.db, input);
    const row: Insertable<FlowExecutionPlanTable> = {
      execution_plan_id: plan.execution_plan_id,
      execution_plan_ref: plan.execution_plan_ref,
      tenant_id: plan.tenant_id,
      flow_id: plan.flow_id,
      flow_version: plan.flow_version,
      flow_sha256: plan.flow_sha256,
      plan_json: toDbJson(plan),
      execution_plan_hash: plan.execution_plan_hash,
      generated_at: plan.generated_at,
    };

    const saved = await this.db
      .insertInto('flow_execution_plan')
      .values(row)
      .onConflict((oc) => oc.column('execution_plan_ref').doNothing())
      .returningAll()
      .executeTakeFirst();

    if (saved) {
      return mapFlowExecutionPlan(saved);
    }

    const existing = await this.getByRef(plan.execution_plan_ref, { tenantId: plan.tenant_id });
    if (!existing) {
      throw new Error(
        `FlowExecutionPlan insert conflict but existing plan was not found: ${plan.execution_plan_ref}`,
      );
    }
    return existing;
  }

  async getByRef(
    ref: string,
    options: RepositoryTenantOptions = {},
  ): Promise<FlowExecutionPlan | undefined> {
    const parsed = parseExecutionPlanRef(ref);
    if (!parsed) {
      return undefined;
    }

    let query = this.db
      .selectFrom('flow_execution_plan')
      .selectAll()
      .where('execution_plan_id', '=', parsed.executionPlanId);

    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }

    const row = await query.executeTakeFirst();
    return row ? mapFlowExecutionPlan(row) : undefined;
  }

  async getLatestForFlow(
    flowId: string,
    version: number,
    options: RepositoryTenantOptions = {},
  ): Promise<FlowExecutionPlan | undefined> {
    const row = await this.db
      .selectFrom('flow_execution_plan')
      .selectAll()
      .where('tenant_id', '=', tenant(options))
      .where('flow_id', '=', flowId)
      .where('flow_version', '=', version)
      .orderBy('generated_at', 'desc')
      .executeTakeFirst();

    return row ? mapFlowExecutionPlan(row) : undefined;
  }
}

export async function buildAgentExecutionPlan(
  db: Kysely<Database>,
  input: BuildAgentExecutionPlanInput,
): Promise<AgentExecutionPlan> {
  const tenantId = tenant(input);
  const agentRecord = await new AgentSpecRepository(db).getByIdAndVersion(
    input.agentId,
    input.agentVersion,
    { tenantId },
  );
  if (!agentRecord) {
    throw new Error(`AgentSpec exact version not found: ${input.agentId}@${input.agentVersion}`);
  }
  if (!isDependencyPublishable(agentRecord.status)) {
    throw new Error(
      `AgentSpec is not executable for plan generation: ${input.agentId}@${input.agentVersion}`,
    );
  }

  const promptRef = parseVersionRef(agentRecord.spec.prompt_ref);
  if (!promptRef) {
    throw new Error(
      `Agent prompt_ref must use prompt_id@version: ${agentRecord.spec.agent_id}@${agentRecord.spec.version}`,
    );
  }
  const promptRecord = await new PromptDefinitionRepository(db).getByIdAndVersion(
    promptRef.id,
    promptRef.version,
    { tenantId },
  );
  if (!promptRecord) {
    throw new Error(`PromptDefinition exact version not found: ${agentRecord.spec.prompt_ref}`);
  }
  if (!isDependencyPublishable(promptRecord.status)) {
    throw new Error(
      `PromptDefinition is not executable for plan generation: ${agentRecord.spec.prompt_ref}`,
    );
  }

  const allowedTools = [];
  for (const toolRef of parseToolVersionRefs(
    agentRecord.spec.allowed_tools,
    'AgentSpec.allowed_tools',
  )) {
    const toolRecord = await new ToolManifestRepository(db).getByIdAndVersion(
      toolRef.name,
      manifestVersionToRegistryVersion(toolRef.version),
      { tenantId },
    );
    if (!toolRecord) {
      throw new Error(`ToolManifest exact version not found: ${toolRef.name}@${toolRef.version}`);
    }
    if (toolRecord.spec.version !== toolRef.version) {
      throw new Error(
        `ToolManifest version mismatch: requested ${toolRef.name}@${toolRef.version}, got ${toolRecord.spec.version}`,
      );
    }
    if (!isDependencyPublishable(toolRecord.status)) {
      throw new Error(
        `ToolManifest is not executable for plan generation: ${toolRef.name}@${toolRef.version}`,
      );
    }
    allowedTools.push({
      tool_name: toolRecord.spec.tool_name,
      tool_version: toolRecord.spec.version,
      tool_sha256: toolRecord.sha256,
      ...(toolRecord.spec.description ? { description: toolRecord.spec.description } : {}),
      risk_level: toolRecord.spec.risk_level,
      input_schema: toolRecord.spec.input_schema ?? {},
    });
  }

  const budget = agentBudgetSchema.parse({
    max_segments: agentRecord.spec.max_steps,
    max_model_turns: agentRecord.spec.max_steps,
    max_tool_calls: agentRecord.spec.allowed_tools.length,
    max_total_tokens: agentRecord.spec.max_tokens,
  });
  const outputSchema = parseAgentOutputSchema(agentRecord.spec.output_schema);
  const resolvedModelPolicy = await resolveAgentModelPolicy(db, agentRecord.spec, { tenantId });
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const executionPlanId = `agent_plan_${randomUUID()}`;
  const executionPlanRef = buildAgentExecutionPlanRef(executionPlanId);
  const plan: ResolvedAgentPlan = resolvedAgentPlanSchema.parse({
    agent_id: agentRecord.spec.agent_id,
    agent_version: agentRecord.spec.version,
    agent_sha256: agentRecord.sha256,
    prompt_id: promptRecord.spec.prompt_id,
    prompt_version: promptRecord.spec.version,
    prompt_sha256: promptRecord.sha256,
    system_prompt: promptRecord.spec.content,
    model_policy: agentRecord.spec.model_policy,
    model_policy_id: resolvedModelPolicy.model_policy_id,
    model_policy_version: resolvedModelPolicy.model_policy_version,
    model_policy_hash: resolvedModelPolicy.model_policy_hash,
    resolved_model_policy: resolvedModelPolicy,
    allowed_tools: allowedTools,
    allowed_handoffs: agentRecord.spec.allowed_handoffs,
    ...(outputSchema ? { output_schema: outputSchema } : {}),
    budget,
  });
  const planWithoutHash = {
    execution_plan_id: executionPlanId,
    execution_plan_ref: executionPlanRef,
    tenant_id: tenantId,
    agent_id: agentRecord.spec.agent_id,
    agent_version: agentRecord.spec.version,
    agent_sha256: agentRecord.sha256,
    prompt_id: promptRecord.spec.prompt_id,
    prompt_version: promptRecord.spec.version,
    prompt_sha256: promptRecord.sha256,
    model_policy: agentRecord.spec.model_policy,
    model_policy_id: resolvedModelPolicy.model_policy_id,
    model_policy_version: resolvedModelPolicy.model_policy_version,
    model_policy_hash: resolvedModelPolicy.model_policy_hash,
    resolved_model_policy: resolvedModelPolicy,
    allowed_tools: allowedTools,
    allowed_handoffs: agentRecord.spec.allowed_handoffs,
    ...(outputSchema ? { output_schema: outputSchema } : {}),
    budget,
    plan,
    generated_at: generatedAt,
  };

  return agentExecutionPlanSchema.parse({
    ...planWithoutHash,
    execution_plan_hash: hashJson(planWithoutHash),
  });
}

export function agentExecutionPlanContentHash(plan: AgentExecutionPlan): string {
  return hashJson(agentExecutionPlanContent(plan));
}

function agentExecutionPlanContent(plan: AgentExecutionPlan): Record<string, unknown> {
  return {
    tenant_id: plan.tenant_id,
    agent_id: plan.agent_id,
    agent_version: plan.agent_version,
    agent_sha256: plan.agent_sha256,
    prompt_id: plan.prompt_id,
    prompt_version: plan.prompt_version,
    prompt_sha256: plan.prompt_sha256,
    model_policy: plan.model_policy,
    ...(plan.model_policy_id ? { model_policy_id: plan.model_policy_id } : {}),
    ...(plan.model_policy_version ? { model_policy_version: plan.model_policy_version } : {}),
    ...(plan.model_policy_hash ? { model_policy_hash: plan.model_policy_hash } : {}),
    ...(plan.resolved_model_policy ? { resolved_model_policy: plan.resolved_model_policy } : {}),
    allowed_tools: plan.allowed_tools,
    allowed_handoffs: plan.allowed_handoffs,
    ...(plan.output_schema ? { output_schema: plan.output_schema } : {}),
    budget: plan.budget,
    plan: plan.plan,
  };
}

export class AgentExecutionPlanRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createForAgent(input: BuildAgentExecutionPlanInput): Promise<AgentExecutionPlan> {
    const plan = await buildAgentExecutionPlan(this.db, input);
    const existing = await this.getByAgentVersion(plan.agent_id, plan.agent_version, {
      tenantId: plan.tenant_id,
    });
    if (
      existing &&
      agentExecutionPlanContentHash(existing) === agentExecutionPlanContentHash(plan)
    ) {
      return existing;
    }

    const row: Insertable<AgentExecutionPlanTable> = {
      execution_plan_id: plan.execution_plan_id,
      execution_plan_ref: plan.execution_plan_ref,
      tenant_id: plan.tenant_id,
      agent_id: plan.agent_id,
      agent_version: plan.agent_version,
      agent_sha256: plan.agent_sha256,
      prompt_id: plan.prompt_id,
      prompt_version: plan.prompt_version,
      prompt_sha256: plan.prompt_sha256,
      model_policy_json: toDbJson({ value: plan.model_policy }),
      model_policy_id: plan.model_policy_id ?? null,
      model_policy_version: plan.model_policy_version ?? null,
      model_policy_hash: plan.model_policy_hash ?? null,
      resolved_model_policy_json: plan.resolved_model_policy
        ? toDbJson(plan.resolved_model_policy)
        : null,
      allowed_tools_json: toDbJson(plan.allowed_tools),
      allowed_handoffs_json: toDbJson(plan.allowed_handoffs),
      output_schema_json: plan.output_schema ? toDbJson(plan.output_schema) : null,
      budget_json: toDbJson(plan.budget),
      plan_json: toDbJson(plan),
      execution_plan_hash: plan.execution_plan_hash,
      generated_at: plan.generated_at,
    };

    const saved = await this.db
      .insertInto('agent_execution_plan')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapAgentExecutionPlan(saved);
  }

  async getByRef(
    ref: string,
    options: RepositoryTenantOptions = {},
  ): Promise<AgentExecutionPlan | undefined> {
    const parsed = parseAgentExecutionPlanRef(ref);
    if (!parsed) {
      return undefined;
    }
    let query = this.db
      .selectFrom('agent_execution_plan')
      .selectAll()
      .where('execution_plan_id', '=', parsed.executionPlanId);
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    const row = await query.executeTakeFirst();
    return row ? mapAgentExecutionPlan(row) : undefined;
  }

  async getByAgentVersion(
    agentId: string,
    version: number,
    options: RepositoryTenantOptions = {},
  ): Promise<AgentExecutionPlan | undefined> {
    const row = await this.db
      .selectFrom('agent_execution_plan')
      .selectAll()
      .where('tenant_id', '=', tenant(options))
      .where('agent_id', '=', agentId)
      .where('agent_version', '=', version)
      .orderBy('generated_at', 'desc')
      .executeTakeFirst();
    return row ? mapAgentExecutionPlan(row) : undefined;
  }

  async verifyHash(
    ref: string,
    expectedHash: string,
    options: RepositoryTenantOptions = {},
  ): Promise<boolean> {
    const plan = await this.getByRef(ref, options);
    return Boolean(plan && plan.execution_plan_hash === expectedHash);
  }

  async list(options: ListAgentRunsOptions = {}): Promise<AgentExecutionPlan[]> {
    let query = this.db.selectFrom('agent_execution_plan').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.agentId) {
      query = query.where('agent_id', '=', options.agentId);
    }
    const rows = await query
      .orderBy('generated_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapAgentExecutionPlan);
  }
}

export class RouteConfigRepository {
  private readonly registry: VersionedRegistryRepository<RouteSpec>;

  constructor(private readonly db: Kysely<Database>) {
    this.registry = new VersionedRegistryRepository(db, {
      resourceType: 'route',
      tableName: 'flow_route_config',
      idColumn: 'route_id',
      versionColumn: 'flow_version',
      jsonColumn: 'route_spec_json',
      schema: routeSpecSchema,
      getSpecId: (spec) => spec.route_id ?? `${spec.flow_id}@${spec.version}`,
      getSpecVersion: (spec) => spec.version,
      withIdentity: (spec, resourceId, version, status) => ({
        ...spec,
        route_id: resourceId,
        version,
        status,
      }),
      insertExtraColumns: (spec) => ({
        flow_id: spec.flow_id,
        priority: spec.route.priority,
      }),
      updateExtraColumns: (spec) => ({
        flow_id: spec.flow_id,
        priority: spec.route.priority,
      }),
    });
  }

  list(options: RegistryListOptions = {}): Promise<RegistryResourceRecord<RouteSpec>[]> {
    return this.registry.list(options);
  }

  getByIdAndVersion(
    routeId: string,
    version: number,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<RouteSpec> | undefined> {
    return this.registry.getByIdAndVersion(routeId, version, options);
  }

  getLatestVersion(
    routeId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<RouteSpec> | undefined> {
    return this.registry.getLatestVersion(routeId, options);
  }

  getLatestPublishedVersion(
    routeId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<RouteSpec> | undefined> {
    return this.registry.getLatestPublishedVersion(routeId, options);
  }

  listVersions(
    routeId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<RouteSpec>[]> {
    return this.registry.listVersions(routeId, options);
  }

  createDraft(
    routeSpec: RouteSpec,
    options: RegistryWriteOptions,
  ): Promise<RegistryResourceRecord<RouteSpec>> {
    return this.registry.createDraft(routeSpec, options);
  }

  updateDraft(
    routeId: string,
    version: number,
    input: RegistryUpdateDraftInput<RouteSpec>,
  ): Promise<RegistryResourceRecord<RouteSpec>> {
    return this.registry.updateDraft(routeId, version, input);
  }

  cloneVersion(
    routeId: string,
    version: number,
    options: RegistryCloneOptions,
  ): Promise<RegistryResourceRecord<RouteSpec>> {
    return this.registry.cloneVersion(routeId, version, options);
  }

  markValidated(
    routeId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<RouteSpec>> {
    return this.registry.markValidated(routeId, version, options);
  }

  publish(
    routeId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<RouteSpec>> {
    return this.registry.publish(routeId, version, options);
  }

  setGray(
    routeId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<RouteSpec>> {
    return this.registry.setGray(routeId, version, options);
  }

  deprecate(
    routeId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<RouteSpec>> {
    return this.registry.deprecate(routeId, version, options);
  }

  disable(
    routeId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<RouteSpec>> {
    return this.registry.disable(routeId, version, options);
  }

  rollback(
    routeId: string,
    targetVersion: number,
    options: RegistryRollbackOptions,
  ): Promise<RegistryResourceRecord<RouteSpec>> {
    return this.registry.rollback(routeId, targetVersion, options);
  }

  listReleaseHistory(
    routeId: string,
    options: RegistryListOptions = {},
  ): Promise<CapabilityRelease[]> {
    return this.registry.listReleaseHistory(routeId, options);
  }

  selectVersionForRequest(
    routeId: string,
    input: { tenantId?: string; userId?: string },
  ): Promise<RegistryResourceRecord<RouteSpec> | undefined> {
    return this.registry.selectVersionForRequest(routeId, input);
  }

  async listPublished(options: RepositoryTenantOptions = {}): Promise<RouteSpec[]> {
    const rows = await this.db
      .selectFrom('flow_route_config')
      .select(['route_spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('status', 'in', executableSpecStatuses)
      .orderBy('priority', 'desc')
      .orderBy('route_id', 'asc')
      .execute();

    return rows.map((row) => routeSpecSchema.parse(row.route_spec_json));
  }

  async getPublished(
    routeId: string,
    options: RepositoryTenantOptions = {},
  ): Promise<RouteSpec | undefined> {
    const row = await this.db
      .selectFrom('flow_route_config')
      .select(['route_spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('route_id', '=', routeId)
      .where('status', 'in', executableSpecStatuses)
      .orderBy('flow_version', 'desc')
      .executeTakeFirst();

    return row ? routeSpecSchema.parse(row.route_spec_json) : undefined;
  }

  async upsert(routeSpec: RouteSpec, options: UpsertSpecOptions = {}): Promise<RouteSpec> {
    const status = normalizeWriteStatus(options.status ?? routeSpec.status ?? 'published');
    const parsed = routeSpecSchema.parse({ ...routeSpec, status });
    const routeId = parsed.route_id ?? `${parsed.flow_id}@${parsed.version}`;
    const row: Insertable<FlowRouteConfigTable> = {
      tenant_id: tenant(options),
      route_id: routeId,
      flow_id: parsed.flow_id,
      flow_version: parsed.version,
      status,
      route_spec_json: { ...parsed, route_id: routeId },
      priority: parsed.route.priority,
      sha256: parsed.sha256 ?? hashJson(parsed),
      created_by: options.createdBy ?? null,
      updated_by: options.createdBy ?? null,
      published_by: executableSpecStatuses.includes(status as ExecutableSpecStatus)
        ? (options.createdBy ?? null)
        : null,
      published_at: executableSpecStatuses.includes(status as ExecutableSpecStatus)
        ? new Date()
        : null,
      revision: 1,
      gray_policy_json: grayPolicySchema.parse({}),
    };

    const saved = await this.db
      .insertInto('flow_route_config')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'route_id', 'flow_version']).doUpdateSet({
          flow_id: row.flow_id,
          status: row.status,
          route_spec_json: row.route_spec_json,
          priority: row.priority,
          sha256: row.sha256,
          updated_by: row.updated_by,
          published_by: row.published_by,
          updated_at: new Date(),
          published_at: row.published_at,
          gray_policy_json: row.gray_policy_json,
        }),
      )
      .returning(['route_spec_json'])
      .executeTakeFirstOrThrow();

    return routeSpecSchema.parse(saved.route_spec_json);
  }
}

export class ToolManifestRepository {
  private readonly registry: VersionedRegistryRepository<ToolManifest>;

  constructor(private readonly db: Kysely<Database>) {
    this.registry = new VersionedRegistryRepository(db, {
      resourceType: 'tool',
      tableName: 'tool_manifest',
      idColumn: 'spec_id',
      versionColumn: 'version',
      jsonColumn: 'spec_json',
      schema: toolManifestSchema,
      getSpecId: (spec) => spec.tool_name,
      getSpecVersion: (spec) => manifestSpecVersion(spec),
      withIdentity: (spec, resourceId, version, status) => ({
        ...spec,
        tool_name: resourceId,
        version: `${version}.0.0`,
        status,
      }),
    });
  }

  list(options: RegistryListOptions = {}): Promise<RegistryResourceRecord<ToolManifest>[]> {
    return this.registry.list(options);
  }

  getByIdAndVersion(
    toolName: string,
    version: number,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<ToolManifest> | undefined> {
    return this.registry.getByIdAndVersion(toolName, version, options);
  }

  getLatestVersion(
    toolName: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<ToolManifest> | undefined> {
    return this.registry.getLatestVersion(toolName, options);
  }

  getLatestPublishedVersion(
    toolName: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<ToolManifest> | undefined> {
    return this.registry.getLatestPublishedVersion(toolName, options);
  }

  listVersions(
    toolName: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<ToolManifest>[]> {
    return this.registry.listVersions(toolName, options);
  }

  createDraft(
    manifest: ToolManifest,
    options: RegistryWriteOptions,
  ): Promise<RegistryResourceRecord<ToolManifest>> {
    return this.registry.createDraft(manifest, options);
  }

  updateDraft(
    toolName: string,
    version: number,
    input: RegistryUpdateDraftInput<ToolManifest>,
  ): Promise<RegistryResourceRecord<ToolManifest>> {
    return this.registry.updateDraft(toolName, version, input);
  }

  cloneVersion(
    toolName: string,
    version: number,
    options: RegistryCloneOptions,
  ): Promise<RegistryResourceRecord<ToolManifest>> {
    return this.registry.cloneVersion(toolName, version, options);
  }

  markValidated(
    toolName: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<ToolManifest>> {
    return this.registry.markValidated(toolName, version, options);
  }

  publish(
    toolName: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<ToolManifest>> {
    return this.registry.publish(toolName, version, options);
  }

  setGray(
    toolName: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<ToolManifest>> {
    return this.registry.setGray(toolName, version, options);
  }

  deprecate(
    toolName: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<ToolManifest>> {
    return this.registry.deprecate(toolName, version, options);
  }

  disable(
    toolName: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<ToolManifest>> {
    return this.registry.disable(toolName, version, options);
  }

  rollback(
    toolName: string,
    targetVersion: number,
    options: RegistryRollbackOptions,
  ): Promise<RegistryResourceRecord<ToolManifest>> {
    return this.registry.rollback(toolName, targetVersion, options);
  }

  listReleaseHistory(
    toolName: string,
    options: RegistryListOptions = {},
  ): Promise<CapabilityRelease[]> {
    return this.registry.listReleaseHistory(toolName, options);
  }

  selectVersionForRequest(
    toolName: string,
    input: { tenantId?: string; userId?: string },
  ): Promise<RegistryResourceRecord<ToolManifest> | undefined> {
    return this.registry.selectVersionForRequest(toolName, input);
  }

  async listPublished(options: RepositoryTenantOptions = {}): Promise<ToolManifest[]> {
    const rows = await this.db
      .selectFrom('tool_manifest')
      .select(['spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('status', 'in', executableSpecStatuses)
      .orderBy('spec_id', 'asc')
      .orderBy('version', 'desc')
      .execute();

    return rows.map((row) => toolManifestSchema.parse(row.spec_json));
  }

  async getPublished(
    toolName: string,
    options: RepositoryTenantOptions = {},
  ): Promise<ToolManifest | undefined> {
    const row = await this.db
      .selectFrom('tool_manifest')
      .select(['spec_json'])
      .where('tenant_id', '=', tenant(options))
      .where('spec_id', '=', toolName)
      .where('status', 'in', executableSpecStatuses)
      .orderBy('version', 'desc')
      .executeTakeFirst();

    return row ? toolManifestSchema.parse(row.spec_json) : undefined;
  }

  async upsert(manifest: ToolManifest, options: UpsertSpecOptions = {}): Promise<ToolManifest> {
    const status = normalizeWriteStatus(options.status ?? manifest.status ?? 'published');
    const parsed = toolManifestSchema.parse({ ...manifest, status });
    const row: Insertable<ToolManifestTable> = {
      tenant_id: tenant(options),
      spec_id: parsed.tool_name,
      version: manifestSpecVersion(parsed),
      status,
      spec_json: parsed,
      sha256: parsed.sha256 ?? hashJson(parsed),
      created_by: options.createdBy ?? null,
      updated_by: options.createdBy ?? null,
      published_by: executableSpecStatuses.includes(status as ExecutableSpecStatus)
        ? (options.createdBy ?? null)
        : null,
      updated_at: new Date(),
      published_at: executableSpecStatuses.includes(status as ExecutableSpecStatus)
        ? new Date()
        : null,
      revision: 1,
      gray_policy_json: grayPolicySchema.parse({}),
    };

    const saved = await this.db
      .insertInto('tool_manifest')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'spec_id', 'version']).doUpdateSet({
          status: row.status,
          spec_json: row.spec_json,
          sha256: row.sha256,
          created_by: row.created_by,
          updated_by: row.updated_by,
          published_by: row.published_by,
          updated_at: row.updated_at,
          published_at: row.published_at,
          gray_policy_json: row.gray_policy_json,
        }),
      )
      .returning(['spec_json'])
      .executeTakeFirstOrThrow();

    return toolManifestSchema.parse(saved.spec_json);
  }
}

export class ModelPolicyRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(options: ModelPolicyListOptions = {}): Promise<ModelPolicy[]> {
    let query = this.db
      .selectFrom('model_policy')
      .selectAll()
      .where('tenant_id', '=', tenant(options));
    if (options.status) {
      query = query.where('status', '=', options.status);
    }
    const rows = await query
      .orderBy('model_policy_id', 'asc')
      .orderBy('version', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapModelPolicy);
  }

  async getByIdAndVersion(
    modelPolicyId: string,
    version: number,
    options: RepositoryTenantOptions = {},
  ): Promise<ModelPolicy | undefined> {
    const row = await this.db
      .selectFrom('model_policy')
      .selectAll()
      .where('tenant_id', '=', tenant(options))
      .where('model_policy_id', '=', modelPolicyId)
      .where('version', '=', version)
      .executeTakeFirst();
    return row ? mapModelPolicy(row) : undefined;
  }

  async getLatestPublished(
    modelPolicyId: string,
    options: RepositoryTenantOptions = {},
  ): Promise<ModelPolicy | undefined> {
    const row = await this.db
      .selectFrom('model_policy')
      .selectAll()
      .where('tenant_id', '=', tenant(options))
      .where('model_policy_id', '=', modelPolicyId)
      .where('status', '=', 'published')
      .orderBy('version', 'desc')
      .executeTakeFirst();
    return row ? mapModelPolicy(row) : undefined;
  }

  async listVersions(
    modelPolicyId: string,
    options: ModelPolicyListOptions = {},
  ): Promise<ModelPolicy[]> {
    const rows = await this.db
      .selectFrom('model_policy')
      .selectAll()
      .where('tenant_id', '=', tenant(options))
      .where('model_policy_id', '=', modelPolicyId)
      .orderBy('version', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapModelPolicy);
  }

  async createDraft(policy: ModelPolicy, options: ModelPolicyWriteOptions): Promise<ModelPolicy> {
    const parsed = modelPolicySchema.parse({
      ...policy,
      status: 'draft',
      revision: 1,
      created_by: options.operatorId,
      updated_by: options.operatorId,
    });
    const row: Insertable<ModelPolicyTable> = {
      tenant_id: tenant(options),
      model_policy_id: parsed.model_policy_id,
      version: parsed.version,
      status: parsed.status,
      protocol: parsed.protocol,
      targets_json: toDbJson(parsed.targets),
      retry_policy_json: toDbJson(parsed.retry_policy),
      fallback_policy_json: toDbJson(parsed.fallback_policy),
      request_policy_json: toDbJson(parsed.request_policy),
      revision: 1,
      created_by: options.operatorId,
      updated_by: options.operatorId,
      published_by: null,
      updated_at: new Date(),
      published_at: null,
    };
    const saved = await this.db
      .insertInto('model_policy')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapModelPolicy(saved);
  }

  async updateDraft(
    modelPolicyId: string,
    version: number,
    input: ModelPolicyUpdateDraftInput,
  ): Promise<ModelPolicy> {
    const existing = await this.getByIdAndVersion(modelPolicyId, version, input);
    if (!existing) {
      throw new RegistryRepositoryError(
        'REGISTRY_VERSION_NOT_FOUND',
        'ModelPolicy version not found',
        { model_policy_id: modelPolicyId, version },
      );
    }
    if (existing.status !== 'draft' && existing.status !== 'validated') {
      throw new RegistryRepositoryError(
        'REGISTRY_VERSION_IMMUTABLE',
        'Only draft or validated ModelPolicy versions can be updated',
        {
          model_policy_id: modelPolicyId,
          version,
          status: existing.status,
        },
      );
    }
    if (existing.revision !== input.expectedRevision) {
      throw new RegistryRepositoryError(
        'REGISTRY_OPTIMISTIC_LOCK_CONFLICT',
        'ModelPolicy revision conflict',
        {
          model_policy_id: modelPolicyId,
          version,
          expected_revision: input.expectedRevision,
          actual_revision: existing.revision,
        },
      );
    }
    const updated = modelPolicySchema.parse({
      ...existing,
      ...input.policy,
      model_policy_id: modelPolicyId,
      version,
      status: 'draft',
      revision: existing.revision + 1,
      updated_by: input.operatorId,
      updated_at: new Date().toISOString(),
    });
    const row = await this.db
      .updateTable('model_policy')
      .set({
        status: updated.status,
        protocol: updated.protocol,
        targets_json: toDbJson(updated.targets),
        retry_policy_json: toDbJson(updated.retry_policy),
        fallback_policy_json: toDbJson(updated.fallback_policy),
        request_policy_json: toDbJson(updated.request_policy),
        revision: updated.revision,
        updated_by: input.operatorId,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', tenant(input))
      .where('model_policy_id', '=', modelPolicyId)
      .where('version', '=', version)
      .where('revision', '=', input.expectedRevision)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new RegistryRepositoryError(
        'REGISTRY_OPTIMISTIC_LOCK_CONFLICT',
        'ModelPolicy revision conflict',
        { model_policy_id: modelPolicyId, version },
      );
    }
    return mapModelPolicy(row);
  }

  async cloneVersion(
    modelPolicyId: string,
    version: number,
    options: ModelPolicyWriteOptions,
  ): Promise<ModelPolicy> {
    const source = await this.getByIdAndVersion(modelPolicyId, version, options);
    if (!source) {
      throw new RegistryRepositoryError(
        'REGISTRY_VERSION_NOT_FOUND',
        'ModelPolicy version not found',
        { model_policy_id: modelPolicyId, version },
      );
    }
    const nextVersion =
      options.version ??
      Math.max(
        0,
        ...(await this.listVersions(modelPolicyId, options)).map((entry) => entry.version),
      ) + 1;
    return this.createDraft(
      {
        ...source,
        version: nextVersion,
        status: 'draft',
        revision: 1,
        created_by: options.operatorId,
        updated_by: options.operatorId,
        published_by: undefined,
        created_at: undefined,
        updated_at: undefined,
        published_at: undefined,
      },
      options,
    );
  }

  async markValidated(
    modelPolicyId: string,
    version: number,
    options: ModelPolicyWriteOptions,
  ): Promise<ModelPolicy> {
    return this.updateStatus(modelPolicyId, version, 'validated', options);
  }

  async publish(
    modelPolicyId: string,
    version: number,
    options: ModelPolicyReleaseOptions,
  ): Promise<ModelPolicy> {
    return withTransaction(this.db, async (trx) => {
      const repository = new ModelPolicyRepository(trx);
      const existing = await repository.getByIdAndVersion(modelPolicyId, version, options);
      if (!existing) {
        throw new RegistryRepositoryError(
          'REGISTRY_VERSION_NOT_FOUND',
          'ModelPolicy version not found',
          { model_policy_id: modelPolicyId, version },
        );
      }
      if (
        options.expectedRevision !== undefined &&
        existing.revision !== options.expectedRevision
      ) {
        throw new RegistryRepositoryError(
          'REGISTRY_OPTIMISTIC_LOCK_CONFLICT',
          'ModelPolicy revision conflict',
          {
            model_policy_id: modelPolicyId,
            version,
            expected_revision: options.expectedRevision,
            actual_revision: existing.revision,
          },
        );
      }
      await trx
        .updateTable('model_policy')
        .set({
          status: 'deprecated',
          updated_by: options.operatorId,
          updated_at: new Date(),
          revision: sql<number>`revision + 1`,
        })
        .where('tenant_id', '=', tenant(options))
        .where('model_policy_id', '=', modelPolicyId)
        .where('status', '=', 'published')
        .where('version', '!=', version)
        .execute();
      const row = await trx
        .updateTable('model_policy')
        .set({
          status: 'published',
          published_by: options.operatorId,
          published_at: new Date(),
          updated_by: options.operatorId,
          updated_at: new Date(),
          revision: sql<number>`revision + 1`,
        })
        .where('tenant_id', '=', tenant(options))
        .where('model_policy_id', '=', modelPolicyId)
        .where('version', '=', version)
        .where('status', 'in', ['draft', 'validated'])
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw new RegistryRepositoryError(
          'INVALID_SPEC_STATUS_TRANSITION',
          'ModelPolicy cannot be published from current status',
          { model_policy_id: modelPolicyId, version },
        );
      }
      const policy = mapModelPolicy(row);
      await appendModelPolicyRelease(trx, policy, 'publish', options);
      await appendModelPolicyAudit(
        trx,
        policy,
        tenant(options),
        'model_policy.publish',
        'succeeded',
        options.operatorId,
        options.releaseNote,
      );
      return policy;
    });
  }

  async setGray(
    modelPolicyId: string,
    version: number,
    options: ModelPolicyReleaseOptions,
  ): Promise<ModelPolicy> {
    const policy = await this.updateStatus(modelPolicyId, version, 'gray', options);
    await appendModelPolicyRelease(this.db, policy, 'gray', options);
    await appendModelPolicyAudit(
      this.db,
      policy,
      tenant(options),
      'model_policy.gray',
      'succeeded',
      options.operatorId,
      options.releaseNote,
    );
    return policy;
  }

  async deprecate(
    modelPolicyId: string,
    version: number,
    options: ModelPolicyReleaseOptions,
  ): Promise<ModelPolicy> {
    const policy = await this.updateStatus(modelPolicyId, version, 'deprecated', options);
    await appendModelPolicyRelease(this.db, policy, 'deprecate', options);
    await appendModelPolicyAudit(
      this.db,
      policy,
      tenant(options),
      'model_policy.deprecated',
      'succeeded',
      options.operatorId,
      options.releaseNote,
    );
    return policy;
  }

  async disable(
    modelPolicyId: string,
    version: number,
    options: ModelPolicyReleaseOptions,
  ): Promise<ModelPolicy> {
    const policy = await this.updateStatus(modelPolicyId, version, 'disabled', options);
    await appendModelPolicyRelease(this.db, policy, 'disable', options);
    await appendModelPolicyAudit(
      this.db,
      policy,
      tenant(options),
      'model_policy.disabled',
      'succeeded',
      options.operatorId,
      options.releaseNote,
    );
    return policy;
  }

  async rollback(modelPolicyId: string, options: ModelPolicyRollbackOptions): Promise<ModelPolicy> {
    return withTransaction(this.db, async (trx) => {
      const repository = new ModelPolicyRepository(trx);
      const target = await repository.getByIdAndVersion(
        modelPolicyId,
        options.targetVersion,
        options,
      );
      if (!target) {
        throw new RegistryRepositoryError(
          'REGISTRY_VERSION_NOT_FOUND',
          'ModelPolicy rollback target not found',
          {
            model_policy_id: modelPolicyId,
            target_version: options.targetVersion,
          },
        );
      }
      const previous = await repository.getLatestPublished(modelPolicyId, options);
      await trx
        .updateTable('model_policy')
        .set({
          status: 'deprecated',
          updated_by: options.operatorId,
          updated_at: new Date(),
          revision: sql<number>`revision + 1`,
        })
        .where('tenant_id', '=', tenant(options))
        .where('model_policy_id', '=', modelPolicyId)
        .where('status', '=', 'published')
        .where('version', '!=', options.targetVersion)
        .execute();
      const row = await trx
        .updateTable('model_policy')
        .set({
          status: 'published',
          published_by: options.operatorId,
          published_at: new Date(),
          updated_by: options.operatorId,
          updated_at: new Date(),
          revision: sql<number>`revision + 1`,
        })
        .where('tenant_id', '=', tenant(options))
        .where('model_policy_id', '=', modelPolicyId)
        .where('version', '=', options.targetVersion)
        .where('status', 'in', ['published', 'gray', 'deprecated', 'disabled', 'validated'])
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw new RegistryRepositoryError(
          'REGISTRY_ROLLBACK_TARGET_NOT_PUBLISHED',
          'ModelPolicy rollback target cannot be activated',
          {
            model_policy_id: modelPolicyId,
            target_version: options.targetVersion,
          },
        );
      }
      const policy = mapModelPolicy(row);
      await appendModelPolicyRelease(trx, policy, 'rollback', options, previous?.version);
      await appendModelPolicyAudit(
        trx,
        policy,
        tenant(options),
        'model_policy.rollback',
        'succeeded',
        options.operatorId,
        options.releaseNote,
      );
      return policy;
    });
  }

  async listReleaseHistory(
    modelPolicyId: string,
    options: RepositoryTenantOptions = {},
  ): Promise<CapabilityRelease[]> {
    return new CapabilityReleaseRepository(this.db).list({
      tenantId: tenant(options),
      resourceType: 'model_policy',
      resourceId: modelPolicyId,
      limit: 100,
    });
  }

  private async updateStatus(
    modelPolicyId: string,
    version: number,
    status: ModelPolicyStatus,
    options: ModelPolicyWriteOptions,
  ): Promise<ModelPolicy> {
    const row = await this.db
      .updateTable('model_policy')
      .set({
        status,
        updated_by: options.operatorId,
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
        ...(status === 'published' || status === 'gray'
          ? { published_by: options.operatorId, published_at: new Date() }
          : {}),
      })
      .where('tenant_id', '=', tenant(options))
      .where('model_policy_id', '=', modelPolicyId)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new RegistryRepositoryError(
        'REGISTRY_VERSION_NOT_FOUND',
        'ModelPolicy version not found',
        { model_policy_id: modelPolicyId, version },
      );
    }
    return mapModelPolicy(row);
  }
}

export class TaskRunRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreateTaskRunInput): Promise<TaskRun> {
    const taskRun = taskRunSchema.parse(input.taskRun);
    const row: Insertable<TaskRunTable> = {
      task_run_id: taskRun.task_run_id,
      tenant_id: taskRun.tenant_id,
      user_id: taskRun.user_id,
      route_type: taskRun.route_type,
      flow_id: taskRun.flow_id ?? null,
      flow_version: taskRun.flow_version ?? null,
      workflow_id: taskRun.workflow_id ?? null,
      execution_plan_ref: taskRun.execution_plan_ref ?? input.executionPlanRef ?? null,
      tenant_policy_snapshot_ref:
        taskRun.tenant_policy_snapshot_ref ?? input.tenantPolicySnapshotRef ?? null,
      tenant_policy_hash: taskRun.tenant_policy_hash ?? input.tenantPolicyHash ?? null,
      tenant_admission_id: taskRun.tenant_admission_id ?? input.tenantAdmissionId ?? null,
      status: taskRun.status,
      error_code: taskRun.error_code ?? null,
      error_message: taskRun.error_message ?? null,
      input_json: toDbJson(input.input),
      route_result_json: input.routeResult ? toDbJson(input.routeResult) : null,
      workflow_start_json: input.workflowStart ? toDbJson(input.workflowStart) : null,
    };

    const saved = await this.db
      .insertInto('task_run')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapTaskRun(saved);
  }

  async get(taskRunId: string): Promise<TaskRun | undefined> {
    const row = await this.db
      .selectFrom('task_run')
      .selectAll()
      .where('task_run_id', '=', taskRunId)
      .executeTakeFirst();

    return row ? mapTaskRun(row) : undefined;
  }

  async list(options: ListTaskRunsOptions = {}): Promise<TaskRun[]> {
    let query = this.db.selectFrom('task_run').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.status) {
      query = query.where('status', '=', options.status);
    }
    if (options.flowId) {
      query = query.where('flow_id', '=', options.flowId);
    }
    if (options.workflowId) {
      query = query.where('workflow_id', '=', options.workflowId);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapTaskRun);
  }

  async updateStatus(
    taskRunId: string,
    input: TaskRun['status'] | UpdateTaskRunStatusInput,
  ): Promise<TaskRun | undefined> {
    const normalized = typeof input === 'string' ? { status: input } : input;
    const parsedStatus = taskRunStatusSchema.parse(normalized.status);
    const failureStatus = parsedStatus === 'failed' || parsedStatus === 'failed_to_start';
    const rowUpdate: Updateable<TaskRunTable> = {
      status: parsedStatus,
      updated_at: new Date(),
      error_code: failureStatus ? (normalized.errorCode ?? 'WORKFLOW_FAILED') : null,
      error_message: failureStatus ? (normalized.errorMessage ?? 'Workflow failed') : null,
    };
    const row = await this.db
      .updateTable('task_run')
      .set(rowUpdate)
      .where('task_run_id', '=', taskRunId)
      .returningAll()
      .executeTakeFirst();

    return row ? mapTaskRun(row) : undefined;
  }

  async updateWorkflowStart(
    taskRunId: string,
    workflowStart: WorkflowStartResponse,
  ): Promise<TaskRun | undefined> {
    const row = await this.db
      .updateTable('task_run')
      .set({ workflow_start_json: toDbJson(workflowStart), updated_at: new Date() })
      .where('task_run_id', '=', taskRunId)
      .returningAll()
      .executeTakeFirst();

    return row ? mapTaskRun(row) : undefined;
  }
}

export class AgentRunRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    const agentRunId = input.agentRunId ?? `agent_run_${randomUUID()}`;
    const now = new Date();
    const plan = input.executionPlan;
    const row: Insertable<AgentRunTable> = {
      agent_run_id: agentRunId,
      tenant_id: input.tenantId,
      user_id: input.userId,
      task_run_id: input.taskRunId,
      workflow_id: input.workflowId,
      workflow_run_id: input.workflowRunId ?? null,
      parent_workflow_id: input.parentWorkflowId ?? null,
      execution_plan_ref: plan.execution_plan_ref,
      execution_plan_hash: plan.execution_plan_hash,
      agent_id: plan.agent_id,
      agent_version: plan.agent_version,
      prompt_id: plan.prompt_id,
      prompt_version: plan.prompt_version,
      model: plan.model_policy,
      model_policy_id: plan.model_policy_id,
      model_policy_version: plan.model_policy_version,
      model_policy_hash: plan.model_policy_hash,
      selected_model_id: plan.resolved_model_policy.resolved_targets[0]?.model_id ?? null,
      selected_provider: plan.resolved_model_policy.resolved_targets[0]?.gateway_profile ?? null,
      fallback_count: 0,
      model_call_count: 0,
      execution_mode: input.executionMode ?? 'mediated_tool_call',
      tenant_policy_snapshot_ref: input.tenantPolicySnapshotRef ?? null,
      tenant_policy_version: input.tenantPolicyVersion ?? null,
      tenant_policy_hash: input.tenantPolicyHash ?? null,
      tenant_admission_id: input.tenantAdmissionId ?? null,
      status: 'queued',
      current_segment_index: 0,
      model_turn_count: 0,
      tool_call_count: 0,
      handoff_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      estimated_cost: null,
      started_at: now,
      completed_at: null,
      error_code: null,
      error_message: null,
    };
    const saved = await this.db
      .insertInto('agent_run')
      .values(row)
      .onConflict((oc) => oc.column('agent_run_id').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (saved) {
      return mapAgentRun(saved);
    }
    const existing = await this.get(agentRunId, { tenantId: input.tenantId });
    if (!existing) {
      throw new Error(`AgentRun insert conflict but existing run was not found: ${agentRunId}`);
    }
    return existing;
  }

  async get(
    agentRunId: string,
    options: RepositoryTenantOptions = {},
  ): Promise<AgentRunRecord | undefined> {
    let query = this.db.selectFrom('agent_run').selectAll().where('agent_run_id', '=', agentRunId);
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    const row = await query.executeTakeFirst();
    return row ? mapAgentRun(row) : undefined;
  }

  async list(options: ListAgentRunsOptions = {}): Promise<AgentRunRecord[]> {
    let query = this.db.selectFrom('agent_run').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.taskRunId) {
      query = query.where('task_run_id', '=', options.taskRunId);
    }
    if (options.agentId) {
      query = query.where('agent_id', '=', options.agentId);
    }
    if (options.status) {
      query = query.where('status', '=', options.status);
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapAgentRun);
  }

  async update(
    agentRunId: string,
    input: UpdateAgentRunInput,
  ): Promise<AgentRunRecord | undefined> {
    const rowUpdate: Updateable<AgentRunTable> = { updated_at: new Date() };
    if (input.status) {
      rowUpdate.status = agentRunStatusSchema.parse(input.status);
    }
    if (input.workflowRunId !== undefined) {
      rowUpdate.workflow_run_id = input.workflowRunId;
    }
    if (input.currentSegmentIndex !== undefined) {
      rowUpdate.current_segment_index = input.currentSegmentIndex;
    }
    if (input.modelTurnCount !== undefined) {
      rowUpdate.model_turn_count = input.modelTurnCount;
    }
    if (input.toolCallCount !== undefined) {
      rowUpdate.tool_call_count = input.toolCallCount;
    }
    if (input.handoffCount !== undefined) {
      rowUpdate.handoff_count = input.handoffCount;
    }
    if (input.fallbackCount !== undefined) {
      rowUpdate.fallback_count = input.fallbackCount;
    }
    if (input.modelCallCount !== undefined) {
      rowUpdate.model_call_count = input.modelCallCount;
    }
    if (input.selectedModelId !== undefined) {
      rowUpdate.selected_model_id = input.selectedModelId;
    }
    if (input.selectedProvider !== undefined) {
      rowUpdate.selected_provider = input.selectedProvider;
    }
    if (input.usage) {
      if (input.usage.input_tokens !== undefined) {
        rowUpdate.input_tokens = input.usage.input_tokens;
      }
      if (input.usage.output_tokens !== undefined) {
        rowUpdate.output_tokens = input.usage.output_tokens;
      }
      if (input.usage.total_tokens !== undefined) {
        rowUpdate.total_tokens = input.usage.total_tokens;
      }
      if (input.usage.estimated_cost !== undefined) {
        rowUpdate.estimated_cost = input.usage.estimated_cost;
      }
    }
    if (input.completed) {
      rowUpdate.completed_at = new Date();
    }
    if (input.errorCode !== undefined) {
      rowUpdate.error_code = input.errorCode;
    }
    if (input.errorMessage !== undefined) {
      rowUpdate.error_message = input.errorMessage;
    }
    if (input.tenantPolicySnapshotRef !== undefined) {
      rowUpdate.tenant_policy_snapshot_ref = input.tenantPolicySnapshotRef;
    }
    if (input.tenantPolicyVersion !== undefined) {
      rowUpdate.tenant_policy_version = input.tenantPolicyVersion;
    }
    if (input.tenantPolicyHash !== undefined) {
      rowUpdate.tenant_policy_hash = input.tenantPolicyHash;
    }
    if (input.tenantAdmissionId !== undefined) {
      rowUpdate.tenant_admission_id = input.tenantAdmissionId;
    }
    const row = await this.db
      .updateTable('agent_run')
      .set(rowUpdate)
      .where('agent_run_id', '=', agentRunId)
      .returningAll()
      .executeTakeFirst();
    return row ? mapAgentRun(row) : undefined;
  }
}

export class AgentStepRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreateAgentStepInput): Promise<AgentStepRecord> {
    const parsed = agentStepRecordSchema.parse({
      ...input,
      agent_step_id: input.agent_step_id ?? `agent_step_${randomUUID()}`,
    });
    const row: Insertable<AgentStepTable> = {
      agent_step_id: parsed.agent_step_id,
      agent_run_id: parsed.agent_run_id,
      segment_index: parsed.segment_index,
      stable_step_key: parsed.stable_step_key,
      segment_status: parsed.segment_status,
      decision_summary: parsed.decision_summary ?? null,
      proposed_tool_calls_json: toDbJson(parsed.proposed_tool_calls),
      tool_result_refs_json: toDbJson(parsed.tool_result_refs),
      authoritative_tool_result_refs_json: toDbJson(parsed.authoritative_tool_result_refs),
      human_task_ids_json: toDbJson(parsed.human_task_ids),
      context_snapshot_before_ref: parsed.context_snapshot_before
        ? toDbJson(parsed.context_snapshot_before)
        : null,
      context_snapshot_after_ref: parsed.context_snapshot_after
        ? toDbJson(parsed.context_snapshot_after)
        : null,
      handoff_refs_json: toDbJson(parsed.handoff_refs),
      context_snapshot_ref: parsed.context_snapshot_ref
        ? toDbJson(parsed.context_snapshot_ref)
        : null,
      output_ref: parsed.output_ref ?? null,
      usage_json: toDbJson(parsed.usage),
      error_code: parsed.error_code ?? null,
      error_message: parsed.error_message ?? null,
    };

    const saved = await this.db
      .insertInto('agent_step')
      .values(row)
      .onConflict((oc) =>
        oc.column('stable_step_key').doUpdateSet({
          segment_status: row.segment_status,
          decision_summary: row.decision_summary,
          proposed_tool_calls_json: row.proposed_tool_calls_json,
          usage_json: row.usage_json,
          error_code: row.error_code,
          error_message: row.error_message,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirst();

    if (saved) {
      return mapAgentStep(saved);
    }
    const existing = await this.getByStableKey(parsed.stable_step_key);
    if (!existing) {
      throw new Error(
        `AgentStep insert conflict but existing step was not found: ${parsed.stable_step_key}`,
      );
    }
    return existing;
  }

  async updateBoundaryResult(input: UpdateAgentStepBoundaryInput): Promise<AgentStepRecord> {
    const rowUpdate: Updateable<AgentStepTable> = {
      updated_at: new Date(),
    };
    if (input.segmentStatus) {
      rowUpdate.segment_status = input.segmentStatus;
    }
    if (input.decisionSummary !== undefined) {
      rowUpdate.decision_summary = input.decisionSummary;
    }
    if (input.proposedToolCalls !== undefined) {
      rowUpdate.proposed_tool_calls_json = toDbJson(input.proposedToolCalls);
    }
    if (input.toolResultRefs !== undefined) {
      rowUpdate.tool_result_refs_json = toDbJson(input.toolResultRefs);
    }
    if (input.authoritativeToolResultRefs !== undefined) {
      rowUpdate.authoritative_tool_result_refs_json = toDbJson(input.authoritativeToolResultRefs);
      rowUpdate.tool_result_refs_json = toDbJson(
        input.toolResultRefs ?? input.authoritativeToolResultRefs,
      );
    }
    if (input.humanTaskIds !== undefined) {
      rowUpdate.human_task_ids_json = toDbJson(input.humanTaskIds);
    }
    if (input.contextSnapshotBefore !== undefined) {
      rowUpdate.context_snapshot_before_ref = input.contextSnapshotBefore
        ? toDbJson(input.contextSnapshotBefore)
        : null;
    }
    if (input.contextSnapshotAfter !== undefined) {
      rowUpdate.context_snapshot_after_ref = input.contextSnapshotAfter
        ? toDbJson(input.contextSnapshotAfter)
        : null;
    }
    if (input.contextSnapshotRef !== undefined) {
      rowUpdate.context_snapshot_ref = input.contextSnapshotRef
        ? toDbJson(input.contextSnapshotRef)
        : null;
    }
    if (input.handoffRefs !== undefined) {
      rowUpdate.handoff_refs_json = toDbJson(input.handoffRefs);
    }
    if (input.outputRef !== undefined) {
      rowUpdate.output_ref = input.outputRef;
    }
    if (input.usage !== undefined) {
      rowUpdate.usage_json = toDbJson(agentUsageSchema.parse(input.usage));
    }
    if (input.errorCode !== undefined) {
      rowUpdate.error_code = input.errorCode;
    }
    if (input.errorMessage !== undefined) {
      rowUpdate.error_message = input.errorMessage;
    }

    const row = await this.db
      .updateTable('agent_step')
      .set(rowUpdate)
      .where('stable_step_key', '=', input.stableStepKey)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new Error(`AgentStep not found: ${input.stableStepKey}`);
    }
    return mapAgentStep(row);
  }

  async getByStableKey(stableStepKey: string): Promise<AgentStepRecord | undefined> {
    const row = await this.db
      .selectFrom('agent_step')
      .selectAll()
      .where('stable_step_key', '=', stableStepKey)
      .executeTakeFirst();
    return row ? mapAgentStep(row) : undefined;
  }

  async listByRun(
    agentRunId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<AgentStepRecord[]> {
    const rows = await this.db
      .selectFrom('agent_step')
      .selectAll()
      .where('agent_run_id', '=', agentRunId)
      .orderBy('segment_index', 'asc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapAgentStep);
  }
}

export class AgentContextSnapshotRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreateAgentContextSnapshotInput): Promise<PiContextSnapshotRef> {
    const snapshotId = input.snapshotId ?? `snapshot_${randomUUID()}`;
    const schemaVersion = input.schemaVersion;
    const byteSize = Buffer.byteLength(stableStringify(input.sanitizedMessages), 'utf8');
    const messageCount = input.sanitizedMessages.length;
    const snapshotHash = hashJson({
      schema_version: schemaVersion,
      messages: input.sanitizedMessages,
      previous_snapshot_id: input.previousSnapshotId ?? null,
    });
    const row: Insertable<AgentContextSnapshotTable> = {
      snapshot_id: snapshotId,
      agent_run_id: input.agentRunId,
      previous_snapshot_id: input.previousSnapshotId ?? null,
      schema_version: schemaVersion,
      sanitized_messages_json: toDbJson(input.sanitizedMessages),
      snapshot_hash: snapshotHash,
      message_count: messageCount,
      byte_size: byteSize,
    };
    const saved = await this.db
      .insertInto('agent_context_snapshot')
      .values(row)
      .onConflict((oc) => oc.column('snapshot_hash').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (saved) {
      return snapshotRefFromSnapshotRow(saved);
    }
    const existing = await this.getByHash(snapshotHash);
    if (!existing) {
      throw new Error(
        `AgentContextSnapshot insert conflict but existing snapshot was not found: ${snapshotHash}`,
      );
    }
    return existing.ref;
  }

  async get(
    snapshotId: string,
  ): Promise<
    { ref: PiContextSnapshotRef; messages: unknown[]; previousSnapshotId?: string } | undefined
  > {
    const row = await this.db
      .selectFrom('agent_context_snapshot')
      .selectAll()
      .where('snapshot_id', '=', snapshotId)
      .executeTakeFirst();
    return row ? snapshotFromRow(row) : undefined;
  }

  async getByHash(
    snapshotHash: string,
  ): Promise<
    { ref: PiContextSnapshotRef; messages: unknown[]; previousSnapshotId?: string } | undefined
  > {
    const row = await this.db
      .selectFrom('agent_context_snapshot')
      .selectAll()
      .where('snapshot_hash', '=', snapshotHash)
      .executeTakeFirst();
    return row ? snapshotFromRow(row) : undefined;
  }
}

export class AuditEventRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async append(event: Omit<AuditEvent, 'event_id' | 'occurred_at'>): Promise<AuditEvent> {
    const auditEvent = auditEventSchema.parse({
      ...event,
      event_id: `audit_${randomUUID()}`,
      occurred_at: new Date().toISOString(),
    });
    const row: Insertable<AuditEventTable> = {
      event_id: auditEvent.event_id,
      event_key: auditEvent.event_key ?? null,
      tenant_id: auditEvent.tenant_id,
      actor_id: auditEvent.actor_id ?? null,
      action: auditEvent.action,
      target_type: auditEvent.target_type,
      target_id: auditEvent.target_id,
      result: auditEvent.result,
      reason: auditEvent.reason ?? null,
      payload: toDbJson(auditEvent.payload),
      trace_id: auditEvent.trace_id ?? null,
      occurred_at: auditEvent.occurred_at,
    };

    const insert = this.db.insertInto('audit_event').values(row);
    const saved = auditEvent.event_key
      ? await insert
          .onConflict((oc) => oc.column('event_key').where('event_key', 'is not', null).doNothing())
          .returningAll()
          .executeTakeFirst()
      : await insert.returningAll().executeTakeFirst();
    if (saved) {
      return mapAuditEvent(saved);
    }
    if (auditEvent.event_key) {
      const existing = await this.getByEventKey(auditEvent.event_key);
      if (existing) {
        return existing;
      }
    }
    throw new Error('AUDIT_EVENT_INSERT_CONFLICT');
  }

  async getByEventKey(eventKey: string): Promise<AuditEvent | undefined> {
    const row = await this.db
      .selectFrom('audit_event')
      .selectAll()
      .where('event_key', '=', eventKey)
      .executeTakeFirst();
    return row ? mapAuditEvent(row) : undefined;
  }

  async list(options: ListAuditEventsOptions = {}): Promise<AuditEvent[]> {
    let query = this.db.selectFrom('audit_event').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.targetType) {
      query = query.where('target_type', '=', options.targetType);
    }
    if (options.targetId) {
      query = query.where('target_id', '=', options.targetId);
    }
    if (options.action) {
      query = query.where('action', '=', options.action);
    }
    if (options.toolName) {
      query = query.where('target_id', '=', options.toolName);
    }
    if (options.taskRunId) {
      query = query.where(sql<string>`payload->>'task_run_id'`, '=', options.taskRunId);
    }
    if (options.startTime) {
      query = query.where('occurred_at', '>=', new Date(options.startTime));
    }
    if (options.endTime) {
      query = query.where('occurred_at', '<=', new Date(options.endTime));
    }

    const rows = await query
      .orderBy('occurred_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapAuditEvent);
  }
}

export class HumanTaskRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: HumanTaskCreateRequest & { human_task_id?: string }): Promise<HumanTask> {
    const parsed = humanTaskCreateRequestSchema.parse(input);
    const humanTaskId = input.human_task_id ?? `human_${randomUUID()}`;
    const payload = {
      ...parsed.payload,
      ...(parsed.tool_call_id ? { tool_call_id: parsed.tool_call_id } : {}),
      ...(parsed.tool_name ? { tool_name: parsed.tool_name } : {}),
      requested_by: parsed.user_id,
    };
    const row: Insertable<HumanTaskTable> = {
      human_task_id: humanTaskId,
      tenant_id: parsed.tenant_id,
      task_run_id: parsed.task_run_id,
      workflow_id: parsed.workflow_id ?? null,
      kind: parsed.kind,
      status: 'pending',
      assignee: parsed.assignee ?? null,
      candidate_groups: toDbJson(parsed.candidate_groups),
      payload: toDbJson(payload),
      requested_schema_json: parsed.requested_schema ? toDbJson(parsed.requested_schema) : null,
      response_json: null,
      responded_by: null,
      responded_at: null,
      response_idempotency_key: null,
      decision: null,
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      completed_at: null,
    };

    const saved = await this.db
      .insertInto('human_task')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapHumanTask(saved);
  }

  async get(humanTaskId: string): Promise<HumanTask | undefined> {
    const row = await this.db
      .selectFrom('human_task')
      .selectAll()
      .where('human_task_id', '=', humanTaskId)
      .executeTakeFirst();

    return row ? mapHumanTask(row) : undefined;
  }

  async approve(
    humanTaskId: string,
    input: HumanTaskDecisionInput,
  ): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'approved', input);
  }

  async reject(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'rejected', input);
  }

  async cancel(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'cancelled', input);
  }

  async expire(humanTaskId: string, input: HumanTaskDecisionInput): Promise<HumanTask | undefined> {
    return this.decide(humanTaskId, 'expired', input);
  }

  async respond(
    humanTaskId: string,
    input: HumanTaskRespondInput,
  ): Promise<{ humanTask?: HumanTask; conflict: boolean; idempotentReplay: boolean }> {
    const parsed = humanTaskRespondRequestSchema.parse({
      tenant_id: input.tenantId ?? 'default',
      user_id: input.userId,
      response: input.response,
      response_idempotency_key: input.responseIdempotencyKey,
    });
    const existing = await this.get(humanTaskId);
    if (!existing || (input.tenantId && existing.tenant_id !== input.tenantId)) {
      return { conflict: false, idempotentReplay: false };
    }
    if (existing.kind !== 'user_input') {
      throw new Error(`HumanTask is not user_input kind: ${humanTaskId}`);
    }
    if (existing.response_idempotency_key) {
      if (
        existing.response_idempotency_key === parsed.response_idempotency_key &&
        hashJson(existing.response ?? {}) === hashJson(parsed.response)
      ) {
        return { humanTask: existing, conflict: false, idempotentReplay: true };
      }
      return { humanTask: existing, conflict: true, idempotentReplay: false };
    }
    if (
      existing.status !== 'pending' &&
      existing.status !== 'created' &&
      existing.status !== 'assigned'
    ) {
      return { humanTask: existing, conflict: true, idempotentReplay: false };
    }

    const respondedAt = new Date();
    let query = this.db
      .updateTable('human_task')
      .set({
        status: 'resolved',
        response_json: toDbJson(parsed.response),
        responded_by: parsed.user_id,
        responded_at: respondedAt,
        response_idempotency_key: parsed.response_idempotency_key,
        decision: toDbJson({
          status: 'resolved',
          payload: parsed.response,
        }),
        decided_by: parsed.user_id,
        decided_at: respondedAt,
        completed_at: respondedAt,
      })
      .where('human_task_id', '=', humanTaskId);

    if (input.tenantId) {
      query = query.where('tenant_id', '=', input.tenantId);
    }

    const row = await query.returningAll().executeTakeFirst();
    const humanTask = row ? mapHumanTask(row) : undefined;
    return humanTask
      ? { humanTask, conflict: false, idempotentReplay: false }
      : { conflict: false, idempotentReplay: false };
  }

  async listByTaskRunId(
    taskRunId: string,
    options: RepositoryTenantOptions = {},
  ): Promise<HumanTask[]> {
    let query = this.db.selectFrom('human_task').selectAll().where('task_run_id', '=', taskRunId);

    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }

    const rows = await query.orderBy('created_at', 'asc').execute();
    return rows.map(mapHumanTask);
  }

  async list(options: ListHumanTasksOptions = {}): Promise<HumanTask[]> {
    let query = this.db.selectFrom('human_task').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.taskRunId) {
      query = query.where('task_run_id', '=', options.taskRunId);
    }
    if (options.status) {
      query = query.where('status', '=', options.status);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapHumanTask);
  }

  private async decide(
    humanTaskId: string,
    status: HumanTask['status'],
    input: HumanTaskDecisionInput,
  ): Promise<HumanTask | undefined> {
    const existing = await this.get(humanTaskId);
    if (!existing || (input.tenantId && existing.tenant_id !== input.tenantId)) {
      return undefined;
    }
    if (
      existing.status !== 'pending' &&
      existing.status !== 'created' &&
      existing.status !== 'assigned'
    ) {
      return existing;
    }

    const decidedAt = new Date();
    let query = this.db
      .updateTable('human_task')
      .set({
        status,
        decision: toDbJson({
          status,
          reason: input.decisionReason,
          payload: input.payload ?? {},
        }),
        decided_by: input.decidedBy,
        decided_at: decidedAt,
        decision_reason: input.decisionReason ?? null,
        completed_at: decidedAt,
      })
      .where('human_task_id', '=', humanTaskId);

    if (input.tenantId) {
      query = query.where('tenant_id', '=', input.tenantId);
    }

    const row = await query.returningAll().executeTakeFirst();
    return row ? mapHumanTask(row) : undefined;
  }
}

export class IdempotencyRecordRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async get(idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    const row = await this.db
      .selectFrom('idempotency_record')
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();

    return row ? mapIdempotencyRecord(row) : undefined;
  }

  async insert(
    record: Omit<IdempotencyRecord, 'created_at' | 'updated_at'>,
  ): Promise<IdempotencyRecord> {
    const parsed = idempotencyRecordSchema.parse(record);
    const row: Insertable<IdempotencyRecordTable> = {
      idempotency_key: parsed.idempotency_key,
      tenant_id: parsed.tenant_id,
      target_type: parsed.target_type,
      target_id: parsed.target_id,
      request_hash: parsed.request_hash,
      response_json: parsed.response_json ? toDbJson(parsed.response_json) : null,
      status: parsed.status,
    };

    const saved = await this.db
      .insertInto('idempotency_record')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapIdempotencyRecord(saved);
  }

  async replayOrConflict(input: IdempotencyReplayInput): Promise<IdempotencyReplayDecision> {
    const record = await this.get(input.idempotencyKey);
    if (!record) {
      return { decision: 'miss' };
    }

    if (
      record.tenant_id !== input.tenantId ||
      record.target_type !== input.targetType ||
      record.target_id !== input.targetId ||
      record.request_hash !== input.requestHash
    ) {
      return { decision: 'conflict', record };
    }

    return { decision: 'replay', record };
  }
}

export class ToolCallLogRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: ToolCallLogCreateInput): Promise<ToolCallLog> {
    const toolCallLog = toolCallLogSchema.parse({
      ...input,
      tool_call_id: input.tool_call_id ?? `tool_call_${randomUUID()}`,
    });
    const row: Insertable<ToolCallLogTable> = {
      tool_call_id: toolCallLog.tool_call_id,
      task_run_id: toolCallLog.task_run_id ?? null,
      workflow_id: toolCallLog.workflow_id ?? null,
      tenant_id: toolCallLog.tenant_id,
      user_id: toolCallLog.user_id ?? null,
      tool_name: toolCallLog.tool_name,
      tool_version: toolCallLog.tool_version,
      risk_level: toolCallLog.risk_level,
      policy_decision: toolCallLog.policy_decision,
      status: toolCallLog.status,
      duration_ms: toolCallLog.duration_ms ?? null,
      idempotency_key: toolCallLog.idempotency_key ?? null,
      input_hash: toolCallLog.input_hash ?? null,
      output_hash: toolCallLog.output_hash ?? null,
      error_code: toolCallLog.error_code ?? null,
      adapter_type: toolCallLog.adapter_type ?? null,
      mode: toolCallLog.mode ?? null,
      preview_json: toolCallLog.preview_json ? toDbJson(toolCallLog.preview_json) : null,
      result_json: toolCallLog.result_json ? toDbJson(toolCallLog.result_json) : null,
      tenant_policy_snapshot_ref:
        toolCallLog.tenant_policy_snapshot_ref ?? input.tenant_policy_snapshot_ref ?? null,
      policy_decision_code: toolCallLog.policy_decision_code ?? input.policy_decision_code ?? null,
    };

    const saved = await this.db
      .insertInto('tool_call_log')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapToolCallLog(saved);
  }

  async get(toolCallId: string): Promise<ToolCallLog | undefined> {
    const row = await this.db
      .selectFrom('tool_call_log')
      .selectAll()
      .where('tool_call_id', '=', toolCallId)
      .executeTakeFirst();

    return row ? mapToolCallLog(row) : undefined;
  }

  async update(
    toolCallId: string,
    input: ToolCallLogUpdateInput,
  ): Promise<ToolCallLog | undefined> {
    const rowUpdate: Updateable<ToolCallLogTable> = {
      updated_at: new Date(),
    };
    if (input.status) {
      rowUpdate.status = input.status;
    }
    if (input.policy_decision) {
      rowUpdate.policy_decision = input.policy_decision;
    }
    if (input.mode) {
      rowUpdate.mode = input.mode;
    }
    if (input.duration_ms !== undefined) {
      rowUpdate.duration_ms = input.duration_ms;
    }
    if (input.output_hash !== undefined) {
      rowUpdate.output_hash = input.output_hash;
    }
    if (input.error_code !== undefined) {
      rowUpdate.error_code = input.error_code;
    }
    if (input.preview_json !== undefined) {
      rowUpdate.preview_json = input.preview_json;
    }
    if (input.result_json !== undefined) {
      rowUpdate.result_json = input.result_json;
    }
    if (input.tenant_policy_snapshot_ref !== undefined) {
      rowUpdate.tenant_policy_snapshot_ref = input.tenant_policy_snapshot_ref;
    }
    if (input.policy_decision_code !== undefined) {
      rowUpdate.policy_decision_code = input.policy_decision_code;
    }

    const row = await this.db
      .updateTable('tool_call_log')
      .set(rowUpdate)
      .where('tool_call_id', '=', toolCallId)
      .returningAll()
      .executeTakeFirst();

    return row ? mapToolCallLog(row) : undefined;
  }

  async list(options: ListToolCallLogsOptions = {}): Promise<ToolCallLog[]> {
    let query = this.db.selectFrom('tool_call_log').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.taskRunId) {
      query = query.where('task_run_id', '=', options.taskRunId);
    }
    if (options.toolName) {
      query = query.where('tool_name', '=', options.toolName);
    }
    if (options.status) {
      query = query.where('status', '=', options.status);
    }

    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapToolCallLog);
  }
}

export class ModelCallLogRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createOrGet(input: ModelCallCreateOrGetInput): Promise<ModelCallCreateOrGetResult> {
    const existing = await this.getByRequestKey(input.model_request_key);
    if (existing) {
      if (existing.request_hash !== input.request_hash) {
        return { decision: 'conflict', record: existing };
      }
      if (existing.status === 'succeeded' || existing.status === 'replayed') {
        return { decision: 'replay', record: existing };
      }
      return { decision: 'existing', record: existing };
    }

    const parsed = modelCallRecordSchema.parse({
      model_call_id: input.model_call_id ?? `model_call_${randomUUID()}`,
      model_request_key: input.model_request_key,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      task_run_id: input.task_run_id,
      workflow_id: input.workflow_id,
      workflow_run_id: input.workflow_run_id,
      agent_run_id: input.agent_run_id,
      segment_index: input.segment_index,
      model_turn_index: input.model_turn_index,
      model_policy_id: input.model_policy_id,
      model_policy_version: input.model_policy_version,
      model_policy_hash: input.model_policy_hash,
      protocol: input.protocol,
      fallback_index: input.fallback_index ?? 0,
      status: 'queued',
      request_hash: input.request_hash,
    });
    const row: Insertable<ModelCallLogTable> = {
      model_call_id: parsed.model_call_id,
      model_request_key: parsed.model_request_key,
      tenant_id: parsed.tenant_id,
      user_id: parsed.user_id ?? null,
      task_run_id: parsed.task_run_id ?? null,
      workflow_id: parsed.workflow_id ?? null,
      workflow_run_id: parsed.workflow_run_id ?? null,
      agent_run_id: parsed.agent_run_id ?? null,
      segment_index: parsed.segment_index ?? null,
      model_turn_index: parsed.model_turn_index ?? null,
      model_policy_id: parsed.model_policy_id,
      model_policy_version: parsed.model_policy_version,
      model_policy_hash: parsed.model_policy_hash,
      target_id: null,
      provider: null,
      model_id: null,
      protocol: parsed.protocol,
      attempt_count: 0,
      fallback_index: parsed.fallback_index,
      status: parsed.status,
      finish_reason: null,
      response_id: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      estimated_cost: null,
      latency_ms: null,
      error_class: null,
      error_code: null,
      request_hash: parsed.request_hash,
      response_hash: null,
      safe_response_json: null,
      started_at: null,
      completed_at: null,
      updated_at: new Date(),
    };
    const saved = await this.db
      .insertInto('model_call_log')
      .values(row)
      .onConflict((oc) => oc.column('model_request_key').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (saved) {
      return { decision: 'created', record: mapModelCallRecord(saved) };
    }
    const raced = await this.getByRequestKey(input.model_request_key);
    if (!raced) {
      throw new Error(
        `ModelCall insert conflict but existing record was not found: ${input.model_request_key}`,
      );
    }
    if (raced.request_hash !== input.request_hash) {
      return { decision: 'conflict', record: raced };
    }
    return raced.status === 'succeeded' || raced.status === 'replayed'
      ? { decision: 'replay', record: raced }
      : { decision: 'existing', record: raced };
  }

  async markRunning(
    modelCallId: string,
    input: { targetId: string; provider?: string; modelId: string; fallbackIndex?: number },
  ): Promise<ModelCallRecord> {
    const row = await this.db
      .updateTable('model_call_log')
      .set({
        status: 'running',
        target_id: input.targetId,
        provider: input.provider ?? null,
        model_id: input.modelId,
        fallback_index: input.fallbackIndex ?? 0,
        started_at: new Date(),
        updated_at: new Date(),
      })
      .where('model_call_id', '=', modelCallId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapModelCallRecord(row);
  }

  async markSucceeded(
    modelCallId: string,
    input: {
      targetId: string;
      provider?: string;
      modelId: string;
      attemptCount: number;
      fallbackIndex: number;
      finishReason?: string;
      responseId?: string;
      usage?: ModelUsage;
      latencyMs?: number;
      responseHash: string;
      safeResponseJson: Record<string, unknown>;
    },
  ): Promise<ModelCallRecord> {
    const row = await this.db
      .updateTable('model_call_log')
      .set({
        status: 'succeeded',
        target_id: input.targetId,
        provider: input.provider ?? null,
        model_id: input.modelId,
        attempt_count: input.attemptCount,
        fallback_index: input.fallbackIndex,
        finish_reason: input.finishReason ?? null,
        response_id: input.responseId ?? null,
        input_tokens: input.usage?.input_tokens ?? null,
        output_tokens: input.usage?.output_tokens ?? null,
        total_tokens: input.usage?.total_tokens ?? null,
        estimated_cost: input.usage?.estimated_total_cost ?? null,
        latency_ms: input.latencyMs ?? null,
        response_hash: input.responseHash,
        safe_response_json: toDbJson(input.safeResponseJson),
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('model_call_id', '=', modelCallId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapModelCallRecord(row);
  }

  async markFailed(
    modelCallId: string,
    input: {
      status?: Extract<ModelCallStatus, 'failed' | 'timed_out' | 'cancelled'>;
      attemptCount?: number;
      fallbackIndex?: number;
      errorClass: string;
      errorCode: string;
      latencyMs?: number;
    },
  ): Promise<ModelCallRecord> {
    const row = await this.db
      .updateTable('model_call_log')
      .set({
        status: input.status ?? 'failed',
        attempt_count: input.attemptCount ?? 0,
        fallback_index: input.fallbackIndex ?? 0,
        error_class: input.errorClass,
        error_code: input.errorCode,
        latency_ms: input.latencyMs ?? null,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('model_call_id', '=', modelCallId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapModelCallRecord(row);
  }

  async markCancelled(modelCallId: string): Promise<ModelCallRecord> {
    return this.markFailed(modelCallId, {
      status: 'cancelled',
      errorClass: 'cancelled',
      errorCode: 'MODEL_CALL_CANCELLED',
    });
  }

  async replaySucceededResult(
    modelRequestKey: string,
    requestHash: string,
  ): Promise<ModelCallRecord | undefined> {
    const record = await this.getByRequestKey(modelRequestKey);
    if (
      !record ||
      (record.status !== 'succeeded' && record.status !== 'replayed') ||
      record.request_hash !== requestHash
    ) {
      return undefined;
    }
    await this.db
      .updateTable('model_call_log')
      .set({ status: 'replayed', updated_at: new Date() })
      .where('model_call_id', '=', record.model_call_id)
      .execute();
    return record;
  }

  async getByRequestKey(modelRequestKey: string): Promise<ModelCallRecord | undefined> {
    const row = await this.db
      .selectFrom('model_call_log')
      .selectAll()
      .where('model_request_key', '=', modelRequestKey)
      .executeTakeFirst();
    return row ? mapModelCallRecord(row) : undefined;
  }

  async get(modelCallId: string): Promise<ModelCallRecord | undefined> {
    const row = await this.db
      .selectFrom('model_call_log')
      .selectAll()
      .where('model_call_id', '=', modelCallId)
      .executeTakeFirst();
    return row ? mapModelCallRecord(row) : undefined;
  }

  async list(options: ModelCallListOptions = {}): Promise<ModelCallRecord[]> {
    let query = this.db.selectFrom('model_call_log').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.taskRunId) {
      query = query.where('task_run_id', '=', options.taskRunId);
    }
    if (options.agentRunId) {
      query = query.where('agent_run_id', '=', options.agentRunId);
    }
    if (options.modelPolicyId) {
      query = query.where('model_policy_id', '=', options.modelPolicyId);
    }
    if (options.modelId) {
      query = query.where('model_id', '=', options.modelId);
    }
    if (options.provider) {
      query = query.where('provider', '=', options.provider);
    }
    if (options.status) {
      query = query.where('status', '=', options.status);
    }
    if (options.startTime) {
      query = query.where('created_at', '>=', new Date(options.startTime));
    }
    if (options.endTime) {
      query = query.where('created_at', '<=', new Date(options.endTime));
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapModelCallRecord);
  }
}

export class ModelCallAttemptRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async startAttempt(input: ModelCallAttemptStartInput): Promise<ModelCallAttempt> {
    const parsed = modelCallAttemptSchema.parse({
      attempt_id: input.attempt_id ?? `model_attempt_${randomUUID()}`,
      model_call_id: input.model_call_id,
      global_attempt_index: input.global_attempt_index,
      target_attempt_index: input.target_attempt_index,
      fallback_index: input.fallback_index,
      attempt_index: input.global_attempt_index,
      target_id: input.target_id,
      provider: input.provider,
      model_id: input.model_id,
      status: 'started',
      started_at: new Date().toISOString(),
    });
    const row: Insertable<ModelCallAttemptTable> = {
      attempt_id: parsed.attempt_id,
      model_call_id: parsed.model_call_id,
      global_attempt_index: parsed.global_attempt_index,
      target_attempt_index: parsed.target_attempt_index,
      fallback_index: parsed.fallback_index,
      attempt_index: parsed.global_attempt_index,
      target_id: parsed.target_id,
      provider: parsed.provider ?? null,
      model_id: parsed.model_id,
      status: parsed.status,
      http_status: null,
      error_class: null,
      error_code: null,
      latency_ms: null,
      response_id: null,
      started_at: parsed.started_at ?? new Date(),
      completed_at: null,
    };
    const saved = await this.db
      .insertInto('model_call_attempt')
      .values(row)
      .onConflict((oc) => oc.columns(['model_call_id', 'global_attempt_index']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (saved) {
      return mapModelCallAttempt(saved);
    }
    const existing = (await this.listByModelCall(input.model_call_id)).find(
      (attempt) => attempt.global_attempt_index === input.global_attempt_index,
    );
    if (!existing) {
      throw new Error(
        `ModelCallAttempt insert conflict but existing attempt was not found: ${input.model_call_id}#${input.global_attempt_index}`,
      );
    }
    return existing;
  }

  async completeAttempt(
    attemptId: string,
    input: ModelCallAttemptCompleteInput,
  ): Promise<ModelCallAttempt> {
    const row = await this.db
      .updateTable('model_call_attempt')
      .set({
        status: input.status,
        http_status: input.http_status ?? null,
        error_class: input.error_class ?? null,
        error_code: input.error_code ?? null,
        latency_ms: input.latency_ms ?? null,
        response_id: input.response_id ?? null,
        completed_at: new Date(),
      })
      .where('attempt_id', '=', attemptId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapModelCallAttempt(row);
  }

  async listByModelCall(modelCallId: string): Promise<ModelCallAttempt[]> {
    const rows = await this.db
      .selectFrom('model_call_attempt')
      .selectAll()
      .where('model_call_id', '=', modelCallId)
      .orderBy('global_attempt_index', 'asc')
      .execute();
    return rows.map(mapModelCallAttempt);
  }
}

export class TenantRuntimePolicyRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async list(options: TenantPolicyListOptions = {}): Promise<TenantRuntimePolicy[]> {
    let query = this.db.selectFrom('tenant_runtime_policy').selectAll();
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.status) {
      query = query.where('status', '=', options.status);
    }
    const rows = await query
      .orderBy('tenant_id', 'asc')
      .orderBy('version', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapTenantRuntimePolicy);
  }

  async getByTenantAndVersion(
    tenantId: string,
    version: number,
  ): Promise<TenantRuntimePolicy | undefined> {
    const row = await this.db
      .selectFrom('tenant_runtime_policy')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('version', '=', version)
      .executeTakeFirst();
    return row ? mapTenantRuntimePolicy(row) : undefined;
  }

  async getLatestPublished(tenantId: string): Promise<TenantRuntimePolicy | undefined> {
    const row = await this.db
      .selectFrom('tenant_runtime_policy')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'published')
      .orderBy('version', 'desc')
      .executeTakeFirst();
    return row ? mapTenantRuntimePolicy(row) : undefined;
  }

  async listVersions(tenantId: string): Promise<TenantRuntimePolicy[]> {
    return this.list({ tenantId, limit: 100 });
  }

  async createDraft(
    policy: TenantRuntimePolicy,
    options: TenantPolicyWriteOptions,
  ): Promise<TenantRuntimePolicy> {
    const tenantId = options.tenantId ?? policy.tenant_id;
    const parsed = tenantRuntimePolicySchema.parse({
      ...policy,
      tenant_id: tenantId,
      status: 'draft',
      revision: 1,
      created_by: options.operatorId,
      updated_by: options.operatorId,
    });
    const row: Insertable<TenantRuntimePolicyTable> = {
      tenant_id: parsed.tenant_id,
      version: parsed.version,
      status: parsed.status,
      allowed_tools_json: toDbJson(parsed.allowed_tools),
      denied_tools_json: toDbJson(parsed.denied_tools),
      allowed_models_json: toDbJson(parsed.allowed_models),
      denied_models_json: toDbJson(parsed.denied_models),
      allowed_handoffs_json: toDbJson(parsed.allowed_handoffs),
      denied_handoffs_json: toDbJson(parsed.denied_handoffs),
      budget_cap_json: toDbJson(parsed.budget_cap),
      max_concurrent_agent_runs: parsed.max_concurrent_agent_runs,
      revision: 1,
      created_by: parsed.created_by ?? null,
      updated_by: parsed.updated_by ?? null,
      published_by: null,
      published_at: null,
      updated_at: new Date(),
    };
    const saved = await this.db
      .insertInto('tenant_runtime_policy')
      .values(row)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapTenantRuntimePolicy(saved);
  }

  async updateDraft(
    tenantId: string,
    version: number,
    input: TenantPolicyUpdateDraftInput,
  ): Promise<TenantRuntimePolicy> {
    const existing = await this.getByTenantAndVersion(tenantId, version);
    if (!existing) {
      throw new Error(`TenantRuntimePolicy not found: ${tenantId}@${version}`);
    }
    if (existing.status !== 'draft' && existing.status !== 'validated') {
      throw new Error(`TenantRuntimePolicy cannot be modified in status ${existing.status}`);
    }
    if (existing.revision !== input.expectedRevision) {
      throw new Error('TENANT_RUNTIME_POLICY_OPTIMISTIC_LOCK_CONFLICT');
    }
    const updated = tenantRuntimePolicySchema.parse({
      ...existing,
      ...input.policy,
      tenant_id: tenantId,
      version,
      status: 'draft',
      revision: existing.revision + 1,
      updated_by: input.operatorId,
      updated_at: new Date().toISOString(),
    });
    const row = await this.db
      .updateTable('tenant_runtime_policy')
      .set({
        status: updated.status,
        allowed_tools_json: toDbJson(updated.allowed_tools),
        denied_tools_json: toDbJson(updated.denied_tools),
        allowed_models_json: toDbJson(updated.allowed_models),
        denied_models_json: toDbJson(updated.denied_models),
        allowed_handoffs_json: toDbJson(updated.allowed_handoffs),
        denied_handoffs_json: toDbJson(updated.denied_handoffs),
        budget_cap_json: toDbJson(updated.budget_cap),
        max_concurrent_agent_runs: updated.max_concurrent_agent_runs,
        revision: updated.revision,
        updated_by: input.operatorId,
        updated_at: new Date(),
      })
      .where('tenant_id', '=', tenantId)
      .where('version', '=', version)
      .where('revision', '=', input.expectedRevision)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new Error('TENANT_RUNTIME_POLICY_OPTIMISTIC_LOCK_CONFLICT');
    }
    return mapTenantRuntimePolicy(row);
  }

  async cloneVersion(
    tenantId: string,
    version: number,
    options: TenantPolicyWriteOptions,
  ): Promise<TenantRuntimePolicy> {
    const source = await this.getByTenantAndVersion(tenantId, version);
    if (!source) {
      throw new Error(`TenantRuntimePolicy not found: ${tenantId}@${version}`);
    }
    const versions = await this.listVersions(tenantId);
    const nextVersion =
      options.version ?? Math.max(0, ...versions.map((entry) => entry.version)) + 1;
    return this.createDraft(
      {
        ...source,
        version: nextVersion,
        status: 'draft',
        revision: 1,
        created_by: options.operatorId,
        updated_by: options.operatorId,
        published_by: undefined,
        created_at: undefined,
        updated_at: undefined,
        published_at: undefined,
      },
      { tenantId, operatorId: options.operatorId },
    );
  }

  async markValidated(
    tenantId: string,
    version: number,
    options: TenantPolicyWriteOptions,
  ): Promise<TenantRuntimePolicy> {
    return this.updateStatus(tenantId, version, 'validated', options);
  }

  async publish(
    tenantId: string,
    version: number,
    options: TenantPolicyReleaseOptions,
  ): Promise<TenantRuntimePolicy> {
    return withPolicyTransaction(this.db, async (trx) => {
      await trx
        .updateTable('tenant_runtime_policy')
        .set({ status: 'deprecated', updated_at: new Date(), updated_by: options.operatorId })
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'published')
        .where('version', '!=', version)
        .execute();
      const row = await trx
        .updateTable('tenant_runtime_policy')
        .set({
          status: 'published',
          published_by: options.operatorId,
          published_at: new Date(),
          updated_by: options.operatorId,
          updated_at: new Date(),
          revision: sql<number>`revision + 1`,
        })
        .where('tenant_id', '=', tenantId)
        .where('version', '=', version)
        .where('status', 'in', ['draft', 'validated'])
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw new Error(`TenantRuntimePolicy cannot be published: ${tenantId}@${version}`);
      }
      const policy = mapTenantRuntimePolicy(row);
      await appendTenantPolicyRelease(trx, policy, 'publish', options);
      await appendTenantPolicyAudit(
        trx,
        policy,
        'policy.publish',
        'succeeded',
        options.operatorId,
        options.releaseNote,
      );
      return policy;
    });
  }

  async deprecate(
    tenantId: string,
    version: number,
    options: TenantPolicyReleaseOptions,
  ): Promise<TenantRuntimePolicy> {
    const policy = await this.updateStatus(tenantId, version, 'deprecated', options);
    await appendTenantPolicyRelease(this.db, policy, 'deprecate', options);
    await new AuditEventRepository(this.db).append({
      event_key: `policy.deprecated:${tenantId}:${version}`,
      tenant_id: tenantId,
      actor_id: options.operatorId,
      action: 'policy.deprecated',
      target_type: 'tenant_runtime_policy',
      target_id: `${tenantId}@${version}`,
      result: 'succeeded',
      reason: options.releaseNote,
      payload: { tenant_id: tenantId, version },
    });
    return policy;
  }

  async disable(
    tenantId: string,
    version: number,
    options: TenantPolicyReleaseOptions,
  ): Promise<TenantRuntimePolicy> {
    const policy = await this.updateStatus(tenantId, version, 'disabled', options);
    await appendTenantPolicyRelease(this.db, policy, 'disable', options);
    await new AuditEventRepository(this.db).append({
      event_key: `policy.disabled:${tenantId}:${version}`,
      tenant_id: tenantId,
      actor_id: options.operatorId,
      action: 'policy.disabled',
      target_type: 'tenant_runtime_policy',
      target_id: `${tenantId}@${version}`,
      result: 'succeeded',
      reason: options.releaseNote,
      payload: { tenant_id: tenantId, version },
    });
    return policy;
  }

  async rollback(
    tenantId: string,
    options: TenantPolicyRollbackOptions,
  ): Promise<TenantRuntimePolicy> {
    return withPolicyTransaction(this.db, async (trx) => {
      const previous = await new TenantRuntimePolicyRepository(trx).getLatestPublished(tenantId);
      await trx
        .updateTable('tenant_runtime_policy')
        .set({ status: 'deprecated', updated_at: new Date(), updated_by: options.operatorId })
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'published')
        .where('version', '!=', options.targetVersion)
        .execute();
      const row = await trx
        .updateTable('tenant_runtime_policy')
        .set({
          status: 'published',
          published_by: options.operatorId,
          published_at: new Date(),
          updated_by: options.operatorId,
          updated_at: new Date(),
          revision: sql<number>`revision + 1`,
        })
        .where('tenant_id', '=', tenantId)
        .where('version', '=', options.targetVersion)
        .where('status', 'in', ['validated', 'deprecated', 'disabled'])
        .returningAll()
        .executeTakeFirst();
      if (!row) {
        throw new Error(
          `TenantRuntimePolicy rollback target not found: ${tenantId}@${options.targetVersion}`,
        );
      }
      const policy = mapTenantRuntimePolicy(row);
      await appendTenantPolicyRelease(trx, policy, 'rollback', options, previous?.version);
      await appendTenantPolicyAudit(
        trx,
        policy,
        'policy.rollback',
        'succeeded',
        options.operatorId,
        options.releaseNote,
      );
      return policy;
    });
  }

  async listReleaseHistory(tenantId: string): Promise<CapabilityRelease[]> {
    return new CapabilityReleaseRepository(this.db).list({
      tenantId,
      resourceType: 'tenant_runtime_policy',
      resourceId: tenantId,
      limit: 100,
    });
  }

  private async updateStatus(
    tenantId: string,
    version: number,
    status: TenantRuntimePolicy['status'],
    options: TenantPolicyWriteOptions,
  ): Promise<TenantRuntimePolicy> {
    tenantRuntimePolicyStatusSchema.parse(status);
    const row = await this.db
      .updateTable('tenant_runtime_policy')
      .set({
        status,
        updated_by: options.operatorId,
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('tenant_id', '=', tenantId)
      .where('version', '=', version)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      throw new Error(`TenantRuntimePolicy not found: ${tenantId}@${version}`);
    }
    return mapTenantRuntimePolicy(row);
  }
}

export class TenantRuntimePolicySnapshotRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createImmutableSnapshot(
    input: CreateTenantPolicySnapshotInput,
  ): Promise<TenantRuntimePolicySnapshot> {
    const createdAt = new Date().toISOString();
    const snapshotId = `tenant_policy_snapshot_${randomUUID()}`;
    const snapshotRef = buildTenantPolicySnapshotRef(snapshotId);
    const derivationType = input.derivationType ?? 'root';
    const lineageDepth = input.lineageDepth ?? 0;
    const rootSnapshotRef = input.rootSnapshotRef ?? snapshotRef;
    const parentSnapshotRef = input.parentSnapshotRef;
    if (derivationType === 'root') {
      if (parentSnapshotRef || lineageDepth !== 0 || rootSnapshotRef !== snapshotRef) {
        throw new Error(
          'Root TenantRuntimePolicySnapshot must not have a parent and must point root_snapshot_ref to itself',
        );
      }
    } else if (!parentSnapshotRef || lineageDepth <= 0 || rootSnapshotRef === snapshotRef) {
      throw new Error('Child TenantRuntimePolicySnapshot requires parent/root lineage');
    }
    const snapshotContent = {
      tenant_id: input.tenantId,
      root_snapshot_ref: rootSnapshotRef,
      parent_snapshot_ref: parentSnapshotRef ?? null,
      derivation_type: derivationType,
      lineage_depth: lineageDepth,
      source_policy_version: input.policy.version,
      source_policy_hash: input.policyHash,
      execution_plan_ref: input.executionPlanRef,
      execution_plan_hash: input.executionPlanHash,
      execution_plan_type: input.executionPlanType,
      resolved_allowed_tools: input.resolvedPolicy.resolved_allowed_tools,
      resolved_denied_tools: input.resolvedPolicy.resolved_denied_tools,
      resolved_allowed_models: input.resolvedPolicy.resolved_allowed_models,
      resolved_allowed_handoffs: input.resolvedPolicy.resolved_allowed_handoffs,
      resolved_budget: input.resolvedPolicy.resolved_budget,
      max_concurrent_agent_runs: input.resolvedPolicy.max_concurrent_agent_runs,
    };
    const snapshotWithoutHash = {
      snapshot_id: snapshotId,
      snapshot_ref: snapshotRef,
      tenant_id: input.tenantId,
      root_snapshot_ref: rootSnapshotRef,
      ...(parentSnapshotRef ? { parent_snapshot_ref: parentSnapshotRef } : {}),
      derivation_type: derivationType,
      lineage_depth: lineageDepth,
      source_policy_version: input.policy.version,
      source_policy_hash: input.policyHash,
      execution_plan_ref: input.executionPlanRef,
      execution_plan_hash: input.executionPlanHash,
      execution_plan_type: input.executionPlanType,
      resolved_allowed_tools: input.resolvedPolicy.resolved_allowed_tools,
      resolved_denied_tools: input.resolvedPolicy.resolved_denied_tools,
      resolved_allowed_models: input.resolvedPolicy.resolved_allowed_models,
      resolved_allowed_handoffs: input.resolvedPolicy.resolved_allowed_handoffs,
      resolved_budget: input.resolvedPolicy.resolved_budget,
      max_concurrent_agent_runs: input.resolvedPolicy.max_concurrent_agent_runs,
      created_at: createdAt,
    };
    const snapshotHash = hashJson(snapshotContent);
    const parsed = tenantRuntimePolicySnapshotSchema.parse({
      ...snapshotWithoutHash,
      snapshot_hash: snapshotHash,
    });
    const row: Insertable<TenantRuntimePolicySnapshotTable> = {
      snapshot_id: parsed.snapshot_id,
      snapshot_ref: parsed.snapshot_ref,
      tenant_id: parsed.tenant_id,
      root_snapshot_ref: parsed.root_snapshot_ref,
      parent_snapshot_ref: parsed.parent_snapshot_ref ?? null,
      derivation_type: parsed.derivation_type,
      lineage_depth: parsed.lineage_depth,
      source_policy_version: parsed.source_policy_version,
      source_policy_hash: parsed.source_policy_hash,
      execution_plan_ref: parsed.execution_plan_ref,
      execution_plan_hash: parsed.execution_plan_hash,
      execution_plan_type: parsed.execution_plan_type,
      policy_json: toDbJson(input.policy),
      resolved_policy_json: toDbJson(parsed),
      snapshot_hash: parsed.snapshot_hash,
      created_at: parsed.created_at,
    };
    const saved = await this.db
      .insertInto('tenant_runtime_policy_snapshot')
      .values(row)
      .onConflict((oc) => oc.columns(['tenant_id', 'snapshot_hash']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (saved) {
      return mapTenantRuntimePolicySnapshot(saved);
    }
    const existing = await this.getByHash(parsed.snapshot_hash, { tenantId: parsed.tenant_id });
    if (!existing) {
      throw new Error(
        `TenantRuntimePolicySnapshot insert conflict but existing snapshot was not found: ${parsed.snapshot_hash}`,
      );
    }
    return existing;
  }

  async getByRef(
    snapshotRef: string,
    options: RepositoryTenantOptions = {},
  ): Promise<TenantRuntimePolicySnapshot | undefined> {
    let query = this.db
      .selectFrom('tenant_runtime_policy_snapshot')
      .selectAll()
      .where('snapshot_ref', '=', snapshotRef);
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    const row = await query.executeTakeFirst();
    return row ? mapTenantRuntimePolicySnapshot(row) : undefined;
  }

  async getByHash(
    snapshotHash: string,
    options: RepositoryTenantOptions = {},
  ): Promise<TenantRuntimePolicySnapshot | undefined> {
    let query = this.db
      .selectFrom('tenant_runtime_policy_snapshot')
      .selectAll()
      .where('snapshot_hash', '=', snapshotHash);
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    const row = await query.executeTakeFirst();
    return row ? mapTenantRuntimePolicySnapshot(row) : undefined;
  }

  async verifyHash(
    snapshotRef: string,
    expectedHash: string,
    options: RepositoryTenantOptions = {},
  ): Promise<boolean> {
    const snapshot = await this.getByRef(snapshotRef, options);
    return Boolean(snapshot && snapshot.snapshot_hash === expectedHash);
  }

  async listByTenant(
    tenantId: string,
    options: TenantPolicySnapshotListOptions = {},
  ): Promise<TenantRuntimePolicySnapshot[]> {
    let query = this.db
      .selectFrom('tenant_runtime_policy_snapshot')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (options.executionPlanRef) {
      query = query.where('execution_plan_ref', '=', options.executionPlanRef);
    }
    if (options.sourcePolicyVersion) {
      query = query.where('source_policy_version', '=', options.sourcePolicyVersion);
    }
    if (options.derivationType) {
      query = query.where('derivation_type', '=', options.derivationType);
    }
    if (options.rootSnapshotRef) {
      query = query.where('root_snapshot_ref', '=', options.rootSnapshotRef);
    }
    if (options.parentSnapshotRef) {
      query = query.where('parent_snapshot_ref', '=', options.parentSnapshotRef);
    }
    if (options.createdFrom) {
      query = query.where('created_at', '>=', new Date(options.createdFrom));
    }
    if (options.createdTo) {
      query = query.where('created_at', '<=', new Date(options.createdTo));
    }
    if (options.status) {
      query = query
        .innerJoin('tenant_runtime_policy', (join) =>
          join
            .onRef(
              'tenant_runtime_policy.tenant_id',
              '=',
              'tenant_runtime_policy_snapshot.tenant_id',
            )
            .onRef(
              'tenant_runtime_policy.version',
              '=',
              'tenant_runtime_policy_snapshot.source_policy_version',
            ),
        )
        .where('tenant_runtime_policy.status', '=', options.status);
    }
    const rows = await query
      .orderBy('created_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapTenantRuntimePolicySnapshot);
  }

  async listByExecutionPlan(
    executionPlanRef: string,
    options: RepositoryTenantOptions = {},
  ): Promise<TenantRuntimePolicySnapshot[]> {
    let query = this.db
      .selectFrom('tenant_runtime_policy_snapshot')
      .selectAll()
      .where('execution_plan_ref', '=', executionPlanRef);
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    const rows = await query.orderBy('created_at', 'desc').execute();
    return rows.map(mapTenantRuntimePolicySnapshot);
  }
}

export class TenantAgentAdmissionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async reserve(
    input: TenantAdmissionReserveInput,
  ): Promise<{ accepted: boolean; admission?: TenantAgentAdmission; activeCount: number }> {
    return withPolicyTransaction(this.db, async (trx) => {
      await acquireTenantAdmissionLock(trx, input.tenantId);
      const existing = await this.scoped(trx).getByTaskRun(input.taskRunId, {
        tenantId: input.tenantId,
      });
      if (existing) {
        if (existing.policy_snapshot_ref !== input.policySnapshotRef) {
          throw new Error('TENANT_AGENT_ADMISSION_SNAPSHOT_CONFLICT');
        }
        if (existing.status === 'reserved' || existing.status === 'active') {
          return {
            accepted: true,
            admission: existing,
            activeCount: await activeAdmissionCount(trx, input.tenantId),
          };
        }
        if (existing.status === 'rejected') {
          return {
            accepted: false,
            admission: existing,
            activeCount: await activeAdmissionCount(trx, input.tenantId),
          };
        }
      }
      const activeCount = await activeAdmissionCount(trx, input.tenantId);
      if (activeCount >= input.maxConcurrentAgentRuns) {
        const rejected = await insertAdmission(trx, {
          tenantId: input.tenantId,
          taskRunId: input.taskRunId,
          policySnapshotRef: input.policySnapshotRef,
          status: 'rejected',
          releaseReason: 'TENANT_AGENT_CONCURRENCY_EXCEEDED',
        });
        return { accepted: false, admission: rejected, activeCount };
      }
      const admission = await insertAdmission(trx, {
        tenantId: input.tenantId,
        taskRunId: input.taskRunId,
        policySnapshotRef: input.policySnapshotRef,
        status: 'reserved',
      });
      return { accepted: true, admission, activeCount };
    });
  }

  async activate(
    admissionId: string,
    input: { workflowId?: string; workflowRunId?: string } = {},
  ): Promise<TenantAgentAdmission | undefined> {
    const row = await this.db
      .updateTable('tenant_agent_admission')
      .set({
        status: 'active',
        workflow_id: input.workflowId ?? null,
        workflow_run_id: input.workflowRunId ?? null,
        activated_at: new Date(),
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('admission_id', '=', admissionId)
      .where('status', '=', 'reserved')
      .returningAll()
      .executeTakeFirst();
    return row ? mapTenantAgentAdmission(row) : this.get(admissionId);
  }

  async attachAgentRun(
    admissionId: string,
    agentRunId: string,
  ): Promise<TenantAgentAdmission | undefined> {
    const row = await this.db
      .updateTable('tenant_agent_admission')
      .set({
        agent_run_id: agentRunId,
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('admission_id', '=', admissionId)
      .returningAll()
      .executeTakeFirst();
    return row ? mapTenantAgentAdmission(row) : undefined;
  }

  async attachWorkflow(
    admissionId: string,
    workflowId: string,
    workflowRunId?: string,
  ): Promise<TenantAgentAdmission | undefined> {
    const row = await this.db
      .updateTable('tenant_agent_admission')
      .set({
        workflow_id: workflowId,
        workflow_run_id: workflowRunId ?? null,
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('admission_id', '=', admissionId)
      .returningAll()
      .executeTakeFirst();
    return row ? mapTenantAgentAdmission(row) : undefined;
  }

  async release(
    admissionId: string,
    reason = 'released',
  ): Promise<TenantAgentAdmission | undefined> {
    const existing = await this.get(admissionId);
    if (!existing) {
      return undefined;
    }
    if (existing.status === 'released' || existing.status === 'reconciled') {
      return existing;
    }
    const row = await this.db
      .updateTable('tenant_agent_admission')
      .set({
        status: 'released',
        release_reason: reason,
        released_at: new Date(),
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('admission_id', '=', admissionId)
      .where('status', 'in', ['reserved', 'active', 'orphaned'])
      .returningAll()
      .executeTakeFirst();
    return row ? mapTenantAgentAdmission(row) : existing;
  }

  async reject(
    admissionId: string,
    reason = 'rejected',
  ): Promise<TenantAgentAdmission | undefined> {
    const row = await this.db
      .updateTable('tenant_agent_admission')
      .set({
        status: 'rejected',
        release_reason: reason,
        released_at: new Date(),
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('admission_id', '=', admissionId)
      .returningAll()
      .executeTakeFirst();
    return row ? mapTenantAgentAdmission(row) : undefined;
  }

  async getActiveCount(tenantId: string): Promise<number> {
    return activeAdmissionCount(this.db, tenantId);
  }

  async get(admissionId: string): Promise<TenantAgentAdmission | undefined> {
    const row = await this.db
      .selectFrom('tenant_agent_admission')
      .selectAll()
      .where('admission_id', '=', admissionId)
      .executeTakeFirst();
    return row ? mapTenantAgentAdmission(row) : undefined;
  }

  async getByTaskRun(
    taskRunId: string,
    options: RepositoryTenantOptions = {},
  ): Promise<TenantAgentAdmission | undefined> {
    let query = this.db
      .selectFrom('tenant_agent_admission')
      .selectAll()
      .where('task_run_id', '=', taskRunId);
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    const row = await query.executeTakeFirst();
    return row ? mapTenantAgentAdmission(row) : undefined;
  }

  async listByTenant(
    tenantId: string,
    options: TenantAdmissionListOptions = {},
  ): Promise<TenantAgentAdmission[]> {
    let query = this.db
      .selectFrom('tenant_agent_admission')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (options.status) {
      query = query.where('status', '=', options.status);
    }
    if (options.taskRunId) {
      query = query.where('task_run_id', '=', options.taskRunId);
    }
    if (options.agentRunId) {
      query = query.where('agent_run_id', '=', options.agentRunId);
    }
    if (options.workflowId) {
      query = query.where('workflow_id', '=', options.workflowId);
    }
    if (options.acquiredFrom) {
      query = query.where('acquired_at', '>=', new Date(options.acquiredFrom));
    }
    if (options.acquiredTo) {
      query = query.where('acquired_at', '<=', new Date(options.acquiredTo));
    }
    const rows = await query
      .orderBy('updated_at', 'desc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapTenantAgentAdmission);
  }

  async reconcileCandidates(
    options: TenantAdmissionListOptions = {},
  ): Promise<TenantAgentAdmission[]> {
    let query = this.db
      .selectFrom('tenant_agent_admission')
      .selectAll()
      .where('status', 'in', ['reserved', 'active']);
    if (options.tenantId) {
      query = query.where('tenant_id', '=', options.tenantId);
    }
    if (options.staleBefore) {
      query = query.where('updated_at', '<=', new Date(options.staleBefore));
    }
    const rows = await query
      .orderBy('updated_at', 'asc')
      .limit(limit(options.limit))
      .offset(offset(options.offset))
      .execute();
    return rows.map(mapTenantAgentAdmission);
  }

  async markReconciled(
    admissionId: string,
    reason = 'reconciled',
  ): Promise<TenantAgentAdmission | undefined> {
    const row = await this.db
      .updateTable('tenant_agent_admission')
      .set({
        status: 'reconciled',
        release_reason: reason,
        released_at: new Date(),
        updated_at: new Date(),
        revision: sql<number>`revision + 1`,
      })
      .where('admission_id', '=', admissionId)
      .where('status', 'in', ['reserved', 'active', 'orphaned'])
      .returningAll()
      .executeTakeFirst();
    return row ? mapTenantAgentAdmission(row) : undefined;
  }

  private scoped(db: Kysely<Database>): TenantAgentAdmissionRepository {
    return new TenantAgentAdmissionRepository(db);
  }
}

export class AgentSpecRepository {
  private readonly registry: VersionedRegistryRepository<AgentSpec>;

  constructor(private readonly db: Kysely<Database>) {
    this.registry = new VersionedRegistryRepository(db, {
      resourceType: 'agent',
      tableName: 'agent_spec',
      idColumn: 'spec_id',
      versionColumn: 'version',
      jsonColumn: 'spec_json',
      schema: agentSpecSchema,
      getSpecId: (spec) => spec.agent_id,
      getSpecVersion: (spec) => spec.version,
      withIdentity: (spec, resourceId, version, status) => ({
        ...spec,
        agent_id: resourceId,
        version,
        status,
      }),
    });
  }

  list(options: RegistryListOptions = {}): Promise<RegistryResourceRecord<AgentSpec>[]> {
    return this.registry.list(options);
  }

  getByIdAndVersion(
    agentId: string,
    version: number,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<AgentSpec> | undefined> {
    return this.registry.getByIdAndVersion(agentId, version, options);
  }

  getLatestVersion(
    agentId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<AgentSpec> | undefined> {
    return this.registry.getLatestVersion(agentId, options);
  }

  getLatestPublishedVersion(
    agentId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<AgentSpec> | undefined> {
    return this.registry.getLatestPublishedVersion(agentId, options);
  }

  listVersions(
    agentId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<AgentSpec>[]> {
    return this.registry.listVersions(agentId, options);
  }

  createDraft(
    agentSpec: AgentSpec,
    options: RegistryWriteOptions,
  ): Promise<RegistryResourceRecord<AgentSpec>> {
    return this.registry.createDraft(agentSpec, options);
  }

  updateDraft(
    agentId: string,
    version: number,
    input: RegistryUpdateDraftInput<AgentSpec>,
  ): Promise<RegistryResourceRecord<AgentSpec>> {
    return this.registry.updateDraft(agentId, version, input);
  }

  cloneVersion(
    agentId: string,
    version: number,
    options: RegistryCloneOptions,
  ): Promise<RegistryResourceRecord<AgentSpec>> {
    return this.registry.cloneVersion(agentId, version, options);
  }

  markValidated(
    agentId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<AgentSpec>> {
    return this.registry.markValidated(agentId, version, options);
  }

  publish(
    agentId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<AgentSpec>> {
    return this.registry.publish(agentId, version, options);
  }

  setGray(
    agentId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<AgentSpec>> {
    return this.registry.setGray(agentId, version, options);
  }

  deprecate(
    agentId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<AgentSpec>> {
    return this.registry.deprecate(agentId, version, options);
  }

  disable(
    agentId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<AgentSpec>> {
    return this.registry.disable(agentId, version, options);
  }

  rollback(
    agentId: string,
    targetVersion: number,
    options: RegistryRollbackOptions,
  ): Promise<RegistryResourceRecord<AgentSpec>> {
    return this.registry.rollback(agentId, targetVersion, options);
  }

  listReleaseHistory(
    agentId: string,
    options: RegistryListOptions = {},
  ): Promise<CapabilityRelease[]> {
    return this.registry.listReleaseHistory(agentId, options);
  }
}

export class PromptDefinitionRepository {
  private readonly registry: VersionedRegistryRepository<PromptDefinition>;

  constructor(private readonly db: Kysely<Database>) {
    this.registry = new VersionedRegistryRepository(db, {
      resourceType: 'prompt',
      tableName: 'prompt_definition',
      idColumn: 'spec_id',
      versionColumn: 'version',
      jsonColumn: 'spec_json',
      schema: promptDefinitionSchema,
      getSpecId: (spec) => spec.prompt_id,
      getSpecVersion: (spec) => spec.version,
      withIdentity: (spec, resourceId, version, status) => ({
        ...spec,
        prompt_id: resourceId,
        version,
        status,
      }),
    });
  }

  list(options: RegistryListOptions = {}): Promise<RegistryResourceRecord<PromptDefinition>[]> {
    return this.registry.list(options);
  }

  getByIdAndVersion(
    promptId: string,
    version: number,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<PromptDefinition> | undefined> {
    return this.registry.getByIdAndVersion(promptId, version, options);
  }

  getLatestVersion(
    promptId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<PromptDefinition> | undefined> {
    return this.registry.getLatestVersion(promptId, options);
  }

  getLatestPublishedVersion(
    promptId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<PromptDefinition> | undefined> {
    return this.registry.getLatestPublishedVersion(promptId, options);
  }

  listVersions(
    promptId: string,
    options: RegistryListOptions = {},
  ): Promise<RegistryResourceRecord<PromptDefinition>[]> {
    return this.registry.listVersions(promptId, options);
  }

  createDraft(
    prompt: PromptDefinition,
    options: RegistryWriteOptions,
  ): Promise<RegistryResourceRecord<PromptDefinition>> {
    return this.registry.createDraft(prompt, options);
  }

  updateDraft(
    promptId: string,
    version: number,
    input: RegistryUpdateDraftInput<PromptDefinition>,
  ): Promise<RegistryResourceRecord<PromptDefinition>> {
    return this.registry.updateDraft(promptId, version, input);
  }

  cloneVersion(
    promptId: string,
    version: number,
    options: RegistryCloneOptions,
  ): Promise<RegistryResourceRecord<PromptDefinition>> {
    return this.registry.cloneVersion(promptId, version, options);
  }

  markValidated(
    promptId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<PromptDefinition>> {
    return this.registry.markValidated(promptId, version, options);
  }

  publish(
    promptId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<PromptDefinition>> {
    return this.registry.publish(promptId, version, options);
  }

  setGray(
    promptId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<PromptDefinition>> {
    return this.registry.setGray(promptId, version, options);
  }

  deprecate(
    promptId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<PromptDefinition>> {
    return this.registry.deprecate(promptId, version, options);
  }

  disable(
    promptId: string,
    version: number,
    options: RegistryStatusOptions,
  ): Promise<RegistryResourceRecord<PromptDefinition>> {
    return this.registry.disable(promptId, version, options);
  }

  rollback(
    promptId: string,
    targetVersion: number,
    options: RegistryRollbackOptions,
  ): Promise<RegistryResourceRecord<PromptDefinition>> {
    return this.registry.rollback(promptId, targetVersion, options);
  }

  listReleaseHistory(
    promptId: string,
    options: RegistryListOptions = {},
  ): Promise<CapabilityRelease[]> {
    return this.registry.listReleaseHistory(promptId, options);
  }
}

export async function upsertAgentSpec(
  db: Kysely<Database>,
  agentSpec: AgentSpec,
  options: UpsertSpecOptions = {},
): Promise<AgentSpec> {
  const status = normalizeWriteStatus(options.status ?? agentSpec.status ?? 'published');
  const parsed = agentSpecSchema.parse({ ...agentSpec, status });
  const row: Insertable<AgentSpecTable> = {
    tenant_id: tenant(options),
    spec_id: parsed.agent_id,
    version: parsed.version,
    status,
    spec_json: parsed,
    sha256: parsed.sha256 ?? hashJson(parsed),
    created_by: options.createdBy ?? null,
    updated_by: options.createdBy ?? null,
    published_by: executableSpecStatuses.includes(status as ExecutableSpecStatus)
      ? (options.createdBy ?? null)
      : null,
    updated_at: new Date(),
    published_at: executableSpecStatuses.includes(status as ExecutableSpecStatus)
      ? new Date()
      : null,
    revision: 1,
    gray_policy_json: grayPolicySchema.parse({}),
  };
  const saved = await db
    .insertInto('agent_spec')
    .values(row)
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'spec_id', 'version']).doUpdateSet({
        status: row.status,
        spec_json: row.spec_json,
        sha256: row.sha256,
        created_by: row.created_by,
        updated_by: row.updated_by,
        published_by: row.published_by,
        updated_at: row.updated_at,
        published_at: row.published_at,
        gray_policy_json: row.gray_policy_json,
      }),
    )
    .returning(['spec_json'])
    .executeTakeFirstOrThrow();

  return agentSpecSchema.parse(saved.spec_json);
}

export async function upsertPromptDefinition(
  db: Kysely<Database>,
  prompt: PromptDefinition,
  options: UpsertSpecOptions = {},
): Promise<PromptDefinition> {
  const status = normalizeWriteStatus(options.status ?? prompt.status ?? 'published');
  const parsed = promptDefinitionSchema.parse({ ...prompt, status });
  const row: Insertable<PromptDefinitionTable> = {
    tenant_id: tenant(options),
    spec_id: parsed.prompt_id,
    version: parsed.version,
    status,
    spec_json: parsed,
    sha256: parsed.sha256 ?? hashJson(parsed),
    created_by: options.createdBy ?? null,
    updated_by: options.createdBy ?? null,
    published_by: executableSpecStatuses.includes(status as ExecutableSpecStatus)
      ? (options.createdBy ?? null)
      : null,
    updated_at: new Date(),
    published_at: executableSpecStatuses.includes(status as ExecutableSpecStatus)
      ? new Date()
      : null,
    revision: 1,
    gray_policy_json: grayPolicySchema.parse({}),
  };
  const saved = await db
    .insertInto('prompt_definition')
    .values(row)
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'spec_id', 'version']).doUpdateSet({
        status: row.status,
        spec_json: row.spec_json,
        sha256: row.sha256,
        created_by: row.created_by,
        updated_by: row.updated_by,
        published_by: row.published_by,
        updated_at: row.updated_at,
        published_at: row.published_at,
        gray_policy_json: row.gray_policy_json,
      }),
    )
    .returning(['spec_json'])
    .executeTakeFirstOrThrow();

  return promptDefinitionSchema.parse(saved.spec_json);
}

function tenant(options: RepositoryTenantOptions): string {
  return options.tenantId ?? 'default';
}

function isDependencyPublishable(status: SpecStatus): boolean {
  return status === 'published' || status === 'gray';
}

function parseVersionRef(ref: string): VersionRef | undefined {
  const match = /^(.+)@([1-9]\d*)$/u.exec(ref);
  if (!match) {
    return undefined;
  }
  return { id: match[1] ?? '', version: Number(match[2]) };
}

function parseToolVersionRef(ref: string): ToolVersionRef | undefined {
  const match = /^(.+)@([^@]+)$/u.exec(ref);
  if (!match) {
    return undefined;
  }
  return { name: match[1] ?? '', version: match[2] ?? '' };
}

function flowAllowedToolOverrides(
  flowSpec: FlowSpec,
  stepId: string,
  agentId: string,
): string[] | undefined {
  const fromMetadata = flowSpec.metadata?.allowed_tools;
  if (isRecord(fromMetadata)) {
    const byStep = fromMetadata[stepId];
    if (Array.isArray(byStep)) {
      return byStep.map(String);
    }
    const byAgent = fromMetadata[agentId];
    if (Array.isArray(byAgent)) {
      return byAgent.map(String);
    }
  }
  if (Array.isArray(fromMetadata)) {
    return fromMetadata.map(String);
  }
  return undefined;
}

function resolveAllowedToolRefs(
  agentAllowedTools: string[],
  flowOverride: string[] | undefined,
  tenantAllowedTools: readonly string[] | undefined,
): ToolVersionRef[] {
  const agentRefs = parseToolVersionRefs(agentAllowedTools, 'AgentSpec.allowed_tools');
  const overrideRefs = flowOverride
    ? parseToolVersionRefs(flowOverride, 'FlowSpec allowed_tools override')
    : agentRefs;
  const tenantNames = tenantAllowedTools ? new Set(tenantAllowedTools) : undefined;
  const agentKeys = new Set(agentRefs.map((ref) => buildToolVersionRef(ref.name, ref.version)));
  const selected: ToolVersionRef[] = [];
  for (const ref of overrideRefs) {
    const key = buildToolVersionRef(ref.name, ref.version);
    if (!agentKeys.has(key)) {
      throw new Error(`Flow allowed_tools override is not permitted by AgentSpec: ${key}`);
    }
    if (tenantNames && !tenantNames.has(ref.name) && !tenantNames.has(key)) {
      continue;
    }
    selected.push(ref);
  }
  return selected;
}

function parseToolVersionRefs(values: string[], label: string): ToolVersionRef[] {
  return values.map((value) => {
    const parsed = parseToolVersionRef(value);
    if (!parsed?.name || !parsed.version) {
      throw new Error(`${label} must use tool_name@tool_version exact refs: ${value}`);
    }
    return parsed;
  });
}

async function resolveAgentModelPolicy(
  db: Kysely<Database>,
  agentSpec: AgentSpec,
  options: RepositoryTenantOptions,
): Promise<ResolvedModelPolicy> {
  const ref = agentSpec.model_policy_ref;
  if (!ref) {
    throw new Error(
      `AgentSpec must declare model_policy_ref exact lock: ${agentSpec.agent_id}@${agentSpec.version}`,
    );
  }
  const record = await new ModelPolicyRepository(db).getByIdAndVersion(
    ref.model_policy_id,
    ref.model_policy_version,
    options,
  );
  if (!record) {
    throw new Error(
      `ModelPolicy exact version not found: ${ref.model_policy_id}@${ref.model_policy_version}`,
    );
  }
  if (!isDependencyPublishable(record.status)) {
    throw new Error(
      `ModelPolicy is not executable for plan generation: ${ref.model_policy_id}@${ref.model_policy_version}`,
    );
  }
  const modelPolicyHash = hashModelPolicy(record);
  if (ref.model_policy_hash && ref.model_policy_hash !== modelPolicyHash) {
    throw new Error(
      `ModelPolicy hash mismatch: ${ref.model_policy_id}@${ref.model_policy_version}`,
    );
  }
  const resolvedTargets = record.targets
    .filter((target) => target.enabled)
    .sort(compareModelTargets);
  if (resolvedTargets.length === 0) {
    throw new Error(
      `ModelPolicy has no enabled targets: ${ref.model_policy_id}@${ref.model_policy_version}`,
    );
  }
  return resolvedModelPolicySchema.parse({
    model_policy_id: record.model_policy_id,
    model_policy_version: record.version,
    model_policy_hash: modelPolicyHash,
    protocol: record.protocol,
    resolved_targets: resolvedTargets,
    retry_policy: record.retry_policy,
    fallback_policy: record.fallback_policy,
    request_policy: record.request_policy,
  });
}

function compareModelTargets(
  left: Pick<ModelTarget, 'priority' | 'target_id'>,
  right: Pick<ModelTarget, 'priority' | 'target_id'>,
): number {
  return left.priority === right.priority
    ? left.target_id.localeCompare(right.target_id)
    : left.priority - right.priority;
}

export function hashModelPolicy(policy: ModelPolicy): string {
  return hashJson({
    model_policy_id: policy.model_policy_id,
    version: policy.version,
    protocol: policy.protocol,
    targets: policy.targets,
    retry_policy: policy.retry_policy,
    fallback_policy: policy.fallback_policy,
    request_policy: policy.request_policy,
  });
}

async function resolveToolPlanEntry(
  db: Kysely<Database>,
  input: ToolPlanEntryInput,
): Promise<FlowExecutionPlanTool> {
  const repository = new ToolManifestRepository(db);
  const numericVersion = manifestVersionToRegistryVersion(input.toolVersion);
  const toolRecord = await repository.getByIdAndVersion(input.toolName, numericVersion, {
    tenantId: input.tenantId,
  });
  if (!toolRecord) {
    throw new Error(`ToolManifest exact version not found: ${input.toolName}@${input.toolVersion}`);
  }
  if (toolRecord.spec.version !== input.toolVersion) {
    throw new Error(
      `ToolManifest version mismatch: requested ${input.toolName}@${input.toolVersion}, got ${toolRecord.spec.version}`,
    );
  }
  if (!isDependencyPublishable(toolRecord.status)) {
    throw new Error(
      `ToolManifest is not executable for plan generation: ${input.toolName}@${input.toolVersion}`,
    );
  }

  return {
    ...(input.stepId ? { step_id: input.stepId } : {}),
    tool_name: toolRecord.spec.tool_name,
    tool_version: toolRecord.spec.version,
    tool_sha256: toolRecord.sha256,
    risk_level: toolRecord.spec.risk_level,
  };
}

function manifestVersionToRegistryVersion(toolVersion: string): number {
  const [major] = toolVersion.split('.');
  const parsed = Number(major);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `ToolManifest version must start with a positive numeric major: ${toolVersion}`,
    );
  }
  return parsed;
}

function addToolEntry(
  entries: Map<string, FlowExecutionPlanTool>,
  tool: FlowExecutionPlanTool,
): void {
  const key = buildToolVersionRef(tool.tool_name, tool.tool_version);
  const existing = entries.get(key);
  if (existing && existing.tool_sha256 !== tool.tool_sha256) {
    throw new Error(`ToolManifest hash conflict in execution plan: ${key}`);
  }
  entries.set(key, existing ? { ...existing, step_id: existing.step_id ?? tool.step_id } : tool);
}

function comparePlanTools(left: FlowExecutionPlanTool, right: FlowExecutionPlanTool): number {
  const byName = left.tool_name.localeCompare(right.tool_name);
  return byName === 0 ? left.tool_version.localeCompare(right.tool_version) : byName;
}

function numberFromUnknown(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function manifestSpecVersion(manifest: ToolManifest): number {
  const [major] = manifest.version.split('.');
  const parsed = Number(major);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function parseAgentOutputSchema(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  if (/^[A-Za-z0-9_.:-]+$/u.test(value)) {
    return { $ref: value };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('AgentSpec output_schema must be a schema ref or JSON object string');
  }
  if (!isRecord(parsed)) {
    throw new Error('AgentSpec output_schema must be a JSON object string');
  }
  return parsed;
}

function toDbJson(value: unknown): string {
  return JSON.stringify(value);
}

function fromDbJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = fromDbJson(value);
  return isRecord(parsed) ? parsed : undefined;
}

function jsonArray(value: unknown): unknown[] {
  const parsed = fromDbJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeWriteStatus(status: SpecStatus | undefined): SpecStatus {
  return status ?? 'published';
}

function limit(value: number | undefined): number {
  return Math.min(Math.max(value ?? 20, 1), 100);
}

function offset(value: number | undefined): number {
  return Math.max(value ?? 0, 0);
}

function mapTaskRun(row: Selectable<TaskRunTable>): TaskRun {
  const taskRun: TaskRun = {
    task_run_id: row.task_run_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    route_type: row.route_type as TaskRun['route_type'],
    status: row.status as TaskRun['status'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };

  if (row.flow_id) {
    taskRun.flow_id = row.flow_id;
  }
  if (row.flow_version) {
    taskRun.flow_version = row.flow_version;
  }
  if (row.workflow_id) {
    taskRun.workflow_id = row.workflow_id;
  }
  if (row.execution_plan_ref) {
    taskRun.execution_plan_ref = row.execution_plan_ref;
  }
  if (row.tenant_policy_snapshot_ref) {
    taskRun.tenant_policy_snapshot_ref = row.tenant_policy_snapshot_ref;
  }
  if (row.tenant_policy_hash) {
    taskRun.tenant_policy_hash = row.tenant_policy_hash;
  }
  if (row.tenant_admission_id) {
    taskRun.tenant_admission_id = row.tenant_admission_id;
  }
  if (row.error_code) {
    taskRun.error_code = row.error_code;
  }
  if (row.error_message) {
    taskRun.error_message = row.error_message;
  }

  return taskRunSchema.parse(taskRun);
}

function mapFlowExecutionPlan(row: Selectable<FlowExecutionPlanTable>): FlowExecutionPlan {
  const plan = flowExecutionPlanSchema.parse({
    ...(jsonRecord(row.plan_json) ?? {}),
    execution_plan_id: row.execution_plan_id,
    execution_plan_ref: row.execution_plan_ref,
    tenant_id: row.tenant_id,
    flow_id: row.flow_id,
    flow_version: row.flow_version,
    flow_sha256: row.flow_sha256,
    execution_plan_hash: row.execution_plan_hash,
    generated_at: toIso(row.generated_at),
  });
  const expectedHash = hashJson({
    execution_plan_id: plan.execution_plan_id,
    execution_plan_ref: plan.execution_plan_ref,
    tenant_id: plan.tenant_id,
    flow_id: plan.flow_id,
    flow_version: plan.flow_version,
    flow_sha256: plan.flow_sha256,
    flow_spec: plan.flow_spec,
    agents: plan.agents,
    tools: plan.tools,
    allowed_tools: plan.allowed_tools,
    budget: plan.budget,
    generated_at: plan.generated_at,
  });
  if (expectedHash !== plan.execution_plan_hash) {
    throw new Error(`FlowExecutionPlan hash mismatch: ${plan.execution_plan_ref}`);
  }
  return plan;
}

function mapAgentExecutionPlan(row: Selectable<AgentExecutionPlanTable>): AgentExecutionPlan {
  const plan = agentExecutionPlanSchema.parse({
    ...(jsonRecord(row.plan_json) ?? {}),
    execution_plan_id: row.execution_plan_id,
    execution_plan_ref: row.execution_plan_ref,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    agent_version: row.agent_version,
    agent_sha256: row.agent_sha256,
    prompt_id: row.prompt_id,
    prompt_version: row.prompt_version,
    prompt_sha256: row.prompt_sha256,
    ...(row.model_policy_id ? { model_policy_id: row.model_policy_id } : {}),
    ...(row.model_policy_version ? { model_policy_version: row.model_policy_version } : {}),
    ...(row.model_policy_hash ? { model_policy_hash: row.model_policy_hash } : {}),
    ...(row.resolved_model_policy_json
      ? {
          resolved_model_policy: resolvedModelPolicySchema.parse(
            fromDbJson(row.resolved_model_policy_json),
          ),
        }
      : {}),
    execution_plan_hash: row.execution_plan_hash,
    generated_at: toIso(row.generated_at),
  });
  const expectedHash = hashJson({
    execution_plan_id: plan.execution_plan_id,
    execution_plan_ref: plan.execution_plan_ref,
    tenant_id: plan.tenant_id,
    agent_id: plan.agent_id,
    agent_version: plan.agent_version,
    agent_sha256: plan.agent_sha256,
    prompt_id: plan.prompt_id,
    prompt_version: plan.prompt_version,
    prompt_sha256: plan.prompt_sha256,
    model_policy: plan.model_policy,
    ...(plan.model_policy_id ? { model_policy_id: plan.model_policy_id } : {}),
    ...(plan.model_policy_version ? { model_policy_version: plan.model_policy_version } : {}),
    ...(plan.model_policy_hash ? { model_policy_hash: plan.model_policy_hash } : {}),
    ...(plan.resolved_model_policy ? { resolved_model_policy: plan.resolved_model_policy } : {}),
    allowed_tools: plan.allowed_tools,
    allowed_handoffs: plan.allowed_handoffs,
    ...(plan.output_schema ? { output_schema: plan.output_schema } : {}),
    budget: plan.budget,
    plan: plan.plan,
    generated_at: plan.generated_at,
  });
  if (expectedHash !== plan.execution_plan_hash) {
    throw new Error(`AgentExecutionPlan hash mismatch: ${plan.execution_plan_ref}`);
  }
  return plan;
}

function mapModelPolicy(row: Selectable<ModelPolicyTable>): ModelPolicy {
  return modelPolicySchema.parse({
    model_policy_id: row.model_policy_id,
    version: row.version,
    status: row.status,
    protocol: row.protocol,
    targets: jsonArray(row.targets_json),
    retry_policy: modelRetryPolicySchema.parse(jsonRecord(row.retry_policy_json) ?? {}),
    fallback_policy: modelFallbackPolicySchema.parse(jsonRecord(row.fallback_policy_json) ?? {}),
    request_policy: modelRequestPolicySchema.parse(jsonRecord(row.request_policy_json) ?? {}),
    revision: row.revision,
    ...(row.created_by ? { created_by: row.created_by } : {}),
    ...(row.updated_by ? { updated_by: row.updated_by } : {}),
    ...(row.published_by ? { published_by: row.published_by } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    ...(row.published_at ? { published_at: toIso(row.published_at) } : {}),
  });
}

function mapAgentRun(row: Selectable<AgentRunTable>): AgentRunRecord {
  return agentRunRecordSchema.parse({
    agent_run_id: row.agent_run_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    task_run_id: row.task_run_id,
    workflow_id: row.workflow_id,
    ...(row.workflow_run_id ? { workflow_run_id: row.workflow_run_id } : {}),
    ...(row.parent_workflow_id ? { parent_workflow_id: row.parent_workflow_id } : {}),
    execution_plan_ref: row.execution_plan_ref,
    execution_plan_hash: row.execution_plan_hash,
    agent_id: row.agent_id,
    agent_version: row.agent_version,
    prompt_id: row.prompt_id,
    prompt_version: row.prompt_version,
    model: row.model,
    ...(row.model_policy_id ? { model_policy_id: row.model_policy_id } : {}),
    ...(row.model_policy_version ? { model_policy_version: row.model_policy_version } : {}),
    ...(row.model_policy_hash ? { model_policy_hash: row.model_policy_hash } : {}),
    ...(row.selected_model_id ? { selected_model_id: row.selected_model_id } : {}),
    ...(row.selected_provider ? { selected_provider: row.selected_provider } : {}),
    fallback_count: row.fallback_count,
    model_call_count: row.model_call_count,
    execution_mode: row.execution_mode,
    ...(row.tenant_policy_snapshot_ref
      ? { tenant_policy_snapshot_ref: row.tenant_policy_snapshot_ref }
      : {}),
    ...(row.tenant_policy_version ? { tenant_policy_version: row.tenant_policy_version } : {}),
    ...(row.tenant_policy_hash ? { tenant_policy_hash: row.tenant_policy_hash } : {}),
    ...(row.tenant_admission_id ? { tenant_admission_id: row.tenant_admission_id } : {}),
    status: row.status,
    current_segment_index: row.current_segment_index,
    model_turn_count: row.model_turn_count,
    tool_call_count: row.tool_call_count,
    handoff_count: row.handoff_count,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    total_tokens: row.total_tokens,
    ...(row.estimated_cost !== null ? { estimated_cost: Number(row.estimated_cost) } : {}),
    ...(row.started_at ? { started_at: toIso(row.started_at) } : {}),
    ...(row.completed_at ? { completed_at: toIso(row.completed_at) } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.error_message ? { error_message: row.error_message } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

function mapModelCallRecord(row: Selectable<ModelCallLogTable>): ModelCallRecord {
  return modelCallRecordSchema.parse({
    model_call_id: row.model_call_id,
    model_request_key: row.model_request_key,
    tenant_id: row.tenant_id,
    ...(row.user_id ? { user_id: row.user_id } : {}),
    ...(row.task_run_id ? { task_run_id: row.task_run_id } : {}),
    ...(row.workflow_id ? { workflow_id: row.workflow_id } : {}),
    ...(row.workflow_run_id ? { workflow_run_id: row.workflow_run_id } : {}),
    ...(row.agent_run_id ? { agent_run_id: row.agent_run_id } : {}),
    ...(row.segment_index !== null ? { segment_index: row.segment_index } : {}),
    ...(row.model_turn_index !== null ? { model_turn_index: row.model_turn_index } : {}),
    model_policy_id: row.model_policy_id,
    model_policy_version: row.model_policy_version,
    model_policy_hash: row.model_policy_hash,
    ...(row.target_id ? { target_id: row.target_id } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model_id ? { model_id: row.model_id } : {}),
    protocol: row.protocol,
    attempt_count: row.attempt_count,
    fallback_index: row.fallback_index,
    status: row.status,
    ...(row.finish_reason ? { finish_reason: row.finish_reason } : {}),
    ...(row.response_id ? { response_id: row.response_id } : {}),
    ...(row.input_tokens !== null ? { input_tokens: row.input_tokens } : {}),
    ...(row.output_tokens !== null ? { output_tokens: row.output_tokens } : {}),
    ...(row.total_tokens !== null ? { total_tokens: row.total_tokens } : {}),
    ...(row.estimated_cost !== null ? { estimated_cost: Number(row.estimated_cost) } : {}),
    ...(row.latency_ms !== null ? { latency_ms: row.latency_ms } : {}),
    ...(row.error_class ? { error_class: row.error_class } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    request_hash: row.request_hash,
    ...(row.response_hash ? { response_hash: row.response_hash } : {}),
    ...(row.safe_response_json !== null
      ? { safe_response_json: jsonRecord(row.safe_response_json) ?? {} }
      : {}),
    ...(row.started_at ? { started_at: toIso(row.started_at) } : {}),
    ...(row.completed_at ? { completed_at: toIso(row.completed_at) } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

function mapModelCallAttempt(row: Selectable<ModelCallAttemptTable>): ModelCallAttempt {
  return modelCallAttemptSchema.parse({
    attempt_id: row.attempt_id,
    model_call_id: row.model_call_id,
    global_attempt_index: row.global_attempt_index,
    target_attempt_index: row.target_attempt_index,
    fallback_index: row.fallback_index,
    attempt_index: row.attempt_index,
    target_id: row.target_id,
    ...(row.provider ? { provider: row.provider } : {}),
    model_id: row.model_id,
    status: row.status,
    ...(row.http_status !== null ? { http_status: row.http_status } : {}),
    ...(row.error_class ? { error_class: row.error_class } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.latency_ms !== null ? { latency_ms: row.latency_ms } : {}),
    ...(row.response_id ? { response_id: row.response_id } : {}),
    ...(row.started_at ? { started_at: toIso(row.started_at) } : {}),
    ...(row.completed_at ? { completed_at: toIso(row.completed_at) } : {}),
    created_at: toIso(row.created_at),
  });
}

function mapAgentStep(row: Selectable<AgentStepTable>): AgentStepRecord {
  return agentStepRecordSchema.parse({
    agent_step_id: row.agent_step_id,
    agent_run_id: row.agent_run_id,
    segment_index: row.segment_index,
    stable_step_key: row.stable_step_key,
    segment_status: row.segment_status,
    ...(row.decision_summary ? { decision_summary: row.decision_summary } : {}),
    proposed_tool_calls: jsonArray(row.proposed_tool_calls_json),
    tool_result_refs: jsonArray(row.tool_result_refs_json),
    authoritative_tool_result_refs:
      jsonArray(row.authoritative_tool_result_refs_json).length > 0
        ? jsonArray(row.authoritative_tool_result_refs_json)
        : jsonArray(row.tool_result_refs_json),
    human_task_ids: jsonArray(row.human_task_ids_json).map(String),
    ...(jsonRecord(row.context_snapshot_before_ref)
      ? { context_snapshot_before: jsonRecord(row.context_snapshot_before_ref) }
      : {}),
    ...(jsonRecord(row.context_snapshot_after_ref)
      ? { context_snapshot_after: jsonRecord(row.context_snapshot_after_ref) }
      : {}),
    handoff_refs: jsonArray(row.handoff_refs_json).filter(isRecord),
    ...(jsonRecord(row.context_snapshot_ref)
      ? { context_snapshot_ref: jsonRecord(row.context_snapshot_ref) }
      : {}),
    ...(row.output_ref ? { output_ref: row.output_ref } : {}),
    usage: jsonRecord(row.usage_json) ? agentUsageSchema.parse(jsonRecord(row.usage_json)) : {},
    ...(row.error_code ? { error_code: row.error_code } : {}),
    ...(row.error_message ? { error_message: row.error_message } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

function snapshotRefFromSnapshotRow(
  row: Selectable<AgentContextSnapshotTable>,
): PiContextSnapshotRef {
  return piContextSnapshotRefSchema.parse({
    snapshot_id: row.snapshot_id,
    schema_version: row.schema_version,
    snapshot_hash: row.snapshot_hash,
    message_count: row.message_count,
    byte_size: row.byte_size,
  });
}

function snapshotFromRow(row: Selectable<AgentContextSnapshotTable>): {
  ref: PiContextSnapshotRef;
  messages: unknown[];
  previousSnapshotId?: string;
} {
  return {
    ref: snapshotRefFromSnapshotRow(row),
    messages: jsonArray(row.sanitized_messages_json),
    ...(row.previous_snapshot_id ? { previousSnapshotId: row.previous_snapshot_id } : {}),
  };
}

function mapAuditEvent(row: Selectable<AuditEventTable>): AuditEvent {
  const auditEvent: AuditEvent = {
    event_id: row.event_id,
    tenant_id: row.tenant_id,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    result: row.result as AuditEvent['result'],
    occurred_at: toIso(row.occurred_at),
    payload: jsonRecord(row.payload) ?? {},
  };

  if (row.actor_id) {
    auditEvent.actor_id = row.actor_id;
  }
  if (row.event_key) {
    auditEvent.event_key = row.event_key;
  }
  if (row.reason) {
    auditEvent.reason = row.reason;
  }
  if (row.trace_id) {
    auditEvent.trace_id = row.trace_id;
  }

  return auditEventSchema.parse(auditEvent);
}

function mapIdempotencyRecord(row: Selectable<IdempotencyRecordTable>): IdempotencyRecord {
  const record: IdempotencyRecord = {
    idempotency_key: row.idempotency_key,
    tenant_id: row.tenant_id,
    target_type: row.target_type,
    target_id: row.target_id,
    request_hash: row.request_hash,
    status: row.status as IdempotencyRecord['status'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };

  if (row.response_json !== null) {
    record.response_json = fromDbJson(row.response_json);
  }

  return idempotencyRecordSchema.parse(record);
}

function mapHumanTask(row: Selectable<HumanTaskTable>): HumanTask {
  const humanTask: HumanTask = {
    human_task_id: row.human_task_id,
    tenant_id: row.tenant_id,
    task_run_id: row.task_run_id,
    kind: row.kind as HumanTask['kind'],
    status: row.status as HumanTask['status'],
    candidate_groups: jsonArray(row.candidate_groups).map(String),
    payload: jsonRecord(row.payload) ?? {},
    created_at: toIso(row.created_at),
  };

  if (row.workflow_id) {
    humanTask.workflow_id = row.workflow_id;
  }
  if (row.assignee) {
    humanTask.assignee = row.assignee;
  }
  if (jsonRecord(row.requested_schema_json)) {
    humanTask.requested_schema = jsonRecord(row.requested_schema_json);
  }
  if (jsonRecord(row.response_json)) {
    humanTask.response = jsonRecord(row.response_json);
  }
  if (row.responded_by) {
    humanTask.responded_by = row.responded_by;
  }
  if (row.responded_at) {
    humanTask.responded_at = toIso(row.responded_at);
  }
  if (row.response_idempotency_key) {
    humanTask.response_idempotency_key = row.response_idempotency_key;
  }
  if (jsonRecord(row.decision)) {
    humanTask.decision = jsonRecord(row.decision);
  }
  if (row.decided_by) {
    humanTask.decided_by = row.decided_by;
  }
  if (row.decided_at) {
    humanTask.decided_at = toIso(row.decided_at);
  }
  if (row.decision_reason) {
    humanTask.decision_reason = row.decision_reason;
  }
  if (row.completed_at) {
    humanTask.completed_at = toIso(row.completed_at);
  }

  return humanTaskSchema.parse(humanTask);
}

function mapToolCallLog(row: Selectable<ToolCallLogTable>): ToolCallLog {
  const toolCallLog: ToolCallLog = {
    tool_call_id: row.tool_call_id,
    tenant_id: row.tenant_id,
    tool_name: row.tool_name,
    tool_version: row.tool_version,
    risk_level: row.risk_level as ToolCallLog['risk_level'],
    policy_decision: row.policy_decision as ToolCallLog['policy_decision'],
    status: row.status as ToolCallLog['status'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };

  if (row.task_run_id) {
    toolCallLog.task_run_id = row.task_run_id;
  }
  if (row.workflow_id) {
    toolCallLog.workflow_id = row.workflow_id;
  }
  if (row.user_id) {
    toolCallLog.user_id = row.user_id;
  }
  if (row.mode) {
    toolCallLog.mode = row.mode as ToolCallLog['mode'];
  }
  if (row.duration_ms !== null) {
    toolCallLog.duration_ms = row.duration_ms;
  }
  if (row.idempotency_key) {
    toolCallLog.idempotency_key = row.idempotency_key;
  }
  if (row.input_hash) {
    toolCallLog.input_hash = row.input_hash;
  }
  if (row.output_hash) {
    toolCallLog.output_hash = row.output_hash;
  }
  if (row.error_code) {
    toolCallLog.error_code = row.error_code;
  }
  if (row.adapter_type) {
    toolCallLog.adapter_type = row.adapter_type;
  }
  if (row.preview_json !== null) {
    toolCallLog.preview_json = fromDbJson(row.preview_json);
  }
  if (row.result_json !== null) {
    toolCallLog.result_json = fromDbJson(row.result_json);
  }
  if (row.tenant_policy_snapshot_ref) {
    toolCallLog.tenant_policy_snapshot_ref = row.tenant_policy_snapshot_ref;
  }
  if (row.policy_decision_code) {
    toolCallLog.policy_decision_code = row.policy_decision_code;
  }

  return toolCallLogSchema.parse(toolCallLog);
}

function mapTenantRuntimePolicy(row: Selectable<TenantRuntimePolicyTable>): TenantRuntimePolicy {
  return tenantRuntimePolicySchema.parse({
    tenant_id: row.tenant_id,
    version: row.version,
    status: row.status,
    allowed_tools: jsonArray(row.allowed_tools_json),
    denied_tools: jsonArray(row.denied_tools_json),
    allowed_models: jsonArray(row.allowed_models_json),
    denied_models: jsonArray(row.denied_models_json),
    allowed_handoffs: jsonArray(row.allowed_handoffs_json),
    denied_handoffs: jsonArray(row.denied_handoffs_json),
    budget_cap: tenantRuntimeBudgetCapSchema.parse(jsonRecord(row.budget_cap_json) ?? {}),
    max_concurrent_agent_runs: row.max_concurrent_agent_runs,
    revision: row.revision,
    ...(row.created_by ? { created_by: row.created_by } : {}),
    ...(row.updated_by ? { updated_by: row.updated_by } : {}),
    ...(row.published_by ? { published_by: row.published_by } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    ...(row.published_at ? { published_at: toIso(row.published_at) } : {}),
  });
}

function mapTenantRuntimePolicySnapshot(
  row: Selectable<TenantRuntimePolicySnapshotTable>,
): TenantRuntimePolicySnapshot {
  const resolved = jsonRecord(row.resolved_policy_json) ?? {};
  return tenantRuntimePolicySnapshotSchema.parse({
    ...resolved,
    snapshot_id: row.snapshot_id,
    snapshot_ref: row.snapshot_ref,
    tenant_id: row.tenant_id,
    root_snapshot_ref: row.root_snapshot_ref ?? row.snapshot_ref,
    ...(row.parent_snapshot_ref ? { parent_snapshot_ref: row.parent_snapshot_ref } : {}),
    derivation_type: row.derivation_type ?? 'root',
    lineage_depth: row.lineage_depth ?? 0,
    source_policy_version: row.source_policy_version,
    source_policy_hash: row.source_policy_hash,
    execution_plan_ref: row.execution_plan_ref,
    execution_plan_hash: row.execution_plan_hash,
    execution_plan_type: row.execution_plan_type,
    snapshot_hash: row.snapshot_hash,
    created_at: toIso(row.created_at),
  });
}

function mapTenantAgentAdmission(row: Selectable<TenantAgentAdmissionTable>): TenantAgentAdmission {
  return tenantAgentAdmissionSchema.parse({
    admission_id: row.admission_id,
    tenant_id: row.tenant_id,
    task_run_id: row.task_run_id,
    ...(row.agent_run_id ? { agent_run_id: row.agent_run_id } : {}),
    ...(row.workflow_id ? { workflow_id: row.workflow_id } : {}),
    ...(row.workflow_run_id ? { workflow_run_id: row.workflow_run_id } : {}),
    policy_snapshot_ref: row.policy_snapshot_ref,
    status: row.status,
    acquired_at: toIso(row.acquired_at),
    ...(row.activated_at ? { activated_at: toIso(row.activated_at) } : {}),
    ...(row.released_at ? { released_at: toIso(row.released_at) } : {}),
    updated_at: toIso(row.updated_at),
    ...(row.release_reason ? { release_reason: row.release_reason } : {}),
    revision: row.revision,
  });
}

function buildTenantPolicySnapshotRef(snapshotId: string): string {
  return `db://tenant-runtime-policy-snapshot/${snapshotId}`;
}

async function withPolicyTransaction<T>(
  db: Kysely<Database>,
  callback: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(callback);
}

async function appendTenantPolicyRelease(
  db: Kysely<Database>,
  policy: TenantRuntimePolicy,
  action: 'publish' | 'rollback' | 'deprecate' | 'disable',
  options: TenantPolicyReleaseOptions,
  previousVersion?: number,
): Promise<void> {
  await new CapabilityReleaseRepository(db).append({
    tenant_id: policy.tenant_id,
    resource_type: 'tenant_runtime_policy',
    resource_id: policy.tenant_id,
    resource_version: policy.version,
    action,
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    target_status:
      action === 'deprecate' ? 'deprecated' : action === 'disable' ? 'disabled' : 'published',
    operator_id: options.operatorId,
    release_note: options.releaseNote,
    metadata_json: options.metadataJson ?? {},
  });
}

async function appendTenantPolicyAudit(
  db: Kysely<Database>,
  policy: TenantRuntimePolicy,
  action: string,
  result: AuditEvent['result'],
  actorId: string,
  reason?: string,
): Promise<void> {
  await new AuditEventRepository(db).append({
    event_key: `${action}:${policy.tenant_id}:${policy.version}`,
    tenant_id: policy.tenant_id,
    actor_id: actorId,
    action,
    target_type: 'tenant_runtime_policy',
    target_id: `${policy.tenant_id}@${policy.version}`,
    result,
    reason,
    payload: {
      tenant_id: policy.tenant_id,
      version: policy.version,
      status: policy.status,
      policy_hash: hashTenantRuntimePolicy(policy),
    },
  });
}

async function appendModelPolicyRelease(
  db: Kysely<Database>,
  policy: ModelPolicy,
  action: 'publish' | 'gray' | 'rollback' | 'deprecate' | 'disable',
  options: ModelPolicyReleaseOptions,
  previousVersion?: number,
): Promise<void> {
  await new CapabilityReleaseRepository(db).append({
    tenant_id: tenant(options),
    resource_type: 'model_policy',
    resource_id: policy.model_policy_id,
    resource_version: policy.version,
    action,
    ...(previousVersion ? { previous_version: previousVersion } : {}),
    target_status:
      action === 'deprecate'
        ? 'deprecated'
        : action === 'disable'
          ? 'disabled'
          : action === 'gray'
            ? 'gray'
            : 'published',
    operator_id: options.operatorId,
    release_note: options.releaseNote,
    metadata_json: {
      ...(options.metadataJson ?? {}),
      model_policy_hash: hashModelPolicy(policy),
      protocol: policy.protocol,
      target_count: policy.targets.length,
    },
  });
}

async function appendModelPolicyAudit(
  db: Kysely<Database>,
  policy: ModelPolicy,
  tenantId: string,
  action: string,
  result: AuditEvent['result'],
  actorId: string,
  reason?: string,
): Promise<void> {
  await new AuditEventRepository(db).append({
    event_key: `${action}:${policy.model_policy_id}:${policy.version}`,
    tenant_id: tenantId,
    actor_id: actorId,
    action,
    target_type: 'model_policy',
    target_id: `${policy.model_policy_id}@${policy.version}`,
    result,
    reason,
    payload: {
      model_policy_id: policy.model_policy_id,
      version: policy.version,
      status: policy.status,
      protocol: policy.protocol,
      model_policy_hash: hashModelPolicy(policy),
      target_count: policy.targets.length,
    },
  });
}

async function activeAdmissionCount(db: Kysely<Database>, tenantId: string): Promise<number> {
  const row = await db
    .selectFrom('tenant_agent_admission')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('tenant_id', '=', tenantId)
    .where('status', 'in', ['reserved', 'active'])
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function acquireTenantAdmissionLock(db: Kysely<Database>, tenantId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`tenant_agent_admission:${tenantId}`}, 0))`.execute(
    db,
  );
}

async function insertAdmission(
  db: Kysely<Database>,
  input: {
    tenantId: string;
    taskRunId: string;
    policySnapshotRef: string;
    status: TenantAdmissionStatus;
    releaseReason?: string;
  },
): Promise<TenantAgentAdmission> {
  const now = new Date();
  const row: Insertable<TenantAgentAdmissionTable> = {
    admission_id: `tenant_admission_${randomUUID()}`,
    tenant_id: input.tenantId,
    task_run_id: input.taskRunId,
    agent_run_id: null,
    workflow_id: null,
    workflow_run_id: null,
    policy_snapshot_ref: input.policySnapshotRef,
    status: input.status,
    acquired_at: now,
    activated_at: null,
    released_at: input.status === 'rejected' ? now : null,
    updated_at: now,
    release_reason: input.releaseReason ?? null,
    revision: 1,
  };
  const saved = await db
    .insertInto('tenant_agent_admission')
    .values(row)
    .onConflict((oc) => oc.column('task_run_id').doNothing())
    .returningAll()
    .executeTakeFirst();
  if (!saved) {
    const existing = await db
      .selectFrom('tenant_agent_admission')
      .selectAll()
      .where('task_run_id', '=', input.taskRunId)
      .where('tenant_id', '=', input.tenantId)
      .executeTakeFirst();
    if (!existing) {
      throw new Error(
        `TenantAgentAdmission insert conflict but existing admission was not found: ${input.taskRunId}`,
      );
    }
    return mapTenantAgentAdmission(existing);
  }
  return mapTenantAgentAdmission(saved);
}

export function hashTenantRuntimePolicy(policy: TenantRuntimePolicy): string {
  return hashJson({
    tenant_id: policy.tenant_id,
    version: policy.version,
    status: policy.status,
    allowed_tools: policy.allowed_tools,
    denied_tools: policy.denied_tools,
    allowed_models: policy.allowed_models,
    denied_models: policy.denied_models,
    allowed_handoffs: policy.allowed_handoffs,
    denied_handoffs: policy.denied_handoffs,
    budget_cap: policy.budget_cap,
    max_concurrent_agent_runs: policy.max_concurrent_agent_runs,
  });
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJson(entryValue)]),
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
