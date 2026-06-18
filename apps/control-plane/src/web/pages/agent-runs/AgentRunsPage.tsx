import type { AgentRunRecord, AgentStepRecord } from '@dar/contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useSearchParams } from 'react-router';
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { getAgentRun, listAgentRuns, listAgentSteps } from '../../api/operations-api.js';
import { formatDateTime } from '../../utils/format.js';
import { stringifyPretty } from '../../utils/json.js';

const statuses = ['queued', 'running', 'waiting_tool', 'waiting_human', 'waiting_user', 'handing_off', 'completed', 'failed', 'cancelled', 'budget_exceeded', 'timed_out'];

export function AgentRunsPage() {
  const client = useApiClient();
  const [searchParams] = useSearchParams();
  const initialTaskRun = searchParams.get('task_run_id') ?? '';
  const [filters, setFilters] = useState<Record<string, string>>({ page_size: '50', ...(initialTaskRun ? { task_run_id: initialTaskRun } : {}) });
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const listQuery = useQuery({
    queryKey: ['agent-runs', filters],
    queryFn: () => listAgentRuns(client, filters),
  });
  const detailQuery = useQuery({
    queryKey: ['agent-run', selectedId],
    enabled: Boolean(selectedId),
    queryFn: () => getAgentRun(client, selectedId!),
  });
  const stepsQuery = useQuery({
    queryKey: ['agent-run-steps', selectedId],
    enabled: Boolean(selectedId),
    queryFn: () => listAgentSteps(client, selectedId!, { page_size: 100 }),
  });

  const columns: ColumnsType<AgentRunRecord> = [
    { title: 'agent_run_id', dataIndex: 'agent_run_id', key: 'agent_run_id', render: (value: string) => <Button type="link" onClick={() => setSelectedId(value)}>{value}</Button> },
    { title: 'task_run_id', dataIndex: 'task_run_id', key: 'task_run_id', render: (value: string) => <Link to={`/task-runs?task_run_id=${encodeURIComponent(value)}`}>{value}</Link> },
    { title: 'agent', key: 'agent', render: (_, row) => `${row.agent_id}@${row.agent_version}` },
    { title: 'status', dataIndex: 'status', key: 'status', render: (value: string) => <Tag>{value}</Tag> },
    { title: 'segment', dataIndex: 'current_segment_index', key: 'current_segment_index' },
    { title: 'tools', dataIndex: 'tool_call_count', key: 'tool_call_count' },
    { title: 'tokens', dataIndex: 'total_tokens', key: 'total_tokens' },
    { title: 'updated_at', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
  ];
  const stepColumns: ColumnsType<AgentStepRecord> = [
    { title: 'segment', dataIndex: 'segment_index', key: 'segment_index' },
    { title: 'status', dataIndex: 'segment_status', key: 'segment_status', render: (value: string) => <Tag>{value}</Tag> },
    { title: 'summary', dataIndex: 'decision_summary', key: 'decision_summary', render: (value: string | undefined) => value ?? '-' },
    { title: 'tools', key: 'tools', render: (_, row) => row.proposed_tool_calls.length },
    { title: 'snapshot', key: 'snapshot', render: (_, row) => row.context_snapshot_ref?.snapshot_id ?? '-' },
    { title: 'error', dataIndex: 'error_code', key: 'error_code', render: (value: string | undefined) => value ?? '-' },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>AgentRuns</h1>
        </div>
        <Button onClick={() => listQuery.refetch()} loading={listQuery.isFetching}>刷新</Button>
      </div>
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" initialValues={filters} onFinish={(values) => setFilters({ page_size: '50', ...clean(values) })}>
          <Form.Item name="status"><Select allowClear placeholder="status" style={{ width: 190 }} options={statuses.map((status) => ({ value: status, label: status }))} /></Form.Item>
          <Form.Item name="task_run_id"><Input placeholder="task_run_id" /></Form.Item>
          <Form.Item name="agent_id"><Input placeholder="agent_id" /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {listQuery.error ? <ErrorAlert error={listQuery.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="agent_run_id"
          loading={listQuery.isLoading}
          columns={columns}
          dataSource={listQuery.data ?? []}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无 AgentRun" /> }}
        />
      </section>
      <Drawer title="AgentRun Detail" open={Boolean(selectedId)} onClose={() => setSelectedId(undefined)} width={860}>
        {detailQuery.error ? <ErrorAlert error={detailQuery.error} /> : null}
        {stepsQuery.error ? <ErrorAlert error={stepsQuery.error} /> : null}
        {detailQuery.data ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Title level={4}>{detailQuery.data.agent_run_id}</Typography.Title>
            <Space wrap>
              <Link to={`/task-runs?task_run_id=${encodeURIComponent(detailQuery.data.task_run_id)}`}>TaskRun</Link>
              <Link to={`/human-tasks?task_run_id=${encodeURIComponent(detailQuery.data.task_run_id)}`}>Human Tasks</Link>
              <Link to={`/tool-calls?task_run_id=${encodeURIComponent(detailQuery.data.task_run_id)}`}>ToolCalls</Link>
            </Space>
            <Table
              rowKey="agent_step_id"
              size="small"
              loading={stepsQuery.isLoading}
              columns={stepColumns}
              dataSource={stepsQuery.data ?? []}
              pagination={false}
              locale={{ emptyText: <EmptyState description="暂无 AgentStep" /> }}
            />
            <pre className="cp-json-pre">{stringifyPretty(detailQuery.data)}</pre>
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
