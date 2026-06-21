import type { ToolCallLog } from '@dar/contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link, useSearchParams } from 'react-router';
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { RiskTag } from '../../components/RiskTag.js';
import { useApiClient } from '../../api/use-api-client.js';
import { getToolCall, listToolCalls } from '../../api/operations-api.js';
import { formatDateTime } from '../../utils/format.js';
import { stringifyPretty } from '../../utils/json.js';
import { displayStatus } from '../../utils/i18n-labels.js';

const statuses = ['previewed', 'pending_confirmation', 'approved', 'rejected', 'committed', 'denied', 'failed'];

export function ToolCallsPage() {
  const client = useApiClient();
  const [searchParams] = useSearchParams();
  const initialTaskRun = searchParams.get('task_run_id') ?? '';
  const [filters, setFilters] = useState<Record<string, string>>({ page_size: '50', ...(initialTaskRun ? { task_run_id: initialTaskRun } : {}) });
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const listQuery = useQuery({
    queryKey: ['tool-calls', filters],
    queryFn: () => listToolCalls(client, filters),
  });

  const detailQuery = useQuery({
    queryKey: ['tool-call', selectedId],
    enabled: Boolean(selectedId),
    queryFn: () => getToolCall(client, selectedId!),
  });

  const columns: ColumnsType<ToolCallLog> = [
    { title: 'tool_call_id', dataIndex: 'tool_call_id', key: 'tool_call_id', render: (value: string) => <Button type="link" onClick={() => setSelectedId(value)}>{value.slice(0, 12)}</Button> },
    { title: '工具', dataIndex: 'tool_name', key: 'tool_name' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (value: string) => <Tag>{displayStatus(value)}</Tag> },
    { title: '风险', dataIndex: 'risk_level', key: 'risk_level', render: (value: string) => <RiskTag risk={value} /> },
    { title: 'task_run_id', dataIndex: 'task_run_id', key: 'task_run_id', render: (value: string | undefined) => value ?? '-' },
    { title: '创建时间', dataIndex: 'created_at', key: 'created_at', render: formatDateTime },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>工具调用</h1>
          <p>查看 preview/commit、幂等、策略和结果，数据来自 Tool Gateway 查询接口。</p>
        </div>
        <Button onClick={() => listQuery.refetch()} loading={listQuery.isFetching}>刷新</Button>
      </div>
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" initialValues={filters} onFinish={(values) => setFilters({ page_size: '50', ...clean(values) })}>
          <Form.Item name="task_run_id"><Input placeholder="task_run_id" /></Form.Item>
          <Form.Item name="tool_name"><Input placeholder="tool_name" /></Form.Item>
          <Form.Item name="status"><Select allowClear placeholder="状态" style={{ width: 190 }} options={statuses.map((status) => ({ value: status, label: displayStatus(status) }))} /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {listQuery.error ? <ErrorAlert error={listQuery.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="tool_call_id"
          loading={listQuery.isLoading}
          columns={columns}
          dataSource={listQuery.data ?? []}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无工具调用" /> }}
        />
      </section>
      <Drawer title="工具调用详情" open={Boolean(selectedId)} onClose={() => setSelectedId(undefined)} width={760}>
        {detailQuery.error ? <ErrorAlert error={detailQuery.error} /> : null}
        {detailQuery.data ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Title level={4}>{detailQuery.data.tool_name}@{detailQuery.data.tool_version}</Typography.Title>
            <Space wrap>
              {detailQuery.data.task_run_id ? <Link to={`/task-runs?task_run_id=${encodeURIComponent(detailQuery.data.task_run_id)}`}>任务运行</Link> : null}
              {detailQuery.data.task_run_id ? <Link to={`/audit-events?task_run_id=${encodeURIComponent(detailQuery.data.task_run_id)}`}>审计日志</Link> : null}
            </Space>
            <Typography.Title level={5}>idempotency_key</Typography.Title>
            <Typography.Text copyable>{detailQuery.data.idempotency_key ?? '-'}</Typography.Text>
            <Typography.Title level={5}>preview_json</Typography.Title>
            <pre className="cp-json-pre">{stringifyPretty(detailQuery.data.preview_json ?? {})}</pre>
            <Typography.Title level={5}>result_json</Typography.Title>
            <pre className="cp-json-pre">{stringifyPretty(detailQuery.data.result_json ?? {})}</pre>
            <Typography.Title level={5}>原始记录</Typography.Title>
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
