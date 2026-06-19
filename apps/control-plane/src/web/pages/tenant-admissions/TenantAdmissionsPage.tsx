import type { TenantAgentAdmission } from '@dar/contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { listTenantAdmissions } from '../../api/operations-api.js';
import { formatDateTime } from '../../utils/format.js';
import { stringifyPretty } from '../../utils/json.js';

const statusOptions = ['reserved', 'active', 'released', 'rejected', 'orphaned', 'reconciled'].map((value) => ({ value, label: value }));

export function TenantAdmissionsPage() {
  const client = useApiClient();
  const [searchParams] = useSearchParams();
  const initialTaskRun = searchParams.get('task_run_id') ?? '';
  const [filters, setFilters] = useState<Record<string, string>>({ page_size: '50', ...(initialTaskRun ? { task_run_id: initialTaskRun } : {}) });
  const [selected, setSelected] = useState<TenantAgentAdmission | undefined>();
  const query = useQuery({
    queryKey: ['tenant-agent-admissions', filters],
    queryFn: () => listTenantAdmissions(client, filters),
  });

  const columns: ColumnsType<TenantAgentAdmission> = [
    { title: 'admission', dataIndex: 'admission_id', key: 'admission_id', render: (value: string, row) => <Button type="link" onClick={() => setSelected(row)}>{short(value)}</Button> },
    { title: 'status', dataIndex: 'status', key: 'status', render: (value: string) => <Tag>{value}</Tag> },
    { title: 'task_run', dataIndex: 'task_run_id', key: 'task_run_id', render: (value: string) => <Link to={`/task-runs?task_run_id=${encodeURIComponent(value)}`}>{short(value)}</Link> },
    { title: 'agent_run', dataIndex: 'agent_run_id', key: 'agent_run_id', render: (value?: string) => value ? <Link to={`/agent-runs?agent_run_id=${encodeURIComponent(value)}`}>{short(value)}</Link> : '-' },
    { title: 'workflow', dataIndex: 'workflow_id', key: 'workflow_id', render: (value?: string) => value ? short(value) : '-' },
    { title: 'snapshot', dataIndex: 'policy_snapshot_ref', key: 'policy_snapshot_ref', render: (value: string) => <Link to={`/policy-snapshots?root_snapshot_ref=${encodeURIComponent(value)}`}>{short(value)}</Link> },
    { title: 'acquired_at', dataIndex: 'acquired_at', key: 'acquired_at', render: formatDateTime },
    { title: 'released_at', dataIndex: 'released_at', key: 'released_at', render: (value?: string) => value ? formatDateTime(value) : '-' },
    { title: 'reason', dataIndex: 'release_reason', key: 'release_reason', render: (value?: string) => value ?? '-' },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>Tenant Admissions</h1>
        </div>
        <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
      </div>
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" initialValues={filters} onFinish={(values) => setFilters({ page_size: '50', ...clean(values) })}>
          <Form.Item name="status"><Select allowClear placeholder="status" options={statusOptions} style={{ width: 150 }} /></Form.Item>
          <Form.Item name="task_run_id"><Input placeholder="task_run_id" /></Form.Item>
          <Form.Item name="agent_run_id"><Input placeholder="agent_run_id" /></Form.Item>
          <Form.Item name="workflow_id"><Input placeholder="workflow_id" /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="admission_id"
          loading={query.isLoading}
          columns={columns}
          dataSource={query.data?.items ?? []}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无 Tenant Admission" /> }}
        />
      </section>
      <Drawer title="Tenant Admission" open={Boolean(selected)} onClose={() => setSelected(undefined)} width={720}>
        {selected ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Title level={4}>{selected.status}</Typography.Title>
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
