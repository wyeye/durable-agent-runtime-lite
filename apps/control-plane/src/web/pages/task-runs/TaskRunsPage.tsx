import type { TaskRun } from '@dar/contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useSearchParams } from 'react-router';
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { getTaskRun, listTaskRuns } from '../../api/operations-api.js';
import { formatDateTime } from '../../utils/format.js';
import { displayStatus } from '../../utils/i18n-labels.js';
import { stringifyPretty } from '../../utils/json.js';

const statuses = ['created', 'routing', 'queued', 'running', 'waiting_human', 'completed', 'failed', 'failed_to_start', 'cancelled'];

export function TaskRunsPage() {
  const client = useApiClient();
  const [searchParams] = useSearchParams();
  const initialTaskRun = searchParams.get('task_run_id') ?? '';
  const [filters, setFilters] = useState<Record<string, string>>({ page_size: '50', ...(initialTaskRun ? { task_run_id: initialTaskRun } : {}) });
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const listQuery = useQuery({
    queryKey: ['task-runs', filters],
    queryFn: () => listTaskRuns(client, filters),
  });

  const detailQuery = useQuery({
    queryKey: ['task-run', selectedId],
    enabled: Boolean(selectedId),
    queryFn: () => getTaskRun(client, selectedId!),
  });

  const columns: ColumnsType<TaskRun> = [
    { title: '任务运行 ID', dataIndex: 'task_run_id', key: 'task_run_id', render: (value: string) => <Button type="link" onClick={() => setSelectedId(value)}>{value}</Button> },
    { title: 'workflow_id', dataIndex: 'workflow_id', key: 'workflow_id', render: (value: string | undefined) => value ?? '-' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (value: string) => <Tag>{displayStatus(value)}</Tag> },
    { title: '流程', key: 'flow', render: (_, row) => row.flow_id ? `${row.flow_id}@${row.flow_version ?? '-'}` : '-' },
    { title: 'route_id', dataIndex: 'route_id', key: 'route_id', render: (value: string | undefined) => value ?? '-' },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
    { title: 'error_code', dataIndex: 'error_code', key: 'error_code', render: (value: string | undefined) => value ?? '-' },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>任务运行</h1>
          <p>通过 control-plane BFF 查询 runtime-api 的任务运行状态。</p>
        </div>
        <Button onClick={() => listQuery.refetch()} loading={listQuery.isFetching}>刷新</Button>
      </div>
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" initialValues={filters} onFinish={(values) => setFilters({ page_size: '50', ...clean(values) })}>
          <Form.Item name="status"><Select allowClear placeholder="状态" style={{ width: 170 }} options={statuses.map((status) => ({ value: status, label: displayStatus(status) }))} /></Form.Item>
          <Form.Item name="flow_id"><Input placeholder="flow_id" /></Form.Item>
          <Form.Item name="workflow_id"><Input placeholder="workflow_id" /></Form.Item>
          <Form.Item name="task_run_id"><Input placeholder="task_run_id 精确匹配" /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {listQuery.error ? <ErrorAlert error={listQuery.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="task_run_id"
          loading={listQuery.isLoading}
          columns={columns}
          dataSource={filterTaskRuns(listQuery.data ?? [], filters.task_run_id)}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无任务运行" /> }}
        />
      </section>
      <Drawer title="任务运行详情" open={Boolean(selectedId)} onClose={() => setSelectedId(undefined)} width={760}>
        {detailQuery.error ? <ErrorAlert error={detailQuery.error} /> : null}
        {detailQuery.data ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Title level={4}>{detailQuery.data.task_run_id}</Typography.Title>
            <Space wrap>
              <Link to={`/human-tasks?task_run_id=${encodeURIComponent(detailQuery.data.task_run_id)}`}>人工任务</Link>
              <Link to={`/agent-runs?task_run_id=${encodeURIComponent(detailQuery.data.task_run_id)}`}>智能体运行</Link>
              <Link to={`/audit-events?task_run_id=${encodeURIComponent(detailQuery.data.task_run_id)}`}>审计日志</Link>
              <Link to={`/tool-calls?task_run_id=${encodeURIComponent(detailQuery.data.task_run_id)}`}>工具调用</Link>
            </Space>
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

function filterTaskRuns(rows: TaskRun[], taskRunId: string | undefined): TaskRun[] {
  return taskRunId ? rows.filter((row) => row.task_run_id === taskRunId) : rows;
}
