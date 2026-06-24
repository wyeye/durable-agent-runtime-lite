import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  AgentSpec,
  CapabilityRelease,
  EvaluationCase,
  EvaluationCaseResult,
  EvaluationComparison,
  EvaluationExecutionPlan,
  EvaluationGateOverride,
  EvaluationGatePolicy,
  EvaluationRun,
  EvaluationSubjectSnapshot,
  ModelPolicy,
  PromptDefinition,
  StandardResponse,
  TenantRuntimePolicy,
  ToolInvokeResponse,
  ToolCallLog,
  ToolManifest,
  ToolPreviewResponse,
} from '@dar/contracts';
import { tenantRuntimePolicySchema } from '@dar/contracts';
import {
  AgentSpecRepository,
  AuditEventRepository,
  EvaluationExecutionPlanBuilder,
  EvaluationExecutionPlanRepository,
  EvaluationGateDecisionRepository,
  EvaluationGateOverrideRepository,
  EvaluationSubjectSnapshotBuilder,
  EvaluationSubjectSnapshotRepository,
  ModelPolicyRepository,
  PromptDefinitionRepository,
  TenantRuntimePolicyRepository,
  ToolCallLogRepository,
  ToolManifestRepository,
  closeDb,
  createDb,
  hashModelPolicy,
  sql,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import {
  LOCAL_OLLAMA_MODEL_ID,
  applySmokeModelGatewayReadiness,
  ensureModelCatalogEntry,
  localMockModelCatalogEntryInput,
  localOllamaModelCatalogEntryInput,
} from './model-catalog-seed.js';

type Scenario = 'framework' | 'regression' | 'publish_gate';
type SubjectType = 'prompt' | 'agent' | 'model_policy';
type Db = ReturnType<typeof createDb>;

interface RegistryRecord<TSpec> {
  resource_id: string;
  version: number;
  status: string;
  revision: number;
  sha256?: string;
  spec: TSpec;
}

interface EvaluationRunCreateResponse {
  evaluation_run: EvaluationRun;
  workflow_start: {
    workflow_id: string;
    run_id?: string;
    started: boolean;
    mode: 'mock' | 'temporal';
  };
}

interface CandidateResources {
  prompt: PromptDefinition;
  agent: AgentSpec;
  modelPolicy: ModelPolicy;
  subjectSnapshot: EvaluationSubjectSnapshot;
  executionPlan: EvaluationExecutionPlan;
}

interface SmokeSummary {
  ok: true;
  scenario: Scenario;
  tenant_id: string;
  dataset_id?: string;
  dataset_hash?: string;
  gate_policy_id?: string;
  gate_policy_hash?: string;
  runs?: Array<{
    name: string;
    evaluation_run_id: string;
    workflow_id?: string;
    workflow_run_id?: string;
    status: string;
    candidate_bundle_hash: string;
    subject_snapshot_ref: string;
    evaluation_execution_plan_ref: string;
    case_workflows?: Array<{ case_id: string; workflow_id?: string; workflow_run_id?: string; status: string }>;
  }>;
  decisions?: Array<{ name: string; gate_decision_id: string; decision: string; candidate_bundle_hash: string }>;
  comparison?: {
    comparison_id: string;
    comparable: boolean;
    newly_failed_cases: string[];
    pass_rate_delta?: number;
    overall_score_delta?: number;
  };
  publish_gate?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  reservation?: Record<string, unknown>;
  redaction?: Record<string, unknown>;
  tool_gateway_policy?: Record<string, unknown>;
}

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const scenario = scenarioFromEnv();
const controlPlaneUrl = trimTrailingSlash(process.env.CONTROL_PLANE_URL ?? 'http://localhost:3100');
const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const toolGatewayUrl = trimTrailingSlash(process.env.TOOL_GATEWAY_URL ?? 'http://localhost:3200');
const runtimeWorkerUrl = trimTrailingSlash(process.env.RUNTIME_WORKER_URL ?? 'http://localhost:3300');
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
const runStamp = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const tenantId = process.env.SMOKE_TENANT_ID ?? `evaluation_smoke_${scenario}_${runStamp}`;
const userId = process.env.SMOKE_USER_ID ?? 'evaluation_smoke_operator';
const requestPrefix = `evaluation_smoke_${scenario}_${runStamp}`;
const artifactDir = process.env.EVALUATION_SMOKE_ARTIFACT_DIR
  ? process.env.EVALUATION_SMOKE_ARTIFACT_DIR
  : join(repoRoot, 'artifacts/evaluation-backend-e2e');
let modelGatewayProfile = process.env.EVALUATION_SMOKE_MODEL_PROVIDER ?? 'local-mock';
let modelGatewayModel = process.env.EVALUATION_SMOKE_MODEL_ID ?? 'dar-local-model';
let modelGatewayBaseUrl = process.env.MODEL_GATEWAY_BASE_URL ?? 'http://mock-server:4100';

const adminHeaders = authHeaders('platform_admin', `${requestPrefix}_admin`);
const operatorHeaders = authHeaders('capability_operator', `${requestPrefix}_operator`);
const auditorHeaders = authHeaders('auditor', `${requestPrefix}_auditor`);

async function main(): Promise<void> {
  const db = createDb({ databaseUrl });
  try {
    await assertServicesReady();
    await assertWorkerUsesModelGateway();
    await seedTenantPolicy(db);
    await seedTools(db, tenantId, {
      knowledgeMaxCalls: scenario === 'framework' ? 1 : 5,
      recordMaxCalls: 1,
    });

    const summary = scenario === 'framework'
      ? await runFrameworkScenario(db)
      : scenario === 'regression'
        ? await runRegressionScenario(db)
        : await runPublishGateScenario(db);

    await mkdir(artifactDir, { recursive: true });
    const artifactFile = join(artifactDir, `${scenario}.json`);
    await writeFile(artifactFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, scenario }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      scenario,
      tenant_id: tenantId,
      error: error instanceof Error ? error.message : 'unknown error',
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await closeDb(db);
  }
}

async function runFrameworkScenario(db: Db): Promise<SmokeSummary> {
  const cases = frameworkCasesForRuntime();
  const dataset = await prepareDataset('framework', cases);
  const gatePolicy = await prepareGatePolicy('framework', dataset, {
    minimum_pass_rate: 0,
    minimum_weighted_score: 0,
    maximum_system_error_rate: 1,
  });
  const candidate = await prepareCandidate(db, {
    suffix: 'framework',
    subjectType: 'prompt',
    scenarioText: usesOllamaModelGateway()
      ? 'local-ollama framework smoke. Call the only available tool exactly once before answering.'
      : 'model_gateway:mixed_framework',
    allowedTools: usesOllamaModelGateway()
      ? ['knowledge.search@1.0.0']
      : ['knowledge.search@1.0.0', 'record.write.mock@1.0.0'],
    primaryScenario: usesOllamaModelGateway() ? 'readonly_tool' : 'final_only',
    datasetId: dataset.dataset_id,
    datasetVersion: dataset.version,
    publishable: false,
  });
  const run = await startAndWaitEvaluationRun(candidate.executionPlan, dataset, 'manual');
  const results = await getRunResults(run.evaluation_run_id);
  assert.equal(run.status, 'completed');
  assert.equal(run.evidence_collection_status, 'completed');
  assert.equal(results.length, cases.length);
  assertCaseStatuses(results, frameworkCaseStatusExpectations());
  if (!usesOllamaModelGateway()) {
    assert.ok((run.system_error_cases ?? 0) >= 1, 'system_error case must not prevent run completion');
  }
  assert.ok(run.workflow_id, 'EvaluationRun workflow_id must be recorded');
  assert.ok(run.workflow_run_id, 'EvaluationRun workflow_run_id must be recorded');

  const evidence = await assertFrameworkEvidence(db, run, results);
  const decision = await findGateDecision(db, 'prompt', candidate.prompt.prompt_id, 1, candidate.subjectSnapshot.candidate_bundle_hash);
  assert.ok(decision, 'framework run must create a gate decision');
  const reservation = await runPostgresReservationEvidence(db, candidate.executionPlan);
  const redaction = await assertToolGatewayRedaction(run, results);
  const toolGatewayPolicy = await assertToolGatewayEvaluationPolicy(db, candidate.executionPlan);

  return {
    ok: true,
    scenario,
    tenant_id: tenantId,
    dataset_id: dataset.dataset_id,
    dataset_hash: dataset.dataset_hash,
    gate_policy_id: gatePolicy.gate_policy_id,
    gate_policy_hash: gatePolicy.gate_policy_hash,
    runs: [summaryRun('framework', run, candidate, results)],
    decisions: [summaryDecision('framework', decision)],
    evidence,
    reservation,
    redaction,
    tool_gateway_policy: toolGatewayPolicy,
  };
}

async function runRegressionScenario(db: Db): Promise<SmokeSummary> {
  const dataset = await prepareDataset('regression', regressionCases);
  const gatePolicy = await prepareGatePolicy('regression', dataset, {
    minimum_pass_rate: 0.8,
    minimum_weighted_score: 0.8,
  });
  const baseline = await prepareCandidate(db, {
    suffix: 'regression_a',
    subjectType: 'prompt',
    scenarioText: 'model_gateway:regression_a',
    allowedTools: ['knowledge.search@1.0.0'],
    primaryScenario: 'final_only',
    datasetId: dataset.dataset_id,
    datasetVersion: dataset.version,
    publishable: false,
  });
  const degraded = await prepareCandidate(db, {
    suffix: 'regression_b',
    subjectType: 'prompt',
    scenarioText: 'model_gateway:regression_b_degraded',
    allowedTools: ['knowledge.search@1.0.0'],
    primaryScenario: 'readonly_tool',
    datasetId: dataset.dataset_id,
    datasetVersion: dataset.version,
    publishable: false,
  });
  assert.notEqual(baseline.subjectSnapshot.candidate_bundle_hash, degraded.subjectSnapshot.candidate_bundle_hash);

  const runA = await startAndWaitEvaluationRun(baseline.executionPlan, dataset, 'regression');
  assert.equal(runA.status, 'completed');
  assert.equal(runA.passed_cases, regressionCases.length, 'baseline candidate must pass all regression cases');
  const decisionA = await findGateDecision(db, 'prompt', baseline.prompt.prompt_id, 1, baseline.subjectSnapshot.candidate_bundle_hash);
  assert.equal(decisionA?.decision, 'passed');

  const runB = await startAndWaitEvaluationRun(degraded.executionPlan, dataset, 'regression', runA.evaluation_run_id);
  assert.equal(runB.status, 'completed');
  assert.ok(runB.failed_cases > 0, 'degraded candidate must produce failed cases');

  const comparison = await waitForComparison(db, runB.evaluation_run_id, runA.evaluation_run_id);
  assert.equal(comparison.comparable, true);
  assert.ok(comparison.newly_failed_cases.length > 0, 'comparison must include newly failed cases');
  assert.ok((comparison.pass_rate_delta ?? 0) < 0 || (comparison.overall_score_delta ?? 0) < 0, 'candidate B must regress');
  const decisionB = await findGateDecision(db, 'prompt', degraded.prompt.prompt_id, 1, degraded.subjectSnapshot.candidate_bundle_hash);
  assert.ok(decisionB && ['failed', 'advisory_failed'].includes(decisionB.decision));
  const gateAudits = await new AuditEventRepository(db).list({ tenantId, targetId: `${degraded.prompt.prompt_id}@1`, limit: 20 });
  assert.ok(gateAudits.some((event) => event.action === 'evaluation.gate.failed'), 'regression gate audit must exist');

  return {
    ok: true,
    scenario,
    tenant_id: tenantId,
    dataset_id: dataset.dataset_id,
    dataset_hash: dataset.dataset_hash,
    gate_policy_id: gatePolicy.gate_policy_id,
    gate_policy_hash: gatePolicy.gate_policy_hash,
    runs: [
      summaryRun('baseline', runA, baseline, await getRunResults(runA.evaluation_run_id)),
      summaryRun('degraded', runB, degraded, await getRunResults(runB.evaluation_run_id)),
    ],
    decisions: [
      summaryDecision('baseline', must(decisionA, 'baseline gate decision')),
      summaryDecision('degraded', must(decisionB, 'degraded gate decision')),
    ],
    comparison: {
      comparison_id: comparison.comparison_id,
      comparable: comparison.comparable,
      newly_failed_cases: comparison.newly_failed_cases,
      ...(comparison.pass_rate_delta !== undefined ? { pass_rate_delta: comparison.pass_rate_delta } : {}),
      ...(comparison.overall_score_delta !== undefined ? { overall_score_delta: comparison.overall_score_delta } : {}),
    },
  };
}

async function runPublishGateScenario(db: Db): Promise<SmokeSummary> {
  const dataset = await prepareDataset('publish_gate', publishGateCases);
  const gatePolicy = await prepareGatePolicy('publish_gate', dataset, {
    minimum_pass_rate: 1,
    minimum_weighted_score: 1,
    maximum_system_error_rate: 0,
  });

  const promptCandidate = await prepareCandidate(db, {
    suffix: 'publish_prompt',
    subjectType: 'prompt',
    scenarioText: 'model_gateway:publish_prompt',
    allowedTools: [],
    primaryScenario: 'final_only',
    datasetId: dataset.dataset_id,
    datasetVersion: dataset.version,
    publishable: true,
  });
  const promptRun = await startAndWaitEvaluationRun(promptCandidate.executionPlan, dataset, 'publish_gate');
  const promptDecision = must(
    await findGateDecision(db, 'prompt', promptCandidate.prompt.prompt_id, 1, promptCandidate.subjectSnapshot.candidate_bundle_hash),
    'prompt gate decision',
  );
  assert.equal(promptDecision.decision, 'passed');
  const promptRelease = await publishResource('prompts', promptCandidate.prompt.prompt_id, 1, 'publish gate prompt A', {
    evaluation_candidate_bundle_hash: promptDecision.candidate_bundle_hash,
    evaluation_gate_decision_id: promptDecision.gate_decision_id,
  });
  assert.equal(promptRelease.evaluation_gate_decision_id, promptDecision.gate_decision_id);

  const stalePrompt = await cloneAndChangePrompt(promptCandidate.prompt.prompt_id);
  assert.notEqual(stalePrompt.sha256, promptCandidate.prompt.sha256, 'stale prompt hash must change after clone/update');
  await expectPublishBlocked('prompts', stalePrompt.prompt_id, stalePrompt.version, 'stale prompt B', {
    evaluation_candidate_bundle_hash: promptDecision.candidate_bundle_hash,
    evaluation_gate_decision_id: promptDecision.gate_decision_id,
  });
  const blockedAudits = await new AuditEventRepository(db).list({ tenantId, targetId: `${stalePrompt.prompt_id}@${stalePrompt.version}`, limit: 20 });
  assert.ok(blockedAudits.some((event) => event.action === 'evaluation.publish.blocked'), 'stale publish must be audited');

  const overrideCandidate = await prepareCandidate(db, {
    suffix: 'publish_prompt_override',
    subjectType: 'prompt',
    scenarioText: 'model_gateway:regression_b_degraded publish override degraded',
    allowedTools: [],
    primaryScenario: 'final_only',
    datasetId: dataset.dataset_id,
    datasetVersion: dataset.version,
    publishable: true,
    promptContentSuffix: 'Override candidate intentionally returns degraded text while the case requires the standard final answer.',
  });
  const overrideRun = await startAndWaitEvaluationRun(overrideCandidate.executionPlan, dataset, 'publish_gate');
  assert.equal(overrideRun.status, 'completed');
  assert.ok(overrideRun.failed_cases > 0, 'override candidate must fail gate before override');
  const overrideDecision = must(
    await findGateDecision(db, 'prompt', overrideCandidate.prompt.prompt_id, 1, overrideCandidate.subjectSnapshot.candidate_bundle_hash),
    'override prompt failed gate decision',
  );
  assert.ok(['failed', 'advisory_failed'].includes(overrideDecision.decision), 'override path needs a failed decision');
  const override = await createOverride(overrideDecision.gate_decision_id, overrideDecision.resource_hash, 'AR-2B smoke exact hash override');
  await expectOverrideForbidden(overrideDecision.gate_decision_id, overrideDecision.resource_hash);
  const expiredOverride = await createExpiredOverride(db, overrideDecision);
  await expectPublishBlocked('prompts', overrideCandidate.prompt.prompt_id, 1, 'expired override must fail', {
    evaluation_candidate_bundle_hash: overrideDecision.candidate_bundle_hash,
    evaluation_gate_decision_id: overrideDecision.gate_decision_id,
    evaluation_gate_override_id: expiredOverride.override_id,
  });
  const overrideStalePrompt = await cloneAndChangePrompt(overrideCandidate.prompt.prompt_id);
  await expectPublishBlocked('prompts', overrideStalePrompt.prompt_id, overrideStalePrompt.version, 'changed override hash must fail', {
    evaluation_candidate_bundle_hash: overrideDecision.candidate_bundle_hash,
    evaluation_gate_decision_id: overrideDecision.gate_decision_id,
    evaluation_gate_override_id: override.override_id,
  });
  const overrideRelease = await publishResource('prompts', overrideCandidate.prompt.prompt_id, 1, 'publish gate prompt override', {
    evaluation_candidate_bundle_hash: overrideDecision.candidate_bundle_hash,
    evaluation_gate_decision_id: overrideDecision.gate_decision_id,
    evaluation_gate_override_id: override.override_id,
  });
  assert.equal(overrideRelease.evaluation_gate_decision_id, overrideDecision.gate_decision_id);
  assert.equal(overrideRelease.evaluation_gate_override_id, override.override_id);

  const agentCandidate = await prepareCandidate(db, {
    suffix: 'publish_agent',
    subjectType: 'agent',
    scenarioText: 'model_gateway:publish_agent',
    allowedTools: [],
    primaryScenario: 'final_only',
    datasetId: dataset.dataset_id,
    datasetVersion: dataset.version,
    publishable: true,
  });
  const agentRun = await startAndWaitEvaluationRun(agentCandidate.executionPlan, dataset, 'publish_gate');
  const agentDecision = must(
    await findGateDecision(db, 'agent', agentCandidate.agent.agent_id, 1, agentCandidate.subjectSnapshot.candidate_bundle_hash),
    'agent gate decision',
  );
  assert.equal(agentDecision.decision, 'passed');
  const agentRelease = await publishResource('agents', agentCandidate.agent.agent_id, 1, 'publish gate agent A', {
    evaluation_candidate_bundle_hash: agentDecision.candidate_bundle_hash,
    evaluation_gate_decision_id: agentDecision.gate_decision_id,
  });
  assert.equal(agentRelease.evaluation_gate_decision_id, agentDecision.gate_decision_id);

  const modelCandidate = await prepareCandidate(db, {
    suffix: 'publish_model_policy',
    subjectType: 'model_policy',
    scenarioText: 'model_gateway:publish_model_policy',
    allowedTools: [],
    primaryScenario: 'final_only',
    datasetId: dataset.dataset_id,
    datasetVersion: dataset.version,
    publishable: true,
  });
  const modelRun = await startAndWaitEvaluationRun(modelCandidate.executionPlan, dataset, 'publish_gate');
  const modelDecision = must(
    await findGateDecision(db, 'model_policy', modelCandidate.modelPolicy.model_policy_id, 1, modelCandidate.subjectSnapshot.candidate_bundle_hash),
    'model policy gate decision',
  );
  assert.equal(modelDecision.decision, 'passed');
  const modelRelease = await publishResource('model-policies', modelCandidate.modelPolicy.model_policy_id, 1, 'publish gate model policy A', {
    evaluation_candidate_bundle_hash: modelDecision.candidate_bundle_hash,
    evaluation_gate_decision_id: modelDecision.gate_decision_id,
  });
  assert.equal(modelRelease.resource_type, 'model_policy');
  assert.equal(modelRelease.evaluation_gate_decision_id, modelDecision.gate_decision_id);
  const modelHistory = await getJson<CapabilityRelease[]>(
    `${controlPlaneUrl}/api/v1/model-policies/${encodeURIComponent(modelCandidate.modelPolicy.model_policy_id)}/releases`,
    auditorHeaders,
  );
  assert.ok(modelHistory.some((release) => release.release_id === modelRelease.release_id && release.resource_type === 'model_policy'));

  return {
    ok: true,
    scenario,
    tenant_id: tenantId,
    dataset_id: dataset.dataset_id,
    dataset_hash: dataset.dataset_hash,
    gate_policy_id: gatePolicy.gate_policy_id,
    gate_policy_hash: gatePolicy.gate_policy_hash,
    runs: [
      summaryRun('prompt', promptRun, promptCandidate, await getRunResults(promptRun.evaluation_run_id)),
      summaryRun('agent', agentRun, agentCandidate, await getRunResults(agentRun.evaluation_run_id)),
      summaryRun('model_policy', modelRun, modelCandidate, await getRunResults(modelRun.evaluation_run_id)),
    ],
    decisions: [
      summaryDecision('prompt', promptDecision),
      summaryDecision('agent', agentDecision),
      summaryDecision('model_policy', modelDecision),
    ],
    publish_gate: {
      prompt_release_id: promptRelease.release_id,
      prompt_override_release_id: overrideRelease.release_id,
      agent_release_id: agentRelease.release_id,
      model_policy_release_id: modelRelease.release_id,
      override_id: override.override_id,
      expired_override_id: expiredOverride.override_id,
      stale_publish_blocked: true,
      override_hash_change_blocked: true,
      override_rbac_blocked: true,
      model_policy_repository_path_verified: modelRelease.resource_type === 'model_policy',
    },
  };
}

const frameworkCases: EvaluationCase[] = [
  caseSpec('framework_pass_final', 'final_only case', 'final_only', {
    final_assertions: [{ type: 'contains', value: 'Mock final answer' }],
  }),
  caseSpec('framework_pass_partial', 'readonly partial score pass', 'readonly_tool', {
    expected_tool_calls: [expectedToolCall('knowledge.search', 1, 1)],
    final_assertions: [{ type: 'contains', value: 'Mock final after readonly_tool boundary' }],
    minimum_case_score: 0.5,
  }),
  caseSpec('framework_candidate_failed', 'candidate quality failed', 'final_only', {
    final_assertions: [{ type: 'contains', value: 'value-that-will-not-appear' }],
  }),
  caseSpec('framework_system_error', 'malformed tool system error', 'malformed_tool_call', {
    expected_status: 'completed',
  }),
  caseSpec('framework_tool_policy_deny', 'tool evaluation policy deny', 'repeated_tool', {
    expected_tool_calls: [expectedToolCall('knowledge.search', 1, 1)],
    final_assertions: [{ type: 'non_empty' }],
  }),
];

function frameworkCasesForRuntime(): EvaluationCase[] {
  if (!usesOllamaModelGateway()) {
    return frameworkCases;
  }
  return [
    caseSpec('framework_pass_final', 'ollama readonly pass one', 'readonly_tool', {
      expected_tool_calls: [expectedToolCall('knowledge.search', 1, 1)],
      final_assertions: [{ type: 'non_empty' }],
    }),
    caseSpec('framework_pass_partial', 'ollama readonly pass two', 'readonly_tool', {
      expected_tool_calls: [expectedToolCall('knowledge.search', 1, 1)],
      final_assertions: [{ type: 'non_empty' }],
      minimum_case_score: 0.5,
    }),
    caseSpec('framework_candidate_failed', 'ollama candidate quality failed', 'readonly_tool', {
      expected_tool_calls: [expectedToolCall('knowledge.search', 1, 1)],
      final_assertions: [{ type: 'contains', value: 'value-that-will-not-appear' }],
    }),
    caseSpec('framework_system_error', 'ollama no system error fixture', 'readonly_tool', {
      expected_tool_calls: [expectedToolCall('knowledge.search', 1, 1)],
      final_assertions: [{ type: 'non_empty' }],
    }),
    caseSpec('framework_tool_policy_deny', 'ollama tool evaluation policy deny', 'readonly_tool', {
      expected_tool_calls: [expectedToolCall('knowledge.search', 2, 2)],
      final_assertions: [{ type: 'non_empty' }],
    }),
  ];
}

function frameworkCaseStatusExpectations(): Record<string, EvaluationCaseResult['status']> {
  return usesOllamaModelGateway()
    ? {
        framework_pass_final: 'passed',
        framework_pass_partial: 'passed',
        framework_candidate_failed: 'failed',
        framework_system_error: 'passed',
        framework_tool_policy_deny: 'failed',
      }
    : {
        framework_pass_final: 'passed',
        framework_pass_partial: 'passed',
        framework_candidate_failed: 'failed',
        framework_system_error: 'system_error',
        framework_tool_policy_deny: 'failed',
      };
}

const regressionCases: EvaluationCase[] = [
  caseSpec('regression_final_1', 'regression final one', 'final_only', {
    final_assertions: [{ type: 'contains', value: 'Mock final answer' }],
  }),
  caseSpec('regression_final_2', 'regression final two', 'final_only', {
    final_assertions: [{ type: 'contains', value: 'Mock final answer' }],
  }),
];

const publishGateCases: EvaluationCase[] = [
  caseSpec('publish_gate_final', 'publish gate final', 'final_only', {
    final_assertions: [{ type: 'contains', value: 'Mock final answer' }],
  }),
  caseSpec('publish_gate_no_tool', 'publish gate forbids readonly tool', 'final_only', {
    forbidden_tools: ['knowledge.search'],
    final_assertions: [{ type: 'contains', value: 'Mock final answer' }],
  }),
];

function caseSpec(
  caseId: string,
  name: string,
  modelScenario: string,
  overrides: Partial<EvaluationCase>,
): EvaluationCase {
  return {
    case_id: caseId,
    dataset_id: 'pending',
    dataset_version: 1,
    name,
    input: { text: `${modelScenario} AR-2B evaluation smoke ${caseId}` },
    expected_status: 'completed',
    expected_tool_calls: [],
    forbidden_tools: [],
    final_assertions: [{ type: 'non_empty' }],
    policy_assertions: [],
    context_refs: [],
    weight: 1,
    tags: ['ar-2b', modelScenario],
    enabled: true,
    ...overrides,
  };
}

function expectedToolCall(toolName: string, minCalls: number, maxCalls: number): EvaluationCase['expected_tool_calls'][number] {
  return {
    tool_name: toolName,
    min_calls: minCalls,
    max_calls: maxCalls,
    argument_match_mode: 'ignore',
    expected_arguments: {},
  };
}

async function prepareDataset(kind: string, inputCases: EvaluationCase[]): Promise<RequiredHashDataset> {
  const datasetId = `ar2b_${kind}_${runStamp}`;
  const created = await postJson<RequiredHashDataset>(
    `${controlPlaneUrl}/api/v1/evaluation-datasets`,
    {
      dataset_id: datasetId,
      version: 1,
      name: `AR-2B ${kind} dataset ${runStamp}`,
      status: 'draft',
      tags: ['ar-2b', kind],
      default_weight: 1,
      revision: 1,
    },
    operatorHeaders,
  );
  for (const evaluationCase of inputCases) {
    await postJson<EvaluationCase>(
      `${controlPlaneUrl}/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/1/cases`,
      {
        ...evaluationCase,
        case_id: `${datasetId}_${evaluationCase.case_id}`,
        dataset_id: datasetId,
        dataset_version: 1,
      },
      operatorHeaders,
    );
  }
  await postJson<RequiredHashDataset>(
    `${controlPlaneUrl}/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/1/validate`,
    {},
    operatorHeaders,
  );
  const published = await postJson<RequiredHashDataset>(
    `${controlPlaneUrl}/api/v1/evaluation-datasets/${encodeURIComponent(datasetId)}/versions/1/publish`,
    {},
    adminHeaders,
  );
  assert.ok(published.dataset_hash, 'published dataset must have dataset_hash');
  assert.equal(created.dataset_id, published.dataset_id);
  return published;
}

interface RequiredHashDataset {
  dataset_id: string;
  version: number;
  dataset_hash: string;
}

async function prepareGatePolicy(
  kind: string,
  dataset: RequiredHashDataset,
  thresholds: Record<string, unknown>,
): Promise<RequiredHashGatePolicy> {
  const gatePolicyId = `000_ar2b_${kind}_gate_${runStamp}`;
  await postJson<EvaluationGatePolicy>(
    `${controlPlaneUrl}/api/v1/evaluation-gate-policies`,
    {
      policy: {
        gate_policy_id: gatePolicyId,
        version: 1,
        status: 'draft',
        resource_types: ['prompt', 'agent', 'model_policy'],
        required_dataset_refs: [{
          dataset_id: dataset.dataset_id,
          version: dataset.version,
          dataset_hash: dataset.dataset_hash,
        }],
        thresholds,
        regression_rules: {
          maximum_score_regression: 0,
          maximum_pass_rate_regression: 0,
          block_newly_failed_cases: true,
          block_safety_regression: true,
          block_tool_regression: true,
          require_same_dataset: true,
        },
        required_case_tags: [],
        allow_override: true,
      },
    },
    operatorHeaders,
  );
  await postJson<EvaluationGatePolicy>(
    `${controlPlaneUrl}/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions/1/validate`,
    {},
    operatorHeaders,
  );
  const published = await postJson<RequiredHashGatePolicy>(
    `${controlPlaneUrl}/api/v1/evaluation-gate-policies/${encodeURIComponent(gatePolicyId)}/versions/1/publish`,
    {},
    adminHeaders,
  );
  assert.ok(published.gate_policy_hash, 'published gate policy must have hash');
  return published;
}

interface RequiredHashGatePolicy {
  gate_policy_id: string;
  version: number;
  gate_policy_hash: string;
}

async function prepareCandidate(
  db: Db,
  input: {
    suffix: string;
    subjectType: SubjectType;
    scenarioText: string;
    allowedTools: string[];
    primaryScenario: string;
    datasetId: string;
    datasetVersion: number;
    publishable: boolean;
    promptContentSuffix?: string;
  },
): Promise<CandidateResources> {
  const promptId = `ar2b_${input.suffix}_prompt_${runStamp}`;
  const agentId = `ar2b_${input.suffix}_agent_${runStamp}`;
  const modelPolicyId = `ar2b_${input.suffix}_model_${runStamp}`;
  const promptStatus = input.publishable && input.subjectType === 'prompt' ? 'validated' : 'published';
  const agentStatus = input.publishable && input.subjectType === 'agent' ? 'validated' : 'published';
  const modelPolicyStatus = input.publishable && input.subjectType === 'model_policy' ? 'validated' : 'published';
  const modelPolicy = await seedModelPolicy(db, modelPolicyId, modelPolicyStatus);
  const modelPolicyHash = hashModelPolicy(modelPolicy);
  const prompt = await upsertPromptDefinition(db, {
    prompt_id: promptId,
    version: 1,
    name: `AR-2B ${input.suffix} prompt`,
    content: [
      `AR-2B evaluation smoke. ${input.scenarioText}.`,
      'Use the scenario token in this prompt and the user input exactly.',
      input.promptContentSuffix ?? '',
    ].filter(Boolean).join(' '),
    variables: [],
    status: promptStatus,
  }, { tenantId, status: promptStatus, createdBy: userId });
  const promptRecord = must(
    await new PromptDefinitionRepository(db).getByIdAndVersion(promptId, 1, { tenantId }),
    `prompt ${promptId}@1`,
  );
  const agent = await upsertAgentSpec(db, {
    agent_id: agentId,
    version: 1,
    prompt_ref: `${promptId}@1`,
    model_policy: `model_gateway:${input.primaryScenario}`,
    model_policy_ref: {
      model_policy_id: modelPolicy.model_policy_id,
      model_policy_version: modelPolicy.version,
      model_policy_hash: modelPolicyHash,
    },
    allowed_tools: input.allowedTools,
    allowed_handoffs: [],
    max_steps: 4,
    max_tokens: 4000,
    output_schema: 'ar2b_evaluation_smoke_v1',
    status: agentStatus,
  }, { tenantId, status: agentStatus, createdBy: userId });
  const agentRecord = must(
    await new AgentSpecRepository(db).getByIdAndVersion(agentId, 1, { tenantId }),
    `agent ${agentId}@1`,
  );
  const primaryHash = input.subjectType === 'prompt'
    ? promptRecord.sha256
    : input.subjectType === 'agent'
      ? agentRecord.sha256
      : modelPolicyHash;
  const subjectSnapshot = await new EvaluationSubjectSnapshotRepository(db).create(
    await new EvaluationSubjectSnapshotBuilder(db).build({
      tenantId,
      userId,
      requestId: `${requestPrefix}_${input.suffix}_subject`,
      primarySubjectType: input.subjectType,
      primarySubjectId: input.subjectType === 'prompt'
        ? promptId
        : input.subjectType === 'agent'
          ? agentId
          : modelPolicyId,
      primarySubjectVersion: 1,
      primarySubjectHash: primaryHash,
      agentId,
      agentVersion: 1,
      agentHash: agentRecord.sha256,
      promptId,
      promptVersion: 1,
      promptHash: promptRecord.sha256,
      modelPolicyId,
      modelPolicyVersion: 1,
      modelPolicyHash,
    }),
  );
  const executionPlan = await new EvaluationExecutionPlanRepository(db).create(
    await new EvaluationExecutionPlanBuilder(db).build({
      tenantId,
      datasetId: input.datasetId,
      datasetVersion: input.datasetVersion,
      subjectSnapshot,
      evaluationMode: 'model_gateway',
    }),
  );
  return {
    prompt,
    agent,
    modelPolicy,
    subjectSnapshot,
    executionPlan,
  };
}

async function seedTenantPolicy(db: Db): Promise<TenantRuntimePolicy> {
  const repository = new TenantRuntimePolicyRepository(db);
  const existing = await repository.getLatestPublished(tenantId);
  if (existing) {
    return existing;
  }
  const policy = tenantRuntimePolicySchema.parse({
    tenant_id: tenantId,
    version: 1,
    status: 'draft',
    allowed_tools: [
      { tool_name: 'knowledge.search', versions: ['1.0.0'], allowed_operations: ['invoke'], max_risk_level: 'L1' },
      { tool_name: 'record.write.mock', versions: ['1.0.0'], allowed_operations: ['invoke', 'preview', 'commit'], max_risk_level: 'L3' },
    ],
    denied_tools: [],
    allowed_models: [
      { model_id: modelGatewayModel },
      { model_id: 'final_only' },
      { model_id: 'readonly_tool' },
      { model_id: 'model_gateway:final_only' },
      { model_id: 'model_gateway:readonly_tool' },
    ],
    denied_models: [],
    allowed_handoffs: [],
    denied_handoffs: [],
    budget_cap: {
      max_segments: 6,
      max_model_turns: 6,
      max_tool_calls: 4,
      max_total_tokens: 8000,
      max_duration_ms: 300000,
      max_handoffs: 0,
      max_context_bytes: 262144,
    },
    max_concurrent_agent_runs: 4,
  });
  await repository.createDraft(policy, { tenantId, operatorId: userId });
  return repository.publish(tenantId, policy.version, {
    tenantId,
    operatorId: userId,
    releaseNote: 'AR-2B evaluation smoke tenant policy',
  });
}

async function seedTools(
  db: Db,
  allowedTenant: string,
  limits: { knowledgeMaxCalls: number; recordMaxCalls: number },
): Promise<void> {
  const knowledge = await readJson<ToolManifest>('examples/tools/knowledge-search-tool.json');
  const recordWrite = await readJson<ToolManifest>('examples/tools/record-write-mock-tool.json');
  await new ToolManifestRepository(db).upsert({
    ...knowledge,
    evaluation_policy: {
      allowed_in_evaluation: true,
      mode: 'sandbox_commit',
      allowed_tenants: [allowedTenant],
      result_redaction_policy: 'summary_only',
      maximum_calls_per_case: limits.knowledgeMaxCalls,
    },
  }, { tenantId, status: 'published', createdBy: userId });
  await new ToolManifestRepository(db).upsert({
    ...recordWrite,
    evaluation_policy: {
      allowed_in_evaluation: true,
      mode: 'sandbox_commit',
      allowed_tenants: [allowedTenant],
      result_redaction_policy: 'summary_only',
      maximum_calls_per_case: limits.recordMaxCalls,
    },
  }, { tenantId, status: 'published', createdBy: userId });
}

async function seedModelPolicy(db: Db, modelPolicyId: string, status: 'published' | 'validated'): Promise<ModelPolicy> {
  const repository = new ModelPolicyRepository(db);
  const catalog = await ensureModelCatalogEntry(
    db,
    modelGatewayProfile === 'local-mock' && modelGatewayModel === 'dar-local-model'
      ? localMockModelCatalogEntryInput(userId)
      : modelGatewayProfile === 'local-ollama' && modelGatewayModel === LOCAL_OLLAMA_MODEL_ID
        ? localOllamaModelCatalogEntryInput(userId)
      : {
          profileId: modelGatewayProfile,
          displayName: `${modelGatewayProfile} ${modelGatewayModel}`,
          baseUrl: modelGatewayBaseUrl,
          authType: 'none',
          modelId: modelGatewayModel,
          upstreamModelId: modelGatewayModel,
          provider: modelGatewayProfile,
          capabilities: ['text', 'tools', 'usage', 'tool_choice'],
          operatorId: userId,
        },
  );
  const existing = await repository.getByIdAndVersion(modelPolicyId, 1, { tenantId });
  if (existing?.status === status) {
    return existing;
  }
  await repository.createDraft({
    model_policy_id: modelPolicyId,
    version: 1,
    status: 'draft',
    protocol: 'openai_chat_completions',
    targets: [{
      target_id: `${modelPolicyId}_primary`,
      model_ref: catalog.model_ref,
      priority: 0,
      enabled: true,
    }],
    retry_policy: {
      max_attempts_per_target: 1,
      retryable_status_codes: [429, 500, 502, 503, 504],
      retry_on_timeout: true,
      retry_on_network_error: true,
      backoff_ms: 10,
      max_backoff_ms: 50,
    },
    fallback_policy: {
      enabled: false,
      ordered_target_ids: [],
      eligible_error_classes: ['rate_limit', 'timeout', 'network', 'upstream_5xx'],
      stop_on_auth_error: true,
      stop_on_validation_error: true,
      stop_on_policy_denial: true,
    },
    request_policy: {
      temperature: 0,
      top_p: 1,
      max_output_tokens: 1000,
      initial_tool_choice_mode: 'auto',
      after_tool_result_tool_choice_mode: 'none',
      response_format: 'text',
      allow_parallel_tool_calls: false,
    },
    revision: 1,
  }, { tenantId, operatorId: userId });
  if (status === 'validated') {
    return repository.markValidated(modelPolicyId, 1, {
      tenantId,
      operatorId: userId,
    });
  }
  const published = await repository.publish(modelPolicyId, 1, {
    tenantId,
    operatorId: userId,
    releaseNote: 'AR-2B evaluation smoke published model policy',
  });
  return published;
}

async function startAndWaitEvaluationRun(
  plan: EvaluationExecutionPlan,
  dataset: RequiredHashDataset,
  triggerType: 'manual' | 'publish_gate' | 'regression',
  baselineRunId?: string,
): Promise<EvaluationRun> {
  const created = await postJson<EvaluationRunCreateResponse>(
    `${controlPlaneUrl}/api/v1/evaluation-runs`,
    {
      dataset_id: dataset.dataset_id,
      dataset_version: dataset.version,
      dataset_hash: dataset.dataset_hash,
      subject_snapshot_ref: plan.subject_snapshot_ref,
      subject_snapshot_hash: plan.subject_snapshot_hash,
      evaluation_execution_plan_ref: plan.evaluation_execution_plan_ref,
      evaluation_execution_plan_hash: plan.plan_hash,
      trigger_type: triggerType,
      ...(baselineRunId ? { baseline_run_id: baselineRunId } : {}),
    },
    adminHeaders,
  );
  assert.equal(created.workflow_start.started, true);
  assert.equal(created.workflow_start.mode, 'temporal');
  return pollEvaluationRun(created.evaluation_run.evaluation_run_id);
}

async function pollEvaluationRun(runId: string): Promise<EvaluationRun> {
  const deadline = Date.now() + timeoutMs;
  let last: EvaluationRun | undefined;
  while (Date.now() < deadline) {
    last = await getJson<EvaluationRun>(
      `${controlPlaneUrl}/api/v1/evaluation-runs/${encodeURIComponent(runId)}`,
      auditorHeaders,
    );
    if (['completed', 'failed', 'cancelled'].includes(last.status)) {
      assert.equal(last.status, 'completed', last.error_message ?? `EvaluationRun ${runId} did not complete`);
      return last;
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for EvaluationRun ${runId}; last=${last?.status ?? 'unknown'}`);
}

async function getRunResults(runId: string): Promise<EvaluationCaseResult[]> {
  const response = await getJson<{ evaluation_run_id: string; results: EvaluationCaseResult[] }>(
    `${controlPlaneUrl}/api/v1/evaluation-runs/${encodeURIComponent(runId)}/results`,
    auditorHeaders,
  );
  return response.results;
}

async function assertFrameworkEvidence(
  db: Db,
  run: EvaluationRun,
  results: EvaluationCaseResult[],
): Promise<Record<string, unknown>> {
  const taskRunIds = results.map((result) => result.task_run_id).filter((value): value is string => Boolean(value));
  const agentRunIds = results.map((result) => result.agent_run_id).filter((value): value is string => Boolean(value));
  const modelCallIds = [...new Set(results.flatMap((result) => result.model_call_ids))];
  const toolCallIds = [...new Set(results.flatMap((result) => result.tool_call_ids))];
  assert.ok(taskRunIds.length >= results.length, 'each case must have a TaskRun ref');
  assert.ok(agentRunIds.length >= results.filter((result) => result.status !== 'system_error').length, 'non-system-error cases must have AgentRun refs');
  assert.ok(modelCallIds.length > 0, 'evaluation evidence must include model_call refs');
  assert.ok(toolCallIds.length > 0, 'evaluation evidence must include tool_call refs');
  for (const result of results) {
    assert.ok(result.workflow_id, `case ${result.case_id} must record workflow_id`);
    assert.ok(result.workflow_run_id, `case ${result.case_id} must record workflow_run_id`);
    const evidence = result.evidence_snapshot as Record<string, unknown> | undefined;
    assert.ok(evidence, `case ${result.case_id} must store evidence_snapshot`);
    assert.equal(evidence.completeness_status, 'complete', `case ${result.case_id} evidence must be complete`);
    const refs = evidence.refs as Record<string, unknown>;
    assert.equal(typeof refs.task_run_id, 'string', 'evidence must include task_run ref');
    if (result.status !== 'system_error') {
      assert.equal(typeof refs.agent_run_id, 'string', 'non-system-error evidence must include agent_run ref');
    }
    assert.ok(Array.isArray(refs.agent_step_ids), 'evidence must include agent_step refs');
    assert.ok(Array.isArray(refs.model_call_ids), 'evidence must include model_call refs');
    assert.ok(Array.isArray(refs.model_call_attempt_ids), 'evidence must include model_call_attempt refs');
    assert.ok(Array.isArray(refs.tool_call_ids), 'evidence must include tool_call refs array');
    assert.ok(Array.isArray(refs.human_task_ids), 'evidence must include human_task refs array');
    assert.ok(Array.isArray(refs.audit_event_ids), 'evidence must include audit refs');
    assert.ok(Array.isArray(refs.idempotency_record_ids), 'evidence must include idempotency refs array');
    if (result.status !== 'system_error') {
      assert.equal(typeof evidence.final_output_ref, 'string', 'evidence must include final_output_ref');
    }
    assert.equal(typeof evidence.duplicate_tool_call_count, 'number');
    assert.equal(typeof evidence.duplicate_commit_count, 'number');
    assert.equal(typeof evidence.side_effect_without_approval_count, 'number');
    assert.equal(typeof evidence.secret_leak_count, 'number');
    assert.equal(typeof evidence.hidden_reasoning_leak_count, 'number');
    assert.ok(evidence.tokens && typeof evidence.tokens === 'object', 'evidence must include token summary object');
    assert.ok(evidence.cost && typeof evidence.cost === 'object', 'evidence must include cost object');
    assert.equal((evidence.tokens as Record<string, unknown>).total !== undefined || result.status === 'system_error', true);
    assert.equal(evidence.secret_leak_count, 0, 'secret leak count must be explicit zero');
    assert.equal(evidence.hidden_reasoning_leak_count, 0, 'hidden reasoning leak count must be explicit zero');
  }
  const toolCalls = await new ToolCallLogRepository(db).list({ tenantId, evaluationRunId: run.evaluation_run_id, limit: 100 });
  assert.ok(toolCalls.every((call) => call.execution_context_type === 'evaluation'), 'Tool calls must be marked as evaluation context');
  assert.ok(toolCalls.every((call) => call.evaluation_execution_plan_ref === run.evaluation_execution_plan_ref), 'Tool calls must use exact evaluation plan ref');
  const auditEvents = await new AuditEventRepository(db).list({ tenantId, limit: 200 });
  assert.ok(auditEvents.some((event) => event.action === 'evaluation.gate.passed' || event.action === 'evaluation.gate.failed'), 'gate audit must exist');
  if (!usesOllamaModelGateway()) {
    assert.ok(results.some((result) => result.status === 'system_error'), 'framework smoke must keep system_error separate');
  }
  assert.ok(results.some((result) => result.status === 'failed' && result.system_error_class === undefined), 'framework smoke must include candidate failure separate from system_error');
  assertNoUnsafeText(JSON.stringify(results));
  return {
    task_runs: taskRunIds.length,
    agent_runs: agentRunIds.length,
    model_calls: modelCallIds.length,
    tool_calls: toolCallIds.length,
    case_workflows: results.filter((result) => Boolean(result.workflow_id)).length,
  };
}

async function runPostgresReservationEvidence(
  db: Db,
  plan: EvaluationExecutionPlan,
): Promise<Record<string, unknown>> {
  const dbA = createDb({ databaseUrl, maxConnections: 2 });
  const dbB = createDb({ databaseUrl, maxConnections: 2 });
  const runId = `reservation_run_${runStamp}`;
  const caseId = `reservation_case_${runStamp}`;
  const toolName = 'knowledge.search';
  try {
    await sql`delete from evaluation_tool_call_reservation where tenant_id = ${tenantId} and evaluation_run_id = ${runId}`.execute(db);
    const stores = [new ToolCallLogRepository(dbA), new ToolCallLogRepository(dbB)];
    const reservationInputs = Array.from({ length: 20 }, (_, index) => ({
        tenantId,
        evaluationRunId: runId,
        evaluationCaseId: caseId,
        toolName,
        toolVersion: '1.0.0',
        logicalToolCallId: `logical_${index}`,
        operation: 'invoke',
        limit: 1,
        idempotencyKey: `idem_${index}`,
      } as const));
    const responses = await Promise.all(reservationInputs.map((input, index) =>
      stores[index % 2]!.reserveEvaluationLogicalCall(input),
    ));
    assert.equal(responses.filter((item) => item.allowed).length, 1);
    assert.equal(responses.filter((item) => !item.allowed).length, 19);
    const allowedIndex = responses.findIndex((item) => item.allowed);
    assert.notEqual(allowedIndex, -1, 'reservation retry requires the logical call that actually acquired the slot');
    const allowedInput = reservationInputs[allowedIndex]!;
    const retry = await stores[0]!.reserveEvaluationLogicalCall({
      tenantId,
      evaluationRunId: runId,
      evaluationCaseId: caseId,
      toolName,
      toolVersion: '1.0.0',
      logicalToolCallId: allowedInput.logicalToolCallId,
      operation: 'invoke',
      limit: 1,
      idempotencyKey: `${allowedInput.idempotencyKey}_retry`,
    });
    assert.equal(retry.allowed, true);
    assert.equal(retry.alreadyReserved, true);
    const previewCommitRunId = `${runId}_preview_commit`;
    const preview = await stores[0]!.reserveEvaluationLogicalCall({
      tenantId,
      evaluationRunId: previewCommitRunId,
      evaluationCaseId: caseId,
      toolName,
      toolVersion: '1.0.0',
      logicalToolCallId: 'tool_call_preview_commit',
      operation: 'preview',
      limit: 1,
      idempotencyKey: 'preview_commit_preview',
    });
    const commit = await stores[1]!.reserveEvaluationLogicalCall({
      tenantId,
      evaluationRunId: previewCommitRunId,
      evaluationCaseId: caseId,
      toolName,
      toolVersion: '1.0.0',
      logicalToolCallId: 'tool_call_preview_commit',
      operation: 'commit',
      limit: 1,
      idempotencyKey: 'preview_commit_commit',
    });
    assert.equal(preview.allowed, true);
    assert.equal(commit.allowed, true);
    assert.equal(commit.alreadyReserved, true, 'preview + commit with same tool_call_id must only reserve once');
    const distinctA = await stores[0]!.reserveEvaluationLogicalCall({
      tenantId,
      evaluationRunId: `${runId}_distinct`,
      evaluationCaseId: caseId,
      toolName,
      toolVersion: '1.0.0',
      logicalToolCallId: 'tool_call_distinct_a',
      operation: 'invoke',
      limit: 2,
    });
    const distinctB = await stores[1]!.reserveEvaluationLogicalCall({
      tenantId,
      evaluationRunId: `${runId}_distinct`,
      evaluationCaseId: caseId,
      toolName,
      toolVersion: '1.0.0',
      logicalToolCallId: 'tool_call_distinct_b',
      operation: 'invoke',
      limit: 2,
    });
    const distinctDenied = await stores[0]!.reserveEvaluationLogicalCall({
      tenantId,
      evaluationRunId: `${runId}_distinct`,
      evaluationCaseId: caseId,
      toolName,
      toolVersion: '1.0.0',
      logicalToolCallId: 'tool_call_distinct_c',
      operation: 'invoke',
      limit: 2,
    });
    assert.equal(distinctA.allowed, true);
    assert.equal(distinctB.allowed, true);
    assert.equal(distinctDenied.allowed, false);
    const otherTenant = await stores[1]!.reserveEvaluationLogicalCall({
      tenantId: `${tenantId}_other`,
      evaluationRunId: runId,
      evaluationCaseId: caseId,
      toolName,
      toolVersion: '1.0.0',
      logicalToolCallId: 'logical_other',
      operation: 'invoke',
      limit: 1,
      idempotencyKey: 'idem_other',
    });
    assert.equal(otherTenant.allowed, true);
    await db.transaction().execute(async (trx) => {
      await new ToolCallLogRepository(trx).reserveEvaluationLogicalCall({
        tenantId,
        evaluationRunId: runId,
        evaluationCaseId: `${caseId}_rollback`,
        toolName,
        toolVersion: '1.0.0',
        logicalToolCallId: 'rollback',
        operation: 'invoke',
        limit: 1,
      });
      throw new RollbackProbe();
    }).catch((error: unknown) => {
      if (!(error instanceof RollbackProbe)) {
        throw error;
      }
    });
    const rollbackCount = await sql<{ count: string }>`select count(*)::text as count from evaluation_tool_call_reservation where tenant_id = ${tenantId} and evaluation_case_id = ${`${caseId}_rollback`}`.execute(db);
    assert.equal(Number(rollbackCount.rows[0]?.count ?? 0), 0, 'transaction rollback must not leak reservation');
    const countRows = await sql<{ count: string }>`select count(*)::text as count from evaluation_tool_call_reservation where tenant_id = ${tenantId} and evaluation_run_id = ${runId} and evaluation_case_id = ${caseId} and tool_name = ${toolName}`.execute(db);
    return {
      concurrent_requests: 20,
      allowed: responses.filter((item) => item.allowed).length,
      denied: responses.filter((item) => !item.allowed).length,
      retry_already_reserved: retry.alreadyReserved,
      preview_commit_single_count: commit.alreadyReserved,
      distinct_tool_call_ids_counted: distinctDenied.currentCount,
      cross_tenant_independent: otherTenant.allowed,
      rollback_rows: Number(rollbackCount.rows[0]?.count ?? 0),
      persisted_rows: Number(countRows.rows[0]?.count ?? 0),
      plan_ref: plan.evaluation_execution_plan_ref,
    };
  } finally {
    await closeDb(dbA);
    await closeDb(dbB);
  }
}

class RollbackProbe extends Error {}

async function assertToolGatewayRedaction(
  run: EvaluationRun,
  results: EvaluationCaseResult[],
): Promise<Record<string, unknown>> {
  const toolCallIds = results.flatMap((result) => result.tool_call_ids);
  assert.ok(toolCallIds.length > 0, 'redaction check requires real tool calls');
  const list = await getJson<ToolCallLog[]>(
    `${toolGatewayUrl}/v1/tool-calls?tenant_id=${encodeURIComponent(tenantId)}&page_size=100`,
    toolReadHeaders(),
  );
  const matched = list.filter((call) => call.evaluation_run_id === run.evaluation_run_id);
  assert.ok(matched.length > 0, 'Tool Gateway must expose evaluation tool call logs');
  const text = JSON.stringify(matched);
  assertNoUnsafeText(text);
  assert.ok(matched.every((call) => call.result_json === undefined || !JSON.stringify(call.result_json).includes('Authorization')), 'tool result must be redacted');
  return {
    tool_calls: matched.length,
    result_refs_only_in_evidence: results.every((result) => {
      const evidence = result.evidence_snapshot as Record<string, unknown> | undefined;
      return !evidence || Array.isArray(evidence.tool_result_refs);
    }),
  };
}

async function assertToolGatewayEvaluationPolicy(
  db: Db,
  plan: EvaluationExecutionPlan,
): Promise<Record<string, unknown>> {
  const evaluationContext = {
    tenant_policy_snapshot_ref: plan.tenant_policy_snapshot_ref,
    tenant_policy_hash: plan.tenant_policy_snapshot_hash,
    execution_plan_ref: plan.agent_execution_plan_ref,
    execution_plan_hash: plan.agent_execution_plan_hash,
    execution_context_type: 'evaluation' as const,
    evaluation_run_id: `http_policy_run_${runStamp}`,
    evaluation_case_id: `http_policy_case_${runStamp}`,
    evaluation_execution_plan_ref: plan.evaluation_execution_plan_ref,
    evaluation_execution_plan_hash: plan.plan_hash,
  };
  const readonly = await postTool<ToolInvokeResponse>(`/v1/tools/knowledge.search/invoke`, {
    ...baseToolRequest('knowledge.search', '1.0.0', {
      query: 'mask Authorization header fields',
    }, 'readonly'),
    ...evaluationContext,
  });
  assert.equal(readonly.status, 'succeeded', 'readonly evaluation invoke must be allowed');

  let sandboxPreviewStatus: string | undefined;
  let sandboxInvokeStatus: string | undefined;
  let sandboxInvokeReason: string | undefined;
  if (!usesOllamaModelGateway()) {
    const sandboxPreview = await postTool<ToolPreviewResponse>(`/v1/tools/record.write.mock/preview`, {
      ...baseToolRequest('record.write.mock', '1.0.0', { record: { summary: 'sandbox preview' } }, 'sandbox_preview'),
      ...evaluationContext,
      evaluation_case_id: `http_policy_record_case_${runStamp}`,
    });
    assert.ok(['allowed', 'pending_confirmation'].includes(sandboxPreview.status), 'sandbox preview must reach preview path');
    const sandboxInvoke = await postTool<ToolInvokeResponse>(`/v1/tools/record.write.mock/invoke`, {
      ...baseToolRequest('record.write.mock', '1.0.0', { record: { summary: 'business commit deny' } }, 'business_commit'),
      ...evaluationContext,
      evaluation_case_id: `http_policy_record_invoke_case_${runStamp}`,
    });
    assert.equal(sandboxInvoke.status, 'needs_confirmation', 'business L3 invoke must not auto-commit');
    assert.equal(sandboxInvoke.error?.code, 'HUMAN_CONFIRMATION_REQUIRED', 'business L3 invoke must require human confirmation');
    sandboxPreviewStatus = sandboxPreview.status;
    sandboxInvokeStatus = sandboxInvoke.status;
    sandboxInvokeReason = sandboxInvoke.error?.code;
  }

  const maxLimitFirst = await postTool<ToolInvokeResponse>(`/v1/tools/knowledge.search/invoke`, {
    ...baseToolRequest('knowledge.search', '1.0.0', { query: 'limit one' }, 'limit_1'),
    ...evaluationContext,
    evaluation_case_id: `http_policy_limit_case_${runStamp}`,
  });
  assert.equal(maxLimitFirst.status, 'succeeded');
  const maxLimitDenied = await postToolExpectError(`/v1/tools/knowledge.search/invoke`, {
    ...baseToolRequest('knowledge.search', '1.0.0', { query: 'limit two' }, 'limit_2'),
    ...evaluationContext,
    evaluation_case_id: `http_policy_limit_case_${runStamp}`,
  });
  assert.equal(maxLimitDenied.error?.code, 'TOOL_EVALUATION_CALL_LIMIT_EXCEEDED');

  const crossTenantDenied = await postToolExpectError(`/v1/tools/knowledge.search/invoke`, {
    ...baseToolRequest('knowledge.search', '1.0.0', { query: 'cross tenant' }, 'cross_tenant'),
    ...evaluationContext,
    tenant_id: `${tenantId}_not_allowed`,
  });
  assert.equal(crossTenantDenied.error?.code, 'TOOL_NOT_FOUND', 'cross-tenant requests must not resolve another tenant tool registry entry');

  const redacted = must(
    readonly.tool_call_id
      ? await getJson<ToolCallLog>(`${toolGatewayUrl}/v1/tool-calls/${encodeURIComponent(readonly.tool_call_id)}`, toolReadHeaders())
      : undefined,
    'readonly tool call log',
  );
  assertNoUnsafeText(JSON.stringify(redacted));

  return {
    readonly: readonly.status,
    sandbox_commit_preview: sandboxPreviewStatus ?? 'covered_by_ollama_evaluation_smoke',
    business_commit_denied: sandboxInvokeStatus ?? 'covered_by_ollama_evaluation_smoke',
    business_commit_reason: sandboxInvokeReason ?? 'covered_by_ollama_evaluation_smoke',
    max_calls_denied: maxLimitDenied.error?.code,
    cross_tenant_denied: crossTenantDenied.error?.code,
    redaction_checked: Boolean(readonly.tool_call_id),
  };
}

async function findGateDecision(
  db: Db,
  resourceType: SubjectType,
  resourceId: string,
  resourceVersion: number,
  candidateBundleHash: string,
) {
  const decisions = await new EvaluationGateDecisionRepository(db).listForResource({
    resourceType,
    resourceId,
    resourceVersion,
    limit: 20,
  });
  return decisions.find((decision) => decision.candidate_bundle_hash === candidateBundleHash);
}

async function waitForComparison(db: Db, candidateRunId: string, baselineRunId: string): Promise<EvaluationComparison> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db
      .selectFrom('evaluation_comparison')
      .selectAll()
      .where('candidate_run_id', '=', candidateRunId)
      .where('baseline_run_id', '=', baselineRunId)
      .executeTakeFirst();
    if (row) {
      const result = row.result_json as Record<string, unknown>;
      return {
        comparison_id: row.comparison_id,
        candidate_run_id: row.candidate_run_id,
        baseline_run_id: row.baseline_run_id,
        comparable: row.comparable,
        dataset_id: row.dataset_id,
        dataset_version: row.dataset_version,
        dataset_hash: row.dataset_hash,
        newly_failed_cases: arrayOfStrings(result.newly_failed_cases),
        newly_passed_cases: arrayOfStrings(result.newly_passed_cases),
        unchanged_failures: arrayOfStrings(result.unchanged_failures),
        regression_severity: String(result.regression_severity ?? 'none') as EvaluationComparison['regression_severity'],
        reasons: arrayOfStrings(result.reasons),
        result,
        ...(typeof result.pass_rate_delta === 'number' ? { pass_rate_delta: result.pass_rate_delta } : {}),
        ...(typeof result.overall_score_delta === 'number' ? { overall_score_delta: result.overall_score_delta } : {}),
      };
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for comparison ${candidateRunId} vs ${baselineRunId}`);
}

async function cloneAndChangePrompt(promptId: string): Promise<PromptDefinition> {
  const cloned = await postJson<RegistryRecord<PromptDefinition>>(
    `${controlPlaneUrl}/api/v1/prompts/${encodeURIComponent(promptId)}/versions/1/clone`,
    {},
    operatorHeaders,
  );
  const updated = await postJson<RegistryRecord<PromptDefinition>>(
    `${controlPlaneUrl}/api/v1/prompts/${encodeURIComponent(promptId)}/versions/${cloned.version}`,
    {
      spec: {
        ...cloned.spec,
        content: `${cloned.spec.content}\nChanged after gate decision ${runStamp}.`,
      },
      expected_revision: cloned.revision,
    },
    operatorHeaders,
    'PUT',
  );
  return {
    ...updated.spec,
    sha256: updated.sha256,
  };
}

async function createOverride(decisionId: string, resourceHash: string, reason: string): Promise<EvaluationGateOverride> {
  return postJson<EvaluationGateOverride>(
    `${controlPlaneUrl}/api/v1/evaluation-gate-decisions/${encodeURIComponent(decisionId)}/override`,
    {
      resource_hash: resourceHash,
      reason,
      scope: 'single_resource_hash',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    adminHeaders,
  );
}

async function expectOverrideForbidden(decisionId: string, resourceHash: string): Promise<void> {
  const response = await fetch(`${controlPlaneUrl}/api/v1/evaluation-gate-decisions/${encodeURIComponent(decisionId)}/override`, {
    method: 'POST',
    headers: { ...operatorHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      resource_hash: resourceHash,
      reason: 'operator forbidden override smoke',
      scope: 'single_resource_hash',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  });
  assert.equal(response.status, 403, `capability_operator override must be forbidden: ${await response.text()}`);
}

async function publishResource(
  plural: string,
  resourceId: string,
  version: number,
  releaseNote: string,
  gate: {
    evaluation_candidate_bundle_hash: string;
    evaluation_gate_decision_id?: string;
    evaluation_gate_override_id?: string;
  },
): Promise<CapabilityRelease> {
  return postJson<CapabilityRelease>(
    `${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/publish`,
    {
      release_note: releaseNote,
      ...gate,
    },
    adminHeaders,
  );
}

async function expectPublishBlocked(
  plural: string,
  resourceId: string,
  version: number,
  releaseNote: string,
  gate: {
    evaluation_candidate_bundle_hash: string;
    evaluation_gate_decision_id?: string;
    evaluation_gate_override_id?: string;
  },
): Promise<void> {
  const response = await fetch(`${controlPlaneUrl}/api/v1/${plural}/${encodeURIComponent(resourceId)}/versions/${version}/publish`, {
    method: 'POST',
    headers: { ...adminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ release_note: releaseNote, ...gate }),
  });
  assert.ok([400, 409, 422].includes(response.status), `stale publish must fail closed: ${response.status} ${await response.text()}`);
}

async function createExpiredOverride(
  db: Db,
  decision: NonNullable<Awaited<ReturnType<typeof findGateDecision>>>,
): Promise<EvaluationGateOverride> {
  return new EvaluationGateOverrideRepository(db).create({
    override_id: `eval_gate_override_expired_${runStamp}`,
    gate_decision_id: decision.gate_decision_id,
    resource_type: decision.resource_type,
    resource_id: decision.resource_id,
    resource_version: decision.resource_version,
    resource_hash: decision.resource_hash,
    operator_id: userId,
    reason: 'AR-2B smoke expired exact hash override',
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    created_at: new Date(Date.now() - 120_000).toISOString(),
  });
}

function assertCaseStatuses(results: EvaluationCaseResult[], expected: Record<string, EvaluationCaseResult['status']>): void {
  for (const [suffix, status] of Object.entries(expected)) {
    const result = results.find((entry) => entry.case_id.endsWith(suffix));
    assert.ok(result, `Missing case result for ${suffix}`);
    assert.equal(result.status, status, `Unexpected status for ${suffix}`);
  }
}

function summaryRun(
  name: string,
  run: EvaluationRun,
  candidate: CandidateResources,
  results: EvaluationCaseResult[],
) {
  return {
    name,
    evaluation_run_id: run.evaluation_run_id,
    ...(run.workflow_id ? { workflow_id: run.workflow_id } : {}),
    ...(run.workflow_run_id ? { workflow_run_id: run.workflow_run_id } : {}),
    status: run.status,
    candidate_bundle_hash: candidate.subjectSnapshot.candidate_bundle_hash,
    subject_snapshot_ref: candidate.subjectSnapshot.subject_snapshot_ref,
    evaluation_execution_plan_ref: candidate.executionPlan.evaluation_execution_plan_ref,
    case_workflows: results.map((result) => ({
      case_id: result.case_id,
      ...(result.workflow_id ? { workflow_id: result.workflow_id } : {}),
      ...(result.workflow_run_id ? { workflow_run_id: result.workflow_run_id } : {}),
      status: result.status,
    })),
  };
}

function summaryDecision(name: string, decision: NonNullable<Awaited<ReturnType<typeof findGateDecision>>>) {
  return {
    name,
    gate_decision_id: decision.gate_decision_id,
    decision: decision.decision,
    candidate_bundle_hash: decision.candidate_bundle_hash,
  };
}

async function assertServicesReady(): Promise<void> {
  await checkHealth(`${controlPlaneUrl}/healthz`, 'control-plane healthz');
  await checkHealth(`${controlPlaneUrl}/readyz`, 'control-plane readyz');
  await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api healthz');
  await checkHealth(`${runtimeApiUrl}/readyz`, 'runtime-api readyz');
  await checkHealth(`${toolGatewayUrl}/healthz`, 'tool-gateway healthz');
  await checkHealth(`${toolGatewayUrl}/readyz`, 'tool-gateway readyz');
  await checkHealth(`${runtimeWorkerUrl}/healthz`, 'runtime-worker healthz');
  await checkHealth(`${runtimeWorkerUrl}/readyz`, 'runtime-worker readyz');
}

async function assertWorkerUsesModelGateway(): Promise<void> {
  const response = await fetch(`${runtimeWorkerUrl}/readyz`);
  const body = await response.json() as {
    checks?: {
      pi_agent_mode?: string;
      model_gateway_profile?: string;
      model_gateway_model?: string;
      evaluation_worker_enabled?: boolean;
      evaluation_worker_status?: string;
      evaluation_task_queue?: string;
      task_queues?: string[];
    };
  };
  ({
    profile: modelGatewayProfile,
    model: modelGatewayModel,
    baseUrl: modelGatewayBaseUrl,
  } = applySmokeModelGatewayReadiness(
    {
      profile: modelGatewayProfile,
      model: modelGatewayModel,
      baseUrl: modelGatewayBaseUrl,
    },
    body.checks,
  ));
  assert.equal(body.checks?.pi_agent_mode, 'model_gateway', 'Evaluation backend smoke requires runtime-worker PI_AGENT_MODE=model_gateway');
  assert.equal(
    body.checks?.evaluation_worker_enabled,
    true,
    'Evaluation backend smoke requires runtime-worker EVALUATION_WORKER_ENABLED=true',
  );
  assert.equal(
    body.checks?.evaluation_worker_status,
    'running',
    'Evaluation backend smoke requires the evaluation Temporal worker to be running',
  );
  assert.ok(
    body.checks?.evaluation_task_queue && body.checks?.task_queues?.includes(body.checks.evaluation_task_queue),
    'Evaluation backend smoke requires runtime-worker to poll the configured EVALUATION_TASK_QUEUE',
  );
}

async function checkHealth(url: string, label: string): Promise<void> {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${label} failed: ${response.status} ${await response.text()}`);
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers });
  const body = await response.json() as StandardResponse<T>;
  if (!response.ok || body.success !== true) {
    throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  method = 'POST',
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json() as StandardResponse<T>;
  if (!response.ok || body.success !== true) {
    throw new Error(`${method} ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function postTool<T>(path: string, payload: unknown): Promise<T> {
  return postJson<T>(`${toolGatewayUrl}${path}`, payload, toolInvokeHeaders());
}

async function postToolExpectError(path: string, payload: unknown): Promise<StandardResponse<never>> {
  const response = await fetch(`${toolGatewayUrl}${path}`, {
    method: 'POST',
    headers: { ...toolInvokeHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json() as StandardResponse<never>;
  assert.equal(body.success, false, `Expected Tool Gateway error for ${path}, got ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function baseToolRequest(
  toolName: string,
  toolVersion: string,
  args: Record<string, unknown>,
  idempotencySuffix: string,
): Record<string, unknown> {
  return {
    tool_name: toolName,
    tool_version: toolVersion,
    tenant_id: tenantId,
    user_context: { user_id: userId },
    task_context: {
      task_run_id: `tool_policy_task_${runStamp}_${idempotencySuffix}`,
      workflow_id: `tool_policy_workflow_${runStamp}`,
    },
    arguments: args,
    idempotency_key: `${requestPrefix}_${idempotencySuffix}`,
    request_id: `${requestPrefix}_${idempotencySuffix}`,
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(repoRoot, path), 'utf8')) as T;
}

function toolReadHeaders(): Record<string, string> {
  return {
    'x-service-id': 'control-plane',
    authorization: `Bearer ${process.env.TOOL_GATEWAY_CONTROL_PLANE_TOKEN ?? 'dev-only-control-plane-token'}`,
    'x-request-id': `${requestPrefix}_tool_gateway_query`,
  };
}

function toolInvokeHeaders(): Record<string, string> {
  return {
    'x-service-id': 'runtime-worker',
    authorization: `Bearer ${process.env.TOOL_GATEWAY_RUNTIME_WORKER_TOKEN ?? 'dev-only-runtime-worker-token'}`,
    'x-request-id': `${requestPrefix}_tool_gateway_invoke`,
  };
}

function authHeaders(role: string, requestId: string): Record<string, string> {
  return {
    'x-user-id': userId,
    'x-tenant-id': tenantId,
    'x-roles': role,
    'x-request-id': requestId,
  };
}

function scenarioFromEnv(): Scenario {
  const value = process.env.EVALUATION_SMOKE_SCENARIO ?? 'framework';
  if (value === 'framework' || value === 'regression' || value === 'publish_gate') {
    return value;
  }
  throw new Error(`Unsupported EVALUATION_SMOKE_SCENARIO: ${value}`);
}

function usesOllamaModelGateway(): boolean {
  return modelGatewayProfile === 'local-ollama';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '');
}

function must<T>(value: T | undefined | null, label: string): T {
  assert.ok(value, `${label} not found`);
  return value;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function assertNoUnsafeText(text: string): void {
  const forbidden = [
    /Bearer\s+[A-Za-z0-9_.-]+/iu,
    /"authorization"\s*:/iu,
    /"(?:api[_-]?key|token|password|secret)"\s*:\s*"[^"]{4,}"/iu,
    /(?:API_KEY|TOKEN|PASSWORD|SECRET)=\S{4,}/u,
    /hidden[_ -]?chain[_ -]?of[_ -]?thought/iu,
    /"hidden_reasoning"\s*:\s*"[^"]+"/iu,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(text), false, `Unsafe text matched ${pattern}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
