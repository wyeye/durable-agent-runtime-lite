import type { AuditEvent } from '@dar/contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, Drawer, Form, Input, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useSearchParams } from 'react-router';
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { listAuditEvents } from '../../api/operations-api.js';
import { formatDateTime } from '../../utils/format.js';
import { stringifyPretty } from '../../utils/json.js';

export function AuditEventsPage() {
  const client = useApiClient();
  const [searchParams] = useSearchParams();
  const initialTaskRun = searchParams.get('task_run_id') ?? '';
  const [filters, setFilters] = useState<Record<string, string>>({ page_size: '50', ...(initialTaskRun ? { task_run_id: initialTaskRun } : {}) });
  const [selected, setSelected] = useState<AuditEvent | undefined>();

  const query = useQuery({
    queryKey: ['audit-events', filters],
    queryFn: () => listAuditEvents(client, filters),
  });

  const columns: ColumnsType<AuditEvent> = [
    { title: 'event_id', dataIndex: 'event_id', key: 'event_id', render: (value: string, row) => <Button type="link" onClick={() => setSelected(row)}>{value.slice(0, 12)}</Button> },
    { title: 'action', dataIndex: 'action', key: 'action' },
    { title: 'target', key: 'target', render: (_, row) => `${row.target_type}/${row.target_id}` },
    { title: 'result', dataIndex: 'result', key: 'result', render: (value: string) => <Tag>{value}</Tag> },
    { title: 'actor', dataIndex: 'actor_id', key: 'actor_id', render: (value: string | undefined) => value ?? '-' },
    { title: 'occurred_at', dataIndex: 'occurred_at', key: 'occurred_at', render: formatDateTime },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>Audit Events</h1>
          <p>通过 control-plane BFF 查询 tool-gateway 审计事件，敏感字段由后端脱敏。</p>
        </div>
        <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
      </div>
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" initialValues={filters} onFinish={(values) => setFilters({ page_size: '50', ...clean(values) })}>
          <Form.Item name="task_run_id"><Input placeholder="task_run_id" /></Form.Item>
          <Form.Item name="tool_name"><Input placeholder="tool_name" /></Form.Item>
          <Form.Item name="event_type"><Input placeholder="event_type/action" /></Form.Item>
          <Form.Item name="start_time"><Input placeholder="start_time ISO" /></Form.Item>
          <Form.Item name="end_time"><Input placeholder="end_time ISO" /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="event_id"
          loading={query.isLoading}
          columns={columns}
          dataSource={query.data ?? []}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无 AuditEvent" /> }}
        />
      </section>
      <Drawer title="Audit Detail" open={Boolean(selected)} onClose={() => setSelected(undefined)} width={720}>
        {selected ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Title level={4}>{selected.action}</Typography.Title>
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
