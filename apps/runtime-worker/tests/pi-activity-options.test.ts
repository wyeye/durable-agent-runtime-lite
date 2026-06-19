import { ActivityCancellationType } from '@temporalio/workflow';
import { describe, expect, it } from 'vitest';
import { PI_ACTIVITY_OPTIONS } from '../src/workflows/pi-durable-agent-workflow.js';

describe('Pi durable workflow Activity options', () => {
  it('sets retry, heartbeat, and cancellation boundaries for slow external work', () => {
    expect(PI_ACTIVITY_OPTIONS.piSegment.heartbeatTimeout).toBe('15 seconds');
    expect(PI_ACTIVITY_OPTIONS.piSegment.cancellationType).toBe(ActivityCancellationType.WAIT_CANCELLATION_COMPLETED);
    expect(PI_ACTIVITY_OPTIONS.piSegment.retry?.maximumAttempts).toBe(3);
    expect(PI_ACTIVITY_OPTIONS.piSegment.retry?.nonRetryableErrorTypes).toContain('PI_SEGMENT_NON_RETRYABLE');

    expect(PI_ACTIVITY_OPTIONS.toolInvoke.heartbeatTimeout).toBe('15 seconds');
    expect(PI_ACTIVITY_OPTIONS.toolInvoke.cancellationType).toBe(ActivityCancellationType.WAIT_CANCELLATION_COMPLETED);
    expect(PI_ACTIVITY_OPTIONS.toolInvoke.retry?.nonRetryableErrorTypes).toEqual(expect.arrayContaining([
      'TOOL_ARGUMENT_VALIDATION_FAILED',
      'TOOL_POLICY_DENIED',
      'TOOL_HASH_MISMATCH',
      'TOOL_RISK_MISMATCH',
    ]));

    expect(PI_ACTIVITY_OPTIONS.toolCommit.heartbeatTimeout).toBe('15 seconds');
    expect(PI_ACTIVITY_OPTIONS.toolCommit.cancellationType).toBe(ActivityCancellationType.WAIT_CANCELLATION_COMPLETED);
    expect(PI_ACTIVITY_OPTIONS.toolCommit.retry?.maximumAttempts).toBe(2);
    expect(PI_ACTIVITY_OPTIONS.toolCommit.retry?.nonRetryableErrorTypes).toEqual(expect.arrayContaining([
      'HUMAN_CONFIRMATION_REQUIRED',
      'IDEMPOTENCY_CONFLICT',
    ]));
  });

  it('does not retry known validation and policy failures for DB and registry reads', () => {
    expect(PI_ACTIVITY_OPTIONS.read.retry?.nonRetryableErrorTypes).toEqual(expect.arrayContaining([
      'VALIDATION_FAILED',
      'AUTH_FAILED',
      'POLICY_DENIED',
      'NOT_FOUND',
    ]));
    expect(PI_ACTIVITY_OPTIONS.dbWrite.retry?.maximumAttempts).toBe(4);
    expect(PI_ACTIVITY_OPTIONS.dbWrite.retry?.nonRetryableErrorTypes).toEqual(expect.arrayContaining([
      'VALIDATION_FAILED',
      'AUTH_FAILED',
      'POLICY_DENIED',
      'NOT_FOUND',
    ]));
  });
});
