import type { ReactNode } from 'react';
import type { ControlPlanePermission } from '@dar/security';
import { Alert } from 'antd';
import { useIdentity } from './identity-context.js';

export function Can({ permission, children, fallback = null }: {
  permission: ControlPlanePermission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { hasPermission } = useIdentity();
  return hasPermission(permission) ? <>{children}</> : <>{fallback}</>;
}

export function ReadOnlyNotice() {
  const { identity } = useIdentity();
  if (!identity?.roles.includes('auditor')) {
    return null;
  }
  return (
    <Alert
      type="info"
      showIcon
      message="当前是 auditor 只读视图"
      description="你可以查看注册、发布和运营记录，但不能执行发布、回滚、禁用或审批。"
    />
  );
}
