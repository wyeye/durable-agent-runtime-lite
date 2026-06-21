import type { EvaluationRun, EvaluationRunCreateRequest, EvaluationRunStatus, EvaluationSubjectType } from '@dar/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { App, Button, Form, Input, InputNumber, Modal, Select, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { cancelRun, createRun, listRuns, type EvaluationTriggerType } from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import { displayStatus } from '../../utils/i18n-labels.js';
import { EvaluationProgress, EvaluationScoreSummary, EvaluationStatusTag, HashText } from './evaluation-utils.js';

interface RunFilters {
  status?: EvaluationRunStatus;
  dataset_id?: string;
  resource_id?: string;
  trigger_type?: EvaluationTriggerType;
}

const statuses: EvaluationRunStatus[] = ['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'];
const triggers: EvaluationTriggerType[] = ['manual', 'publish_gate', 'regression', 'ci'];
const subjectTypes: EvaluationSubjectType[] = ['prompt', 'agent', 'model_policy'];

export function EvaluationRunsPage() {
  const client = useApiClient();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [filters, setFilters] = useState<RunFilters>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<EvaluationRunCreateRequest & { primary_subject_type?: EvaluationSubjectType; primary_subject_id?: string; primary_subject_version?: number }>();

  const query = useQuery({
    queryKey: ['evaluation-runs', filters],
    queryFn: ({ signal }) => listRuns(client, { ...filters, page_size: 50 }, { signal }),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const values = await form.validateFields();
      const input: EvaluationRunCreateRequest = {
        dataset_id: values.dataset_id,
        dataset_version: Number(values.dataset_version),
        dataset_hash: values.dataset_hash,
        subject_snapshot_ref: values.subject_snapshot_ref,
        subject_snapshot_hash: values.subject_snapshot_hash,
        evaluation_execution_plan_ref: values.evaluation_execution_plan_ref,
        evaluation_execution_plan_hash: values.evaluation_execution_plan_hash,
        trigger_type: values.trigger_type ?? 'manual',
        ...(values.baseline_run_id ? { baseline_run_id: values.baseline_run_id } : {}),
      };
      return createRun(client, input);
    },
    onSuccess: (result) => {
      message.success('评测任务已创建');
      setCreateOpen(false);
      navigate(`/evaluation/runs/${encodeURIComponent(result.evaluation_run.evaluation_run_id)}`);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (runId: string) => cancelRun(client, runId),
    onSuccess: async () => {
      message.success('取消已提交');
      await query.refetch();
    },
  });

  const columns: ColumnsType<EvaluationRun> = [
    {
      title: 'evaluation_run_id',
      dataIndex: 'evaluation_run_id',
      key: 'evaluation_run_id',
      render: (value: string) => <Link to={`/evaluation/runs/${encodeURIComponent(value)}`}>{value.slice(0, 18)}</Link>,
    },
    {
      title: '数据集',
      key: 'dataset',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.dataset_id}@{row.dataset_version}</span>
          <HashText value={row.dataset_hash} />
        </Space>
      ),
    },
    { title: '对象快照', dataIndex: 'subject_snapshot_ref', key: 'subject_snapshot_ref', render: (value: string) => value.slice(0, 28) },
    { title: '触发方式', dataIndex: 'trigger_type', key: 'trigger_type' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
    {
      title: '进度',
      key: 'progress',
      render: (_, row) => <EvaluationProgress completed={row.completed_cases} total={row.total_cases} status={row.status} />,
    },
    {
      title: '汇总',
      key: 'aggregate',
      render: (_, row) => (
        <EvaluationScoreSummary
          score={row.aggregate_score}
          passed={row.passed_cases}
          failed={row.failed_cases}
          systemErrors={row.system_error_cases}
        />
      ),
    },
    { title: '开始时间', dataIndex: 'started_at', key: 'started_at', render: formatDateTime },
    { title: '完成时间', dataIndex: 'completed_at', key: 'completed_at', render: formatDateTime },
    {
      title: '操作',
      key: 'actions',
      render: (_, row) => ['queued', 'running', 'cancelling'].includes(row.status) ? (
        <Can permission="registry:publish">
          <Button size="small" danger loading={cancelMutation.isPending} onClick={() => cancelMutation.mutate(row.evaluation_run_id)}>取消</Button>
        </Can>
      ) : null,
    },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>评测任务</h1>
          <p>查看真实评测运行状态、结果和门禁结论。</p>
        </div>
        <Space>
          <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
          <Can permission="registry:publish">
            <Button type="primary" data-testid="evaluation-run-create" onClick={() => setCreateOpen(true)}>创建评测任务</Button>
          </Can>
        </Space>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" onFinish={(values) => setFilters(clean(values))}>
          <Form.Item name="status"><Select allowClear placeholder="状态" style={{ width: 150 }} options={statuses.map((status) => ({ value: status, label: displayStatus(status) }))} /></Form.Item>
          <Form.Item name="dataset_id"><Input placeholder="dataset_id" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="resource_id"><Input placeholder="对象/资源 ID" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="trigger_type"><Select allowClear placeholder="触发方式" style={{ width: 150 }} options={triggers.map((trigger) => ({ value: trigger, label: trigger }))} /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      {cancelMutation.error ? <ErrorAlert error={cancelMutation.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="evaluation_run_id"
          loading={query.isLoading}
          columns={columns}
          dataSource={query.data ?? []}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无评测任务" /> }}
        />
      </section>
      <Modal
        title="创建评测任务"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createMutation.mutate()}
        confirmLoading={createMutation.isPending}
        okButtonProps={{ 'data-testid': 'evaluation-run-submit' }}
        width={760}
      >
        {createMutation.error ? <ErrorAlert error={createMutation.error} /> : null}
        <Form form={form} layout="vertical" initialValues={{ trigger_type: 'manual', dataset_version: 1, primary_subject_version: 1 }}>
          <Form.Item name="dataset_id" label="Dataset ID" rules={[{ required: true }]}><Input data-testid="evaluation-run-dataset-id" /></Form.Item>
          <Form.Item name="dataset_version" label="Dataset exact 版本" rules={[{ required: true }]}><InputNumber data-testid="evaluation-run-dataset-version" min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="dataset_hash" label="Dataset exact hash" rules={[{ required: true, len: 64 }]}><Input data-testid="evaluation-run-dataset-hash" /></Form.Item>
          <Form.Item name="primary_subject_type" label="主评测对象类型"><Select data-testid="evaluation-run-primary-subject-type" options={subjectTypes.map((type) => ({ value: type, label: type }))} /></Form.Item>
          <Form.Item name="primary_subject_id" label="主评测对象 ID"><Input data-testid="evaluation-run-primary-subject-id" /></Form.Item>
          <Form.Item name="primary_subject_version" label="主评测对象版本"><InputNumber data-testid="evaluation-run-primary-subject-version" min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="subject_snapshot_ref" label="对象快照引用" rules={[{ required: true }]}><Input data-testid="evaluation-run-subject-snapshot-ref" /></Form.Item>
          <Form.Item name="subject_snapshot_hash" label="对象快照 hash" rules={[{ required: true, len: 64 }]}><Input data-testid="evaluation-run-subject-snapshot-hash" /></Form.Item>
          <Form.Item name="evaluation_execution_plan_ref" label="EvaluationExecutionPlan ref" rules={[{ required: true }]}><Input data-testid="evaluation-run-execution-plan-ref" /></Form.Item>
          <Form.Item name="evaluation_execution_plan_hash" label="EvaluationExecutionPlan hash" rules={[{ required: true, len: 64 }]}><Input data-testid="evaluation-run-execution-plan-hash" /></Form.Item>
          <Form.Item name="baseline_run_id" label="可选基线任务"><Input data-testid="evaluation-run-baseline-run-id" /></Form.Item>
          <Form.Item name="trigger_type" label="触发方式" rules={[{ required: true }]}><Select data-testid="evaluation-run-trigger-type" options={triggers.map((trigger) => ({ value: trigger, label: trigger }))} /></Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function clean(values: Record<string, unknown>): RunFilters {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ) as RunFilters;
}
