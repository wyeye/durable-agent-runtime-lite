import type { SpecStatus } from '@dar/contracts';
import { Button, Space } from 'antd';
import { displayAction } from '../utils/i18n-labels.js';
import { Can } from '../auth/role-guard.js';

export type ReleaseAction = 'validate' | 'publish' | 'gray' | 'deprecate' | 'disable' | 'rollback' | 'clone';

export function ReleaseActionButtons({
  status,
  onAction,
  disabled = false,
  publishDisabledReason,
  rollbackDisabled = false,
}: {
  status: SpecStatus;
  onAction(action: ReleaseAction): void;
  disabled?: boolean;
  publishDisabledReason?: string;
  rollbackDisabled?: boolean;
}) {
  const publishEnabled = ['draft', 'validated', 'published', 'gray'].includes(status);
  const deprecateEnabled = ['published', 'gray'].includes(status);
  return (
    <Space wrap>
      <Can permission="registry:validate">
        <Button onClick={() => onAction('validate')} disabled={disabled} data-testid="registry-validate">{displayAction('validate')}</Button>
      </Can>
      <Can permission="registry:write">
        <Button onClick={() => onAction('clone')} disabled={disabled}>{displayAction('clone')}</Button>
      </Can>
      <Can permission="registry:publish">
        <Button
          type="primary"
          onClick={() => onAction('publish')}
          disabled={disabled || !publishEnabled}
          title={!publishEnabled ? publishDisabledReason : undefined}
          data-testid="registry-publish"
        >
          {status === 'draft' ? '校验并发布' : displayAction('publish')}
        </Button>
      </Can>
      <Can permission="registry:gray">
        <Button onClick={() => onAction('gray')} disabled={disabled || status !== 'published'}>灰度</Button>
      </Can>
      <Can permission="registry:deprecate">
        <Button onClick={() => onAction('deprecate')} disabled={disabled || !deprecateEnabled}>废弃</Button>
      </Can>
      <Can permission="registry:disable">
        <Button danger onClick={() => onAction('disable')} disabled={disabled || status === 'disabled'}>{displayAction('disable')}</Button>
      </Can>
      <Can permission="registry:rollback">
        <Button onClick={() => onAction('rollback')} disabled={disabled || rollbackDisabled}>{displayAction('rollback')}</Button>
      </Can>
    </Space>
  );
}
