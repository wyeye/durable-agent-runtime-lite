import type { SpecStatus } from '@dar/contracts';
import { Tag } from 'antd';

const colors: Record<SpecStatus, string> = {
  draft: 'default',
  validated: 'processing',
  published: 'success',
  gray: 'warning',
  deprecated: 'orange',
  disabled: 'error',
};

export function StatusTag({ status }: { status: SpecStatus | string }) {
  const known = isSpecStatus(status);
  return <Tag color={known ? colors[status] : 'default'}>{status}</Tag>;
}

function isSpecStatus(value: string): value is SpecStatus {
  return ['draft', 'validated', 'published', 'gray', 'deprecated', 'disabled'].includes(value);
}
