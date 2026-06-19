import type { TenantRuntimePolicySnapshot } from '@dar/contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, Drawer, Form, Input, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { listTenantPolicySnapshots } from '../../api/operations-api.js';
import { formatDateTime } from '../../utils/format.js';
import { stringifyPretty } from '../../utils/json.js';

export function PolicySnapshotsPage() {
  const client = useApiClient();
  const [searchParams] = useSearchParams();
  const initialRoot = searchParams.get('root_snapshot_ref') ?? '';
  const [filters, setFilters] = useState<Record<string, string>>({ page_size: '50', ...(initialRoot ? { root_snapshot_ref: initialRoot } : {}) });
  const [selected, setSelected] = useState<TenantRuntimePolicySnapshot | undefined>();
  const query = useQuery({
    queryKey: ['tenant-policy-snapshots', filters],
    queryFn: () => listTenantPolicySnapshots(client, filters),
  });

  const columns: ColumnsType<TenantRuntimePolicySnapshot> = [
    { title: 'snapshot', dataIndex: 'snapshot_ref', key: 'snapshot_ref', render: (value: string, row) => <Button type="link" onClick={() => setSelected(row)}>{short(value)}</Button> },
    { title: 'derivation', dataIndex: 'derivation_type', key: 'derivation_type', render: (value: string) => <Tag>{value}</Tag> },
    { title: 'depth', dataIndex: 'lineage_depth', key: 'lineage_depth' },
    { title: 'root', dataIndex: 'root_snapshot_ref', key: 'root_snapshot_ref', render: (value: string) => <Link to={`/policy-snapshots?root_snapshot_ref=${encodeURIComponent(value)}`}>{short(value)}</Link> },
    { title: 'parent', dataIndex: 'parent_snapshot_ref', key: 'parent_snapshot_ref', render: (value?: string) => value ? <Link to={`/policy-snapshots?parent_snapshot_ref=${encodeURIComponent(value)}`}>{short(value)}</Link> : '-' },
    { title: 'policy', key: 'policy', render: (_, row) => `v${row.source_policy_version} ${row.source_policy_hash.slice(0, 8)}` },
    { title: 'execution_plan', dataIndex: 'execution_plan_ref', key: 'execution_plan_ref', render: (value: string) => short(value) },
    { title: 'created_at', dataIndex: 'created_at', key: 'created_at', render: formatDateTime },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>Policy Snapshots</h1>
        </div>
        <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
      </div>
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" initialValues={filters} onFinish={(values) => setFilters({ page_size: '50', ...clean(values) })}>
          <Form.Item name="root_snapshot_ref"><Input placeholder="root_snapshot_ref" /></Form.Item>
          <Form.Item name="parent_snapshot_ref"><Input placeholder="parent_snapshot_ref" /></Form.Item>
          <Form.Item name="execution_plan_ref"><Input placeholder="execution_plan_ref" /></Form.Item>
          <Form.Item name="source_policy_version"><Input placeholder="policy version" /></Form.Item>
          <Form.Item name="derivation_type"><Input placeholder="derivation type" /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="snapshot_id"
          loading={query.isLoading}
          columns={columns}
          dataSource={query.data?.items ?? []}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无 Policy Snapshot" /> }}
        />
      </section>
      <Drawer title="Policy Snapshot" open={Boolean(selected)} onClose={() => setSelected(undefined)} width={760}>
        {selected ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Title level={4}>{selected.derivation_type}</Typography.Title>
            <Typography.Text>Tools: {selected.resolved_allowed_tools.map((tool) => tool.tool_name).join(', ') || '-'}</Typography.Text>
            <Typography.Text>Models: {selected.resolved_allowed_models.map((model) => model.model_id).join(', ') || '-'}</Typography.Text>
            <Typography.Text>Handoffs: {selected.resolved_allowed_handoffs.map((handoff) => handoff.flow_id).join(', ') || '-'}</Typography.Text>
            <pre className="cp-json-pre">{stringifyPretty(selected)}</pre>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}

function clean(values: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
      .map(([key, value]) => [key, value.trim()]),
  );
}

function short(value: string): string {
  return value.length > 32 ? `${value.slice(0, 29)}...` : value;
}
