import type { RegistryResourceType, SpecStatus } from '@dar/contracts';

export function canPublishFromStatus(status: SpecStatus): boolean {
  return ['draft', 'validated', 'published', 'gray'].includes(status);
}

export function isRollbackEligible(status: SpecStatus, resourceType: RegistryResourceType): boolean {
  if (resourceType === 'tenant_runtime_policy' || resourceType === 'model_policy') {
    return ['published', 'gray', 'validated', 'deprecated', 'disabled'].includes(status);
  }
  return status === 'published';
}

export function publishDisabledReason(status: SpecStatus): string {
  if (status === 'deprecated' || status === 'disabled') {
    return '当前版本不能直接再次发布，请先 clone 新 draft。';
  }
  return '当前状态暂不支持发布。';
}

export function actionHelperText(
  action: 'validate' | 'publish' | 'gray' | 'deprecate' | 'disable' | 'rollback' | 'clone',
  status: SpecStatus | undefined,
  rollbackOptionCount: number,
): string | undefined {
  if (action === 'publish' && status === 'draft') {
    return '当前是 draft，确认后会先执行校验，再把该版本发布。';
  }
  if (action === 'rollback') {
    return rollbackOptionCount > 0
      ? '回滚会把当前发布指针切到目标版本，并刷新到真正生效的版本。'
      : '当前没有可回滚目标版本。';
  }
  if (action === 'disable') {
    return '禁用后当前版本会退出可用路径；如需再次调整，请 clone 出新的 draft。';
  }
  if (action === 'deprecate') {
    return '废弃会保留历史记录，但不再作为当前可用版本。';
  }
  return undefined;
}
