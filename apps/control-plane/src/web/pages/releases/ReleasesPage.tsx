import type { CapabilityRelease, RegistryResourceType, SpecStatus } from '@dar/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { App, Button, Drawer, Form, Input, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useSearchParams } from 'react-router';
import { useMemo, useState } from 'react';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { ConfirmActionModal } from '../../components/ConfirmActionModal.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { StatusTag } from '../../components/StatusTag.js';
import { useApiClient } from '../../api/use-api-client.js';
import { getRelease, listReleases, rollbackResource } from '../../api/registry-api.js';
import { formatDateTime } from '../../utils/format.js';
import { displayAction } from '../../utils/i18n-labels.js';
import { stringifyPretty } from '../../utils/json.js';

const resourceTypes: RegistryResourceType[] = ['flow', 'route', 'tool', 'agent', 'prompt'];
const actions: CapabilityRelease['action'][] = ['publish', 'gray', 'rollback', 'disable', 'deprecate'];

export function ReleasesPage() {
  const client = useApiClient();
  const { message } = App.useApp();
  const [searchParams] = useSearchParams();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | undefined>(searchParams.get('release_id') ?? undefined);
  const [rollbackTarget, setRollbackTarget] = useState<CapabilityRelease | undefined>();

  const query = useQuery({
    queryKey: ['releases', filters],
    queryFn: () => listReleases(client, { ...filters, page_size: 50 }),
  });

  const detailQuery = useQuery({
    queryKey: ['release', selectedReleaseId],
    enabled: Boolean(selectedReleaseId),
    queryFn: () => getRelease(client, selectedReleaseId!),
  });

  const rollbackMutation = useMutation({
    mutationFn: async (values: { release_note: string }) => {
      if (!rollbackTarget) {
        throw new Error('请选择发布记录');
      }
      return rollbackResource(client, rollbackTarget.resource_type, rollbackTarget.resource_id, {
        target_version: rollbackTarget.resource_version,
        release_note: values.release_note,
        metadata_json: { source_release_id: rollbackTarget.release_id },
      });
    },
    onSuccess: async () => {
      message.success('回滚已提交');
      setRollbackTarget(undefined);
      await query.refetch();
    },
  });

  const columns = useMemo<ColumnsType<CapabilityRelease>>(() => [
    {
      title: '发布 ID',
      dataIndex: 'release_id',
      key: 'release_id',
      render: (value: string) => <Button type="link" onClick={() => setSelectedReleaseId(value)}>{value.slice(0, 12)}</Button>,
    },
    { title: '资源', key: 'resource', render: (_, row) => <Link to={`/registry/${pluralOf(row.resource_type)}`}>{row.resource_type}/{row.resource_id}@{row.resource_version}</Link> },
    { title: '动作', dataIndex: 'action', key: 'action', render: (value: string) => displayAction(value) },
    { title: '目标状态', dataIndex: 'target_status', key: 'target_status', render: (status: SpecStatus) => <StatusTag status={status} /> },
    { title: '操作者', dataIndex: 'operator_id', key: 'operator_id' },
    { title: '创建时间', dataIndex: 'created_at', key: 'created_at', render: formatDateTime },
    {
      title: '回滚',
      key: 'rollback',
      render: (_, row) => (
        <Can permission="registry:rollback">
          <Button size="small" onClick={() => setRollbackTarget(row)}>回滚到 v{row.resource_version}</Button>
        </Can>
      ),
    },
  ], []);

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>发布中心</h1>
          <p>统一查询发布、灰度、回滚、禁用和废弃记录。</p>
        </div>
        <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form
          layout="inline"
          className="cp-filter-bar"
          onFinish={(values) => setFilters(clean(values))}
        >
          <Form.Item name="resource_type"><Select allowClear placeholder="资源类型" style={{ width: 160 }} options={resourceTypes.map((type) => ({ value: type, label: type }))} /></Form.Item>
          <Form.Item name="resource_id"><Input placeholder="resource_id" /></Form.Item>
          <Form.Item name="action"><Select allowClear placeholder="动作" style={{ width: 150 }} options={actions.map((action) => ({ value: action, label: displayAction(action) }))} /></Form.Item>
          <Form.Item name="operator_id"><Input placeholder="operator_id" /></Form.Item>
          <Form.Item name="start_time"><Input placeholder="开始时间 ISO" /></Form.Item>
          <Form.Item name="end_time"><Input placeholder="结束时间 ISO" /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="release_id"
          loading={query.isLoading}
          columns={columns}
          dataSource={query.data?.items ?? []}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无发布记录" /> }}
        />
      </section>
      <Drawer title="发布详情" open={Boolean(selectedReleaseId)} onClose={() => setSelectedReleaseId(undefined)} width={720}>
        {detailQuery.error ? <ErrorAlert error={detailQuery.error} /> : null}
        {detailQuery.data ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Title level={4}>{detailQuery.data.resource_type}/{detailQuery.data.resource_id}@{detailQuery.data.resource_version}</Typography.Title>
            <pre className="cp-json-pre">{stringifyPretty(detailQuery.data)}</pre>
          </Space>
        ) : null}
      </Drawer>
      <ConfirmActionModal
        title={rollbackTarget ? `回滚 ${rollbackTarget.resource_type}/${rollbackTarget.resource_id} 到 v${rollbackTarget.resource_version}` : '回滚'}
        open={Boolean(rollbackTarget)}
        loading={rollbackMutation.isPending}
        onCancel={() => setRollbackTarget(undefined)}
        onConfirm={(values) => rollbackMutation.mutate({ release_note: values.release_note })}
      />
    </div>
  );
}

function pluralOf(type: RegistryResourceType): string {
  return type === 'flow' ? 'flows'
    : type === 'route' ? 'routes'
      : type === 'tool' ? 'tools'
        : type === 'agent' ? 'agents'
          : 'prompts';
}

function clean(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
      .map(([key, value]) => [key, value.trim()]),
  );
}
