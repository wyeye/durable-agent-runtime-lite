import { describe, expect, it } from 'vitest';
import { actionHelperText, canPublishFromStatus, isRollbackEligible, publishDisabledReason } from './registry-page-helpers.js';

describe('registry page helpers', () => {
  it('allows publish from draft, validated, published, and gray', () => {
    expect(canPublishFromStatus('draft')).toBe(true);
    expect(canPublishFromStatus('validated')).toBe(true);
    expect(canPublishFromStatus('published')).toBe(true);
    expect(canPublishFromStatus('gray')).toBe(true);
    expect(canPublishFromStatus('deprecated')).toBe(false);
    expect(canPublishFromStatus('disabled')).toBe(false);
  });

  it('filters rollback targets by resource type semantics', () => {
    expect(isRollbackEligible('published', 'route')).toBe(true);
    expect(isRollbackEligible('gray', 'route')).toBe(false);
    expect(isRollbackEligible('disabled', 'route')).toBe(false);
    expect(isRollbackEligible('disabled', 'model_policy')).toBe(true);
    expect(isRollbackEligible('validated', 'tenant_runtime_policy')).toBe(true);
  });

  it('explains destructive and guided actions', () => {
    expect(publishDisabledReason('disabled')).toContain('clone');
    expect(actionHelperText('publish', 'draft', 0)).toContain('先执行校验');
    expect(actionHelperText('rollback', 'published', 0)).toContain('没有可回滚目标版本');
    expect(actionHelperText('rollback', 'published', 2)).toContain('刷新到真正生效的版本');
  });
});
