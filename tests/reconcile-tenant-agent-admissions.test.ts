import { describe, expect, it } from 'vitest';
import type { TenantAgentAdmission } from '@dar/contracts';
import {
  decideAdmissionReconcile,
  parseOptions,
  type ReconcileTaskLookup,
  type ReconcileWorkflowLookup,
  type ReconcileWorkflowStatus,
} from '../scripts/reconcile-tenant-agent-admissions.js';

function admission(input: Partial<TenantAgentAdmission> = {}): TenantAgentAdmission {
  return {
    admission_id: input.admission_id ?? 'admission_1',
    tenant_id: input.tenant_id ?? 'tenant_1',
    task_run_id: input.task_run_id ?? 'task_1',
    policy_snapshot_ref: input.policy_snapshot_ref ?? 'db://tenant-runtime-policy-snapshot/snapshot_1',
    status: input.status ?? 'active',
    acquired_at: input.acquired_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: input.updated_at ?? '2026-01-01T00:00:00.000Z',
    revision: input.revision ?? 1,
    ...(input.agent_run_id ? { agent_run_id: input.agent_run_id } : {}),
    ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
    ...(input.workflow_run_id ? { workflow_run_id: input.workflow_run_id } : {}),
    ...(input.activated_at ? { activated_at: input.activated_at } : {}),
    ...(input.released_at ? { released_at: input.released_at } : {}),
    ...(input.release_reason ? { release_reason: input.release_reason } : {}),
  };
}

function taskLookup(status?: string): ReconcileTaskLookup {
  return {
    async get() {
      return status ? { status } : undefined;
    },
  };
}

function workflowLookup(status: ReconcileWorkflowStatus): ReconcileWorkflowLookup {
  return {
    async describe() {
      return status;
    },
  };
}

describe('admission reconcile decisions', () => {
  it('parses dry-run defaults and tenant-id alias', () => {
    expect(parseOptions(['--tenant-id', 'tenant_a', '--batch-size', '7', '--stale-after-ms', '1000'])).toEqual({
      dryRun: true,
      tenantId: 'tenant_a',
      batchSize: 7,
      staleAfterMs: 1000,
    });
    expect(parseOptions(['--apply', '--tenant', 'tenant_b'])).toMatchObject({
      dryRun: false,
      tenantId: 'tenant_b',
    });
  });

  it('skips open workflows even when the task is terminal', async () => {
    const result = await decideAdmissionReconcile(
      admission({ workflow_id: 'wf_open', workflow_run_id: 'run_1' }),
      taskLookup('completed'),
      workflowLookup({ status: 'open', name: 'RUNNING', reason: 'workflow_open' }),
    );

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('workflow_open');
    expect(result.workflow_status).toBe('RUNNING');
  });

  it('reconciles closed workflows and terminal tasks without workflow ids', async () => {
    await expect(decideAdmissionReconcile(
      admission({ workflow_id: 'wf_done' }),
      taskLookup('running'),
      workflowLookup({ status: 'closed', name: 'COMPLETED', reason: 'workflow_completed' }),
    )).resolves.toMatchObject({
      action: 'would_reconcile',
      reason: 'workflow_completed',
      workflow_status: 'COMPLETED',
    });

    await expect(decideAdmissionReconcile(
      admission(),
      taskLookup('failed'),
      workflowLookup({ status: 'open', name: 'RUNNING', reason: 'unused' }),
    )).resolves.toMatchObject({
      action: 'would_reconcile',
      reason: 'terminal_task_without_workflow',
      task_status: 'failed',
    });
  });

  it('only reconciles missing workflows when the TaskRun is terminal', async () => {
    const missingWorkflow = workflowLookup({ status: 'unknown', name: 'NOT_FOUND', reason: 'workflow_not_found' });

    await expect(decideAdmissionReconcile(
      admission({ workflow_id: 'wf_missing' }),
      taskLookup('completed'),
      missingWorkflow,
    )).resolves.toMatchObject({
      action: 'would_reconcile',
      reason: 'workflow_not_found_terminal_task',
      workflow_status: 'NOT_FOUND',
    });

    await expect(decideAdmissionReconcile(
      admission({ workflow_id: 'wf_missing' }),
      taskLookup('running'),
      missingWorkflow,
    )).resolves.toMatchObject({
      action: 'skipped',
      reason: 'workflow_not_found',
      workflow_status: 'NOT_FOUND',
      task_status: 'running',
    });
  });

  it('skips unknown workflow status and non-terminal tasks', async () => {
    await expect(decideAdmissionReconcile(
      admission({ workflow_id: 'wf_unknown' }),
      taskLookup('completed'),
      workflowLookup({ status: 'unknown', name: 'DESCRIBE_FAILED', reason: 'workflow_describe_failed' }),
    )).resolves.toMatchObject({
      action: 'skipped',
      reason: 'workflow_describe_failed',
      workflow_status: 'DESCRIBE_FAILED',
    });

    await expect(decideAdmissionReconcile(
      admission(),
      taskLookup('running'),
      workflowLookup({ status: 'open', name: 'RUNNING', reason: 'unused' }),
    )).resolves.toMatchObject({
      action: 'skipped',
      reason: 'task_not_terminal',
      task_status: 'running',
    });
  });
});
