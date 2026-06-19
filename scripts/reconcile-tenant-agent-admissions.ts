import { Client, Connection, WorkflowNotFoundError } from '@temporalio/client';
import {
  AuditEventRepository,
  closeDb,
  createDb,
  TaskRunRepository,
  TenantAgentAdmissionRepository,
} from '@dar/db';
import type { TenantAgentAdmission } from '@dar/contracts';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const temporalAddress = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const temporalNamespace = process.env.TEMPORAL_NAMESPACE ?? 'default';

interface CliOptions {
  dryRun: boolean;
  tenantId?: string;
  batchSize: number;
  staleAfterMs: number;
}

interface ReconcileItem {
  admission_id: string;
  tenant_id: string;
  task_run_id: string;
  workflow_id?: string;
  workflow_run_id?: string;
  action: 'skipped' | 'would_reconcile' | 'reconciled';
  reason: string;
  workflow_status?: string;
  task_status?: string;
}

const terminalWorkflowStatuses = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT']);
const terminalTaskStatuses = new Set(['completed', 'failed']);

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const db = createDb({ databaseUrl });
  try {
    const admissionRepository = new TenantAgentAdmissionRepository(db);
    const taskRepository = new TaskRunRepository(db);
    const auditRepository = new AuditEventRepository(db);
    const temporal = await connectTemporal();
    const staleBefore = new Date(Date.now() - options.staleAfterMs).toISOString();
    const candidates = await admissionRepository.reconcileCandidates({
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      staleBefore,
      limit: options.batchSize,
    });

    const items: ReconcileItem[] = [];
    for (const admission of candidates) {
      const decision = await decide(admission, taskRepository, temporal);
      if (decision.action === 'would_reconcile' && !options.dryRun) {
        await admissionRepository.markReconciled(admission.admission_id, decision.reason);
        await auditRepository.append({
          tenant_id: admission.tenant_id,
          actor_id: 'system:admission-reconcile',
          action: 'agent.admission.reconciled',
          target_type: 'tenant_agent_admission',
          target_id: admission.admission_id,
          result: 'succeeded',
          reason: decision.reason,
          payload: {
            tenant_id: admission.tenant_id,
            task_run_id: admission.task_run_id,
            workflow_id: admission.workflow_id,
            workflow_run_id: admission.workflow_run_id,
            admission_id: admission.admission_id,
            workflow_status: decision.workflow_status,
            task_status: decision.task_status,
          },
        });
        items.push({ ...decision, action: 'reconciled' });
      } else {
        items.push(decision);
      }
    }

    console.log(JSON.stringify({
      ok: true,
      dry_run: options.dryRun,
      stale_before: staleBefore,
      checked: candidates.length,
      reconciled: items.filter((item) => item.action === 'reconciled').length,
      would_reconcile: items.filter((item) => item.action === 'would_reconcile').length,
      skipped: items.filter((item) => item.action === 'skipped').length,
      items,
    }, null, 2));
  } finally {
    await closeDb(db);
  }
}

async function decide(
  admission: TenantAgentAdmission,
  taskRepository: TaskRunRepository,
  temporal: Client | undefined,
): Promise<ReconcileItem> {
  const base = {
    admission_id: admission.admission_id,
    tenant_id: admission.tenant_id,
    task_run_id: admission.task_run_id,
    ...(admission.workflow_id ? { workflow_id: admission.workflow_id } : {}),
    ...(admission.workflow_run_id ? { workflow_run_id: admission.workflow_run_id } : {}),
  };
  const task = await taskRepository.get(admission.task_run_id);
  const taskStatus = task?.status;
  const workflowStatus = admission.workflow_id && temporal
    ? await describeWorkflowStatus(temporal, admission.workflow_id, admission.workflow_run_id)
    : undefined;

  if (workflowStatus && workflowStatus.status === 'open') {
    return { ...base, action: 'skipped', reason: 'workflow_open', workflow_status: workflowStatus.name, ...(taskStatus ? { task_status: taskStatus } : {}) };
  }
  if (workflowStatus && workflowStatus.status === 'closed') {
    return { ...base, action: 'would_reconcile', reason: `workflow_${workflowStatus.name.toLowerCase()}`, workflow_status: workflowStatus.name, ...(taskStatus ? { task_status: taskStatus } : {}) };
  }
  if (workflowStatus && workflowStatus.status === 'unknown') {
    return { ...base, action: 'skipped', reason: workflowStatus.reason, workflow_status: workflowStatus.name, ...(taskStatus ? { task_status: taskStatus } : {}) };
  }
  if (terminalTaskStatuses.has(taskStatus ?? '')) {
    return { ...base, action: 'would_reconcile', reason: 'terminal_task_without_workflow', ...(taskStatus ? { task_status: taskStatus } : {}) };
  }
  return { ...base, action: 'skipped', reason: task ? 'task_not_terminal' : 'task_not_found', ...(taskStatus ? { task_status: taskStatus } : {}) };
}

async function connectTemporal(): Promise<Client | undefined> {
  try {
    const connection = await Connection.connect({ address: temporalAddress });
    return new Client({ connection, namespace: temporalNamespace });
  } catch {
    return undefined;
  }
}

async function describeWorkflowStatus(
  client: Client,
  workflowId: string,
  runId?: string,
): Promise<{ status: 'open' | 'closed' | 'unknown'; name: string; reason: string }> {
  try {
    const description = await client.workflow.getHandle(workflowId, runId).describe();
    const name = description.status.name;
    if (name === 'RUNNING') {
      return { status: 'open', name, reason: 'workflow_open' };
    }
    if (terminalWorkflowStatuses.has(name)) {
      return { status: 'closed', name, reason: `workflow_${name.toLowerCase()}` };
    }
    return { status: 'unknown', name, reason: `workflow_status_${name.toLowerCase()}` };
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      return { status: 'unknown', name: 'NOT_FOUND', reason: 'workflow_not_found' };
    }
    return { status: 'unknown', name: 'DESCRIBE_FAILED', reason: 'workflow_describe_failed' };
  }
}

function parseOptions(args: string[]): CliOptions {
  const dryRun = !args.includes('--apply');
  const tenantId = readFlag(args, '--tenant');
  return {
    dryRun,
    ...(tenantId ? { tenantId } : {}),
    batchSize: readPositiveInt(readFlag(args, '--batch-size') ?? process.env.TENANT_ADMISSION_MAX_RECONCILE_BATCH, 100),
    staleAfterMs: readPositiveInt(readFlag(args, '--stale-after-ms') ?? process.env.TENANT_ADMISSION_STALE_AFTER_MS, 30 * 60 * 1000),
  };
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : 'admission reconcile failed',
  }, null, 2));
  process.exitCode = 1;
});
