import { useQuery } from '@tanstack/react-query';
import { Button, List, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { AuditEvent, CapabilityRelease, TaskRun, ToolCallLog } from '@dar/contracts';
import { ErrorAlert } from '../components/ErrorAlert.js';
import { EmptyState } from '../components/EmptyState.js';
import { StatusTag } from '../components/StatusTag.js';
import { RiskTag } from '../components/RiskTag.js';
import { useApiClient } from '../api/use-api-client.js';
import { getDashboard } from '../api/operations-api.js';
import { formatDateTime } from '../utils/format.js';

export function DashboardPage() {
  const client = useApiClient();
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => getDashboard(client),
  });

  if (query.error) {
    return (
      <div className="cp-page">
        <PageHeader onRefresh={() => query.refetch()} />
        <ErrorAlert error={query.error} />
      </div>
    );
  }

  const data = query.data;
  const counts = data?.summary.registry_counts;

  return (
    <div className="cp-page">
      <PageHeader onRefresh={() => query.refetch()} loading={query.isFetching} />
      <section className="cp-section">
        <div className="cp-stat-grid">
          <Statistic title="Published Flow" value={counts?.flows_published ?? 0} loading={query.isLoading} />
          <Statistic title="Published Route" value={counts?.routes_published ?? 0} loading={query.isLoading} />
          <Statistic title="Published Tool" value={counts?.tools_published ?? 0} loading={query.isLoading} />
          <Statistic title="Published Agent" value={counts?.agents_published ?? 0} loading={query.isLoading} />
          <Statistic title="Published Prompt" value={counts?.prompts_published ?? 0} loading={query.isLoading} />
          <Statistic title="Pending Human Task" value={data?.summary.pending_human_task_count ?? 0} loading={query.isLoading} />
          <Statistic title="Running TaskRun" value={data?.summary.running_task_count ?? 0} loading={query.isLoading} />
          <Statistic title="Waiting Human" value={data?.summary.waiting_human_task_count ?? 0} loading={query.isLoading} />
          <Statistic title="Failed TaskRun" value={data?.summary.failed_task_count ?? 0} loading={query.isLoading} />
        </div>
      </section>
      <div className="cp-split">
        <section className="cp-section">
          <Typography.Title level={3}>最近发布</Typography.Title>
          <ReleaseList releases={data?.summary.recent_releases ?? []} loading={query.isLoading} />
        </section>
        <section className="cp-section">
          <Typography.Title level={3}>最近失败任务</Typography.Title>
          <TaskTable tasks={data?.summary.recent_failed_tasks ?? []} loading={query.isLoading} />
        </section>
      </div>
      <div className="cp-split">
        <section className="cp-section">
          <Typography.Title level={3}>最近 ToolCall</Typography.Title>
          <ToolCallTable calls={data?.recent_tool_calls ?? []} loading={query.isLoading} />
        </section>
        <section className="cp-section">
          <Typography.Title level={3}>最近 AuditEvent</Typography.Title>
          <AuditTable events={data?.recent_audit_events ?? []} loading={query.isLoading} />
        </section>
      </div>
    </div>
  );
}

function PageHeader({ onRefresh, loading = false }: { onRefresh(): void; loading?: boolean }) {
  return (
    <div className="cp-page-header">
      <div>
        <h1>Dashboard</h1>
        <p>Registry 发布态、运行任务和审计工具调用的运营概览。</p>
      </div>
      <Button onClick={onRefresh} loading={loading} data-testid="dashboard-refresh">刷新</Button>
    </div>
  );
}

function ReleaseList({ releases, loading }: { releases: CapabilityRelease[]; loading: boolean }) {
  return (
    <List
      loading={loading}
      dataSource={releases}
      locale={{ emptyText: <EmptyState description="暂无发布记录" /> }}
      renderItem={(release) => (
        <List.Item>
          <List.Item.Meta
            title={`${release.resource_type}/${release.resource_id}@${release.resource_version}`}
            description={`${release.action} · ${release.operator_id} · ${formatDateTime(release.created_at)}`}
          />
          <StatusTag status={release.target_status} />
        </List.Item>
      )}
    />
  );
}

function TaskTable({ tasks, loading }: { tasks: TaskRun[]; loading: boolean }) {
  const columns: ColumnsType<TaskRun> = [
    { title: 'task_run_id', dataIndex: 'task_run_id', key: 'task_run_id' },
    { title: 'status', dataIndex: 'status', key: 'status', render: (value: string) => <Tag color="red">{value}</Tag> },
    { title: 'flow', key: 'flow', render: (_, row) => row.flow_id ? `${row.flow_id}@${row.flow_version ?? '-'}` : '-' },
    { title: 'error', dataIndex: 'error_code', key: 'error_code', render: (value: string | undefined) => value ?? '-' },
  ];
  return <Table size="small" rowKey="task_run_id" loading={loading} columns={columns} dataSource={tasks} pagination={false} />;
}

function ToolCallTable({ calls, loading }: { calls: ToolCallLog[]; loading: boolean }) {
  const columns: ColumnsType<ToolCallLog> = [
    { title: 'tool', dataIndex: 'tool_name', key: 'tool_name' },
    { title: 'status', dataIndex: 'status', key: 'status' },
    { title: 'risk', dataIndex: 'risk_level', key: 'risk_level', render: (value: string) => <RiskTag risk={value} /> },
    { title: 'created_at', dataIndex: 'created_at', key: 'created_at', render: formatDateTime },
  ];
  return <Table size="small" rowKey="tool_call_id" loading={loading} columns={columns} dataSource={calls} pagination={false} />;
}

function AuditTable({ events, loading }: { events: AuditEvent[]; loading: boolean }) {
  const columns: ColumnsType<AuditEvent> = [
    { title: 'action', dataIndex: 'action', key: 'action' },
    { title: 'target', key: 'target', render: (_, row) => `${row.target_type}/${row.target_id}` },
    { title: 'result', dataIndex: 'result', key: 'result' },
    { title: 'occurred_at', dataIndex: 'occurred_at', key: 'occurred_at', render: formatDateTime },
  ];
  return <Table size="small" rowKey="event_id" loading={loading} columns={columns} dataSource={events} pagination={false} />;
}
