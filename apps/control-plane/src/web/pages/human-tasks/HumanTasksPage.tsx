import type { HumanTask } from '@dar/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { App, Button, Drawer, Form, Input, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useSearchParams } from 'react-router';
import { useState } from 'react';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { ConfirmActionModal } from '../../components/ConfirmActionModal.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { RiskTag } from '../../components/RiskTag.js';
import { useApiClient } from '../../api/use-api-client.js';
import { approveHumanTask, getHumanTask, listHumanTasks, rejectHumanTask } from '../../api/operations-api.js';
import { formatDateTime } from '../../utils/format.js';
import { displayStatus } from '../../utils/i18n-labels.js';
import { stringifyPretty } from '../../utils/json.js';

const statuses = ['created', 'assigned', 'pending', 'approved', 'resolved', 'rejected', 'cancelled', 'expired'];

export function HumanTasksPage() {
  const client = useApiClient();
  const { message } = App.useApp();
  const [searchParams] = useSearchParams();
  const initialTaskRun = searchParams.get('task_run_id') ?? '';
  const [filters, setFilters] = useState<Record<string, string>>({ page_size: '50', ...(initialTaskRun ? { task_run_id: initialTaskRun } : {}) });
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [decision, setDecision] = useState<'approve' | 'reject' | undefined>();

  const listQuery = useQuery({
    queryKey: ['human-tasks', filters],
    queryFn: () => listHumanTasks(client, filters),
  });

  const detailQuery = useQuery({
    queryKey: ['human-task', selectedId],
    enabled: Boolean(selectedId),
    queryFn: () => getHumanTask(client, selectedId!),
  });

  const decisionMutation = useMutation({
    mutationFn: async (values: { release_note: string }) => {
      if (!selectedId || !decision) {
        throw new Error('请选择人工任务和审批动作');
      }
      return decision === 'approve'
        ? approveHumanTask(client, selectedId, values.release_note)
        : rejectHumanTask(client, selectedId, values.release_note);
    },
    onSuccess: async () => {
      message.success('审批操作已完成');
      setDecision(undefined);
      await Promise.all([listQuery.refetch(), detailQuery.refetch()]);
    },
  });

  const columns: ColumnsType<HumanTask> = [
    { title: '人工任务 ID', dataIndex: 'human_task_id', key: 'human_task_id', render: (value: string) => <Button type="link" onClick={() => setSelectedId(value)}>{value}</Button> },
    { title: '状态', dataIndex: 'status', key: 'status', render: (value: string) => <Tag>{displayStatus(value)}</Tag> },
    { title: 'task_run_id', dataIndex: 'task_run_id', key: 'task_run_id' },
    { title: 'workflow_id', dataIndex: 'workflow_id', key: 'workflow_id', render: (value: string | undefined) => value ?? '-' },
    { title: '风险', key: 'risk', render: (_, row) => <RiskTag risk={riskFromPayload(row.payload)} /> },
    { title: '创建时间', dataIndex: 'created_at', key: 'created_at', render: formatDateTime },
    {
      title: '审批',
      key: 'decision',
      render: (_, row) => row.status === 'pending' ? (
        <Can permission="human_task:decide">
          <Space>
            <Button size="small" type="primary" onClick={() => { setSelectedId(row.human_task_id); setDecision('approve'); }} data-testid="human-approve">批准</Button>
            <Button size="small" danger onClick={() => { setSelectedId(row.human_task_id); setDecision('reject'); }} data-testid="human-reject">拒绝</Button>
          </Space>
        </Can>
      ) : '-',
    },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>人工任务</h1>
          <p>查看和审批 L3/L4 或人工介入任务，状态机仍由 runtime-api/Temporal 维护。</p>
        </div>
        <Button onClick={() => listQuery.refetch()} loading={listQuery.isFetching}>刷新</Button>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" initialValues={filters} onFinish={(values) => setFilters({ page_size: '50', ...clean(values) })}>
          <Form.Item name="status"><Select allowClear placeholder="状态" style={{ width: 160 }} options={statuses.map((status) => ({ value: status, label: displayStatus(status) }))} /></Form.Item>
          <Form.Item name="task_run_id"><Input placeholder="task_run_id" /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {listQuery.error ? <ErrorAlert error={listQuery.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="human_task_id"
          loading={listQuery.isLoading}
          columns={columns}
          dataSource={listQuery.data?.human_tasks ?? []}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无人工任务" /> }}
        />
      </section>
      <Drawer title="人工任务详情" open={Boolean(selectedId)} onClose={() => setSelectedId(undefined)} width={720}>
        {detailQuery.error ? <ErrorAlert error={detailQuery.error} /> : null}
        {detailQuery.data?.human_task ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Title level={4}>{detailQuery.data.human_task.human_task_id}</Typography.Title>
            <div className="cp-risk-line">
              <Tag>{displayStatus(detailQuery.data.human_task.status)}</Tag>
              <RiskTag risk={riskFromPayload(detailQuery.data.human_task.payload)} />
            </div>
            <Typography.Title level={5}>工具预览 / 载荷</Typography.Title>
            <pre className="cp-json-pre">{stringifyPretty(detailQuery.data.human_task.payload)}</pre>
            <Typography.Title level={5}>审批历史</Typography.Title>
            <pre className="cp-json-pre">{stringifyPretty({
              decision: detailQuery.data.human_task.decision,
              decided_by: detailQuery.data.human_task.decided_by,
              decided_at: detailQuery.data.human_task.decided_at,
              decision_reason: detailQuery.data.human_task.decision_reason,
            })}</pre>
          </Space>
        ) : null}
      </Drawer>
      <ConfirmActionModal
        title={decision === 'approve' ? '批准人工任务' : '拒绝人工任务'}
        open={Boolean(decision)}
        loading={decisionMutation.isPending}
        noteLabel="审批原因"
        onCancel={() => setDecision(undefined)}
        onConfirm={(values) => decisionMutation.mutate({ release_note: values.release_note })}
      />
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

function riskFromPayload(payload: Record<string, unknown>): string | undefined {
  const risk = payload.risk_level ?? payload.risk;
  return typeof risk === 'string' ? risk : undefined;
}
