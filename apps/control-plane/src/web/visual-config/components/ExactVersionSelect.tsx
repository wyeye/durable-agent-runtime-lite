import type { RegistryResourceType } from '@dar/contracts';
import type { ApiClient } from '../../api/client.js';
import { Alert, Select, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { listResources, type RegistryRecord } from '../../api/registry-api.js';
import { listDatasets } from '../../api/evaluation-api.js';

export interface ExactVersionValue {
  resource_id: string;
  version: number | string;
  sha256?: string | undefined;
  status?: string | undefined;
}

export function ExactVersionSelect({
  client,
  resourceType,
  value,
  onChange,
  readOnly,
  status,
  placeholder,
  includeHash = false,
  testId,
}: {
  client: ApiClient;
  resourceType: RegistryResourceType | 'evaluation_dataset';
  value?: ExactVersionValue;
  onChange(value: ExactVersionValue | undefined): void;
  readOnly: boolean;
  status?: string;
  placeholder?: string;
  includeHash?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ['exact-version-select', resourceType, status, value?.resource_id, value?.version],
    queryFn: async () => {
      const target = value ? encodeValue(value) : undefined;
      const items: ExactVersionValue[] = [];
      for (let page = 1; page <= 20; page += 1) {
        let pageItems: ExactVersionValue[] = [];
        let loadedAllByTotal = false;
        let loadedShortPage = false;
        if (resourceType === 'evaluation_dataset') {
          const result = await listDatasets(client, { status: status as never, page, page_size: 100 });
          pageItems = result.items.map((item) => ({
              resource_id: item.dataset_id,
              version: item.version,
              ...(item.dataset_hash ? { sha256: item.dataset_hash } : {}),
              status: item.status,
          }));
          loadedAllByTotal = result.total !== undefined && items.length + pageItems.length >= result.total;
          loadedShortPage = result.items.length < result.page_size;
        } else {
          const result = await listResources(client, resourceType, { status: status as never, page, page_size: 100 });
          pageItems = result.items.map((record) => toExactVersionValue(record, resourceType));
          loadedAllByTotal = result.total !== undefined && items.length + pageItems.length >= result.total;
          loadedShortPage = result.items.length < result.page_size;
        }
        items.push(...pageItems);
        const foundTarget = target ? items.some((item) => encodeValue(item) === target) : false;
        if (foundTarget || loadedAllByTotal || loadedShortPage) {
          break;
        }
      }
      return dedupeExactVersions(items);
    },
  });
  const options = (query.data ?? []).map((item) => ({
    value: encodeValue(item),
    title: encodeValue(item),
    label: (
      <Space>
        <span>{item.resource_id}@{item.version}</span>
        {item.status ? <Tag>{item.status}</Tag> : null}
        {includeHash && item.sha256 ? <Typography.Text type="secondary">{item.sha256.slice(0, 12)}</Typography.Text> : null}
      </Space>
    ),
  }));
  const encoded = value ? encodeValue(value) : undefined;
  const selectedMissing = Boolean(value && !query.isLoading && !(query.data ?? []).some((item) => encodeValue(item) === encoded));

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Select
        data-testid={testId}
        showSearch
        allowClear
        disabled={readOnly}
        loading={query.isLoading}
        value={encoded}
        placeholder={placeholder ?? t('visualConfig.exactVersion.placeholder')}
        options={options}
        filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())}
        onChange={(next) => {
          const selected = (query.data ?? []).find((item) => encodeValue(item) === next);
          onChange(selected);
        }}
      />
      {selectedMissing ? <Alert type="warning" showIcon message={t('visualConfig.exactVersion.missing')} /> : null}
    </Space>
  );
}

function toExactVersionValue(record: RegistryRecord, resourceType: RegistryResourceType): ExactVersionValue {
  const specVersion = resourceType === 'tool' && typeof record.spec.version === 'string'
    ? record.spec.version
    : record.version;
  const value: ExactVersionValue = {
    resource_id: record.resource_id,
    version: specVersion,
    status: record.status,
  };
  if (record.sha256) {
    value.sha256 = record.sha256;
  }
  return value;
}

function encodeValue(value: ExactVersionValue): string {
  return `${value.resource_id}@${value.version}`;
}

function dedupeExactVersions(items: ExactVersionValue[]): ExactVersionValue[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const encoded = encodeValue(item);
    if (seen.has(encoded)) {
      return false;
    }
    seen.add(encoded);
    return true;
  });
}
