import type { SpecStatus } from '@dar/contracts';
import { Button, Space } from 'antd';
import { Can } from '../auth/role-guard.js';

export type ReleaseAction = 'validate' | 'publish' | 'gray' | 'deprecate' | 'disable' | 'rollback' | 'clone';

export function ReleaseActionButtons({
  status,
  onAction,
  disabled = false,
}: {
  status: SpecStatus;
  onAction(action: ReleaseAction): void;
  disabled?: boolean;
}) {
  return (
    <Space wrap>
      <Can permission="registry:validate">
        <Button onClick={() => onAction('validate')} disabled={disabled} data-testid="registry-validate">Validate</Button>
      </Can>
      <Can permission="registry:write">
        <Button onClick={() => onAction('clone')} disabled={disabled}>Clone</Button>
      </Can>
      <Can permission="registry:publish">
        <Button type="primary" onClick={() => onAction('publish')} disabled={disabled || !['validated', 'published', 'gray'].includes(status)} data-testid="registry-publish">Publish</Button>
      </Can>
      <Can permission="registry:gray">
        <Button onClick={() => onAction('gray')} disabled={disabled || status !== 'published'}>Gray</Button>
      </Can>
      <Can permission="registry:deprecate">
        <Button onClick={() => onAction('deprecate')} disabled={disabled || !['published', 'gray'].includes(status)}>Deprecate</Button>
      </Can>
      <Can permission="registry:disable">
        <Button danger onClick={() => onAction('disable')} disabled={disabled || status === 'disabled'}>Disable</Button>
      </Can>
      <Can permission="registry:rollback">
        <Button onClick={() => onAction('rollback')} disabled={disabled}>Rollback</Button>
      </Can>
    </Space>
  );
}
