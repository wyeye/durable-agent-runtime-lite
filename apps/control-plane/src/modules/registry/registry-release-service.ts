import type {
  CapabilityRelease,
  EvaluationGateDecision,
  EvaluationGateOverride,
  RegistryResourceType,
  RegistryValidationResult,
  SpecStatus,
} from '@dar/contracts';
import {
  AgentSpecRepository,
  AuditEventRepository,
  CapabilityReleaseRepository,
  EvaluationGateError,
  EvaluationGateService,
  type Database,
  FlowExecutionPlanRepository,
  FlowDefinitionRepository,
  PromptDefinitionRepository,
  RouteConfigRepository,
  ToolManifestRepository,
  withTransaction,
} from '@dar/db';
import type { Kysely } from 'kysely';
import { RegistryValidationService, type RegistryValidationRepositories } from './registry-validation-service.js';

export interface RegistryReleaseServiceOptions {
  tenantId?: string;
  operatorId: string;
  releaseNote?: string;
  metadata?: Record<string, unknown>;
  evaluationGateMode?: 'disabled' | 'advisory' | 'required';
  evaluationCandidateBundleHash?: string;
  evaluationGateDecisionId?: string;
  evaluationGateOverrideId?: string;
}

interface PublishGateResult {
  decision?: EvaluationGateDecision;
  override?: EvaluationGateOverride;
  warning?: string;
}

export interface SetGrayOptions extends RegistryReleaseServiceOptions {
  tenantAllowlist: string[];
  userAllowlist?: string[];
}

export class RegistryReleaseService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly repositories: RegistryValidationRepositories,
    private readonly validationService = new RegistryValidationService(repositories),
  ) {}

  async validate(resourceType: RegistryResourceType, resourceId: string, version: number, tenantId = 'default'): Promise<RegistryValidationResult> {
    const record = await this.getRepository(resourceType).getByIdAndVersion(resourceId, version, { tenantId });
    if (!record) {
      return {
        valid: false,
        can_publish: false,
        errors: [{ code: 'REGISTRY_VERSION_NOT_FOUND', message: 'Registry version not found', severity: 'error' }],
        warnings: [],
        dependency_graph: { nodes: [], edges: [] },
      };
    }
    return this.validateSpec(resourceType, record.spec, { tenantId });
  }

  async publish(resourceType: RegistryResourceType, resourceId: string, version: number, options: RegistryReleaseServiceOptions): Promise<CapabilityRelease> {
    return withTransaction(this.db, async (trx) => {
      const service = this.scoped(trx);
      const validation = await service.validate(resourceType, resourceId, version, tenant(options));
      if (!validation.can_publish) {
        throw new Error(`Registry validation failed for ${resourceType}:${resourceId}@${version}`);
      }
      const repository = service.getRepository(resourceType);
      const previous = await repository.getLatestPublishedVersion(resourceId, { tenantId: tenant(options) });
      const current = await repository.getByIdAndVersion(resourceId, version, { tenantId: tenant(options) });
      if (!current) {
        throw new Error(`Registry version not found for ${resourceType}:${resourceId}@${version}`);
      }
      const gate = await service.assertEvaluationGate(resourceType, resourceId, version, current.sha256, options);
      if (current?.status === 'draft') {
        await repository.markValidated(resourceId, version, { tenantId: tenant(options), operatorId: options.operatorId });
      }
      await repository.publish(resourceId, version, { tenantId: tenant(options), operatorId: options.operatorId });
      const executionPlan = resourceType === 'flow'
        ? await new FlowExecutionPlanRepository(trx).createForFlow({
            flowId: resourceId,
            flowVersion: version,
            tenantId: tenant(options),
            operatorId: options.operatorId,
          })
        : undefined;
      const release = await service.appendRelease({
        resourceType,
        resourceId,
        version,
        action: 'publish',
        targetStatus: 'published',
        validation,
        options: withGateMetadata(options, gate),
        gate,
        ...(previous ? { previousVersion: previous.version } : {}),
      });
      await service.appendAudit(resourceType, resourceId, version, 'registry.publish', 'succeeded', options, {
        release_id: release.release_id,
        ...(gate.decision ? { evaluation_gate_decision_id: gate.decision.gate_decision_id } : {}),
        ...(gate.override ? { evaluation_gate_override_id: gate.override.override_id } : {}),
        ...(gate.warning ? { evaluation_gate_warning: gate.warning } : {}),
        ...(executionPlan ? { execution_plan_ref: executionPlan.execution_plan_ref, execution_plan_hash: executionPlan.execution_plan_hash } : {}),
      });
      return release;
    });
  }

  async publishFlowWithRoute(
    flowId: string,
    flowVersion: number,
    routeId: string,
    routeVersion: number,
    options: RegistryReleaseServiceOptions,
  ): Promise<{ flow_release: CapabilityRelease; route_release: CapabilityRelease }> {
    return withTransaction(this.db, async (trx) => {
      const service = this.scoped(trx);
      const flowValidation = await service.validate('flow', flowId, flowVersion, tenant(options));
      if (!flowValidation.can_publish) {
        throw new Error('Flow validation failed');
      }
      const previousFlow = await service.repositories.flows.getLatestPublishedVersion(flowId, { tenantId: tenant(options) });
      const previousRoute = await service.repositories.routes.getLatestPublishedVersion(routeId, { tenantId: tenant(options) });
      const currentFlow = await service.repositories.flows.getByIdAndVersion(flowId, flowVersion, { tenantId: tenant(options) });
      if (currentFlow?.status === 'draft') {
        await service.repositories.flows.markValidated(flowId, flowVersion, { tenantId: tenant(options), operatorId: options.operatorId });
      }
      await service.repositories.flows.publish(flowId, flowVersion, { tenantId: tenant(options), operatorId: options.operatorId });
      const executionPlan = await new FlowExecutionPlanRepository(trx).createForFlow({
        flowId,
        flowVersion,
        tenantId: tenant(options),
        operatorId: options.operatorId,
      });
      const routeValidation = await service.validate('route', routeId, routeVersion, tenant(options));
      if (!routeValidation.can_publish) {
        throw new Error('Route validation failed');
      }
      const currentRoute = await service.repositories.routes.getByIdAndVersion(routeId, routeVersion, { tenantId: tenant(options) });
      if (currentRoute?.status === 'draft') {
        await service.repositories.routes.markValidated(routeId, routeVersion, { tenantId: tenant(options), operatorId: options.operatorId });
      }
      await service.repositories.routes.publish(routeId, routeVersion, { tenantId: tenant(options), operatorId: options.operatorId });
      const flowRelease = await service.appendRelease({
        resourceType: 'flow',
        resourceId: flowId,
        version: flowVersion,
        action: 'publish',
        targetStatus: 'published',
        validation: flowValidation,
        options,
        ...(previousFlow ? { previousVersion: previousFlow.version } : {}),
      });
      const routeRelease = await service.appendRelease({
        resourceType: 'route',
        resourceId: routeId,
        version: routeVersion,
        action: 'publish',
        targetStatus: 'published',
        validation: routeValidation,
        options,
        ...(previousRoute ? { previousVersion: previousRoute.version } : {}),
      });
      await service.appendAudit('flow', flowId, flowVersion, 'registry.publish', 'succeeded', options, {
        release_id: flowRelease.release_id,
        execution_plan_ref: executionPlan.execution_plan_ref,
        execution_plan_hash: executionPlan.execution_plan_hash,
      });
      await service.appendAudit('route', routeId, routeVersion, 'registry.publish', 'succeeded', options, { release_id: routeRelease.release_id });
      return { flow_release: flowRelease, route_release: routeRelease };
    });
  }

  async setGray(resourceType: RegistryResourceType, resourceId: string, version: number, options: SetGrayOptions): Promise<CapabilityRelease> {
    return withTransaction(this.db, async (trx) => {
      const service = this.scoped(trx);
      const repository = service.getRepository(resourceType);
      const previous = await repository.getLatestPublishedVersion(resourceId, { tenantId: tenant(options) });
      if (!previous || previous.version === version) {
        throw new Error('Gray release requires another published version as fallback');
      }
      await repository.setGray(resourceId, version, {
        tenantId: tenant(options),
        operatorId: options.operatorId,
        grayPolicy: {
          tenant_allowlist: options.tenantAllowlist,
          user_allowlist: options.userAllowlist ?? [],
        },
      });
      const release = await service.appendRelease({
        resourceType,
        resourceId,
        version,
        action: 'gray',
        targetStatus: 'gray',
        options,
        ...(previous ? { previousVersion: previous.version } : {}),
      });
      await service.appendAudit(resourceType, resourceId, version, 'registry.gray', 'succeeded', options, { release_id: release.release_id });
      return release;
    });
  }

  async rollback(resourceType: RegistryResourceType, resourceId: string, targetVersion: number, options: RegistryReleaseServiceOptions): Promise<CapabilityRelease> {
    return withTransaction(this.db, async (trx) => {
      const service = this.scoped(trx);
      const repository = service.getRepository(resourceType);
      const previous = await repository.getLatestVersion(resourceId, { tenantId: tenant(options), status: ['published', 'gray'] });
      await repository.rollback(resourceId, targetVersion, {
        tenantId: tenant(options),
        operatorId: options.operatorId,
        ...(options.releaseNote ? { releaseNote: options.releaseNote } : {}),
      });
      const release = await service.appendRelease({
        resourceType,
        resourceId,
        version: targetVersion,
        action: 'rollback',
        targetStatus: 'published',
        options,
        ...(previous ? { previousVersion: previous.version } : {}),
      });
      await service.appendAudit(resourceType, resourceId, targetVersion, 'registry.rollback', 'succeeded', options, { release_id: release.release_id });
      return release;
    });
  }

  async deprecate(resourceType: RegistryResourceType, resourceId: string, version: number, options: RegistryReleaseServiceOptions): Promise<CapabilityRelease> {
    return this.statusRelease(resourceType, resourceId, version, 'deprecated', 'deprecate', 'registry.deprecate', options);
  }

  async disable(resourceType: RegistryResourceType, resourceId: string, version: number, options: RegistryReleaseServiceOptions): Promise<CapabilityRelease> {
    return this.statusRelease(resourceType, resourceId, version, 'disabled', 'disable', 'registry.disable', options);
  }

  private async statusRelease(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    targetStatus: SpecStatus,
    action: 'disable' | 'deprecate',
    auditAction: string,
    options: RegistryReleaseServiceOptions,
  ): Promise<CapabilityRelease> {
    return withTransaction(this.db, async (trx) => {
      const service = this.scoped(trx);
      const repository = service.getRepository(resourceType);
      const previous = await repository.getLatestVersion(resourceId, { tenantId: tenant(options), status: ['published', 'gray'] });
      if (targetStatus === 'disabled') {
        await repository.disable(resourceId, version, { tenantId: tenant(options), operatorId: options.operatorId });
      } else {
        await repository.deprecate(resourceId, version, { tenantId: tenant(options), operatorId: options.operatorId });
      }
      const release = await service.appendRelease({
        resourceType,
        resourceId,
        version,
        action,
        targetStatus,
        options,
        ...(previous ? { previousVersion: previous.version } : {}),
      });
      await service.appendAudit(resourceType, resourceId, version, auditAction, 'succeeded', options, { release_id: release.release_id });
      return release;
    });
  }

  private async validateSpec(resourceType: RegistryResourceType, spec: unknown, options: { tenantId?: string }): Promise<RegistryValidationResult> {
    if (resourceType === 'flow') {
      return this.validationService.validateFlow(spec, options);
    }
    if (resourceType === 'route') {
      return this.validationService.validateRoute(spec, options);
    }
    if (resourceType === 'tool') {
      return this.validationService.validateTool(spec, options);
    }
    if (resourceType === 'agent') {
      return this.validationService.validateAgent(spec, options);
    }
    return this.validationService.validatePrompt(spec, options);
  }

  private getRepository(resourceType: RegistryResourceType):
    | FlowDefinitionRepository
    | RouteConfigRepository
    | ToolManifestRepository
    | AgentSpecRepository
    | PromptDefinitionRepository {
    if (resourceType === 'flow') {
      return this.repositories.flows;
    }
    if (resourceType === 'route') {
      return this.repositories.routes;
    }
    if (resourceType === 'tool') {
      return this.repositories.tools;
    }
    if (resourceType === 'agent') {
      return this.repositories.agents;
    }
    return this.repositories.prompts;
  }

  private scoped(db: Kysely<Database>): RegistryReleaseService {
    const repositories: RegistryValidationRepositories = {
      flows: new FlowDefinitionRepository(db),
      routes: new RouteConfigRepository(db),
      tools: new ToolManifestRepository(db),
      agents: new AgentSpecRepository(db),
      prompts: new PromptDefinitionRepository(db),
    };
    return new RegistryReleaseService(db, repositories);
  }

  private async appendRelease(input: {
    resourceType: RegistryResourceType;
    resourceId: string;
    version: number;
    action: 'publish' | 'gray' | 'rollback' | 'disable' | 'deprecate';
    targetStatus: SpecStatus;
    previousVersion?: number;
    validation?: RegistryValidationResult;
    options: RegistryReleaseServiceOptions;
    gate?: PublishGateResult;
  }): Promise<CapabilityRelease> {
    return new CapabilityReleaseRepository(this.db).append({
      tenant_id: tenant(input.options),
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      resource_version: input.version,
      action: input.action,
      ...(input.previousVersion ? { previous_version: input.previousVersion } : {}),
      target_status: input.targetStatus,
      operator_id: input.options.operatorId,
      ...(input.validation ? { validation_result: input.validation } : {}),
      ...(input.options.releaseNote ? { release_note: input.options.releaseNote } : {}),
      metadata_json: input.options.metadata ?? {},
      ...(input.gate?.decision ? { evaluation_gate_decision_id: input.gate.decision.gate_decision_id } : {}),
      ...(input.gate?.override ? { evaluation_gate_override_id: input.gate.override.override_id } : {}),
    });
  }

  private async appendAudit(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    action: string,
    result: 'succeeded' | 'failed',
    options: RegistryReleaseServiceOptions,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await new AuditEventRepository(this.db).append({
      tenant_id: tenant(options),
      actor_id: options.operatorId,
      action,
      target_type: `registry.${resourceType}`,
      target_id: `${resourceId}@${version}`,
      result,
      ...(options.releaseNote ? { reason: options.releaseNote } : {}),
      payload,
    });
  }

  private async assertEvaluationGate(
    resourceType: RegistryResourceType,
    resourceId: string,
    version: number,
    resourceHash: string,
    options: RegistryReleaseServiceOptions,
  ): Promise<PublishGateResult> {
    if (resourceType !== 'prompt' && resourceType !== 'agent' && resourceType !== 'model_policy') {
      return {};
    }
    const mode = options.evaluationGateMode ?? 'advisory';
    if (mode === 'disabled') {
      return { warning: 'evaluation gate disabled' };
    }
    if (!options.evaluationCandidateBundleHash) {
      if (mode === 'advisory') {
        return { warning: 'EVALUATION_CANDIDATE_BUNDLE_HASH_REQUIRED: Evaluation candidate bundle hash is required' };
      }
      throw new EvaluationGateError(
        'EVALUATION_CANDIDATE_BUNDLE_HASH_REQUIRED',
        'Evaluation candidate bundle hash is required',
        { resource_type: resourceType, resource_id: resourceId, resource_version: version },
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(options.evaluationCandidateBundleHash)) {
      if (mode === 'advisory') {
        return { warning: 'EVALUATION_CANDIDATE_BUNDLE_HASH_INVALID: Evaluation candidate bundle hash must be sha256 hex' };
      }
      throw new EvaluationGateError(
        'EVALUATION_CANDIDATE_BUNDLE_HASH_INVALID',
        'Evaluation candidate bundle hash must be sha256 hex',
        { resource_type: resourceType, resource_id: resourceId, resource_version: version },
      );
    }
    const result = await new EvaluationGateService(this.db).assertPublishAllowed({
      resourceType,
      resourceId,
      resourceVersion: version,
      resourceHash,
      candidateBundleHash: options.evaluationCandidateBundleHash,
      operatorId: options.operatorId,
      tenantId: tenant(options),
      mode,
    });
    if (
      options.evaluationGateDecisionId &&
      result.decision?.gate_decision_id !== options.evaluationGateDecisionId
    ) {
      throw new EvaluationGateError(
        'EVALUATION_GATE_DECISION_MISMATCH',
        'Evaluation gate decision id does not match the exact candidate gate decision',
        { resource_type: resourceType, resource_id: resourceId, resource_version: version },
      );
    }
    if (
      options.evaluationGateOverrideId &&
      result.override?.override_id !== options.evaluationGateOverrideId
    ) {
      throw new EvaluationGateError(
        'EVALUATION_GATE_OVERRIDE_MISMATCH',
        'Evaluation gate override id does not match the exact candidate gate override',
        { resource_type: resourceType, resource_id: resourceId, resource_version: version },
      );
    }
    return result;
  }
}

function tenant(options: { tenantId?: string }): string {
  return options.tenantId ?? 'default';
}

function withGateMetadata(
  options: RegistryReleaseServiceOptions,
  gate: PublishGateResult,
): RegistryReleaseServiceOptions {
  return {
    ...options,
    metadata: {
      ...(options.metadata ?? {}),
      ...(options.evaluationCandidateBundleHash ? {
        evaluation_candidate_bundle_hash: options.evaluationCandidateBundleHash,
      } : {}),
      ...(gate.decision ? {
        evaluation_gate_decision_id: gate.decision.gate_decision_id,
        evaluation_candidate_bundle_hash: gate.decision.candidate_bundle_hash,
      } : {}),
      ...(gate.override ? { evaluation_gate_override_id: gate.override.override_id } : {}),
      ...(gate.warning ? { evaluation_gate_warning: gate.warning } : {}),
    },
  };
}
