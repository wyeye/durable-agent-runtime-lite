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
      message.success('Evaluation Run 已创建');
      setCreateOpen(false);
      navigate(`/evaluation/runs/${encodeURIComponent(result.evaluation_run.evaluation_run_id)}`);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: (runId: string) => cancelRun(client, runId),
    onSuccess: async () => {
      message.success('cancel 已提交');
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
      title: 'dataset',
      key: 'dataset',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>{row.dataset_id}@{row.dataset_version}</span>
          <HashText value={row.dataset_hash} />
        </Space>
      ),
    },
    { title: 'subject snapshot', dataIndex: 'subject_snapshot_ref', key: 'subject_snapshot_ref', render: (value: string) => value.slice(0, 28) },
    { title: 'trigger', dataIndex: 'trigger_type', key: 'trigger_type' },
    { title: 'status', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
    {
      title: 'progress',
      key: 'progress',
      render: (_, row) => <EvaluationProgress completed={row.completed_cases} total={row.total_cases} status={row.status} />,
    },
    {
      title: 'aggregate',
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
    { title: 'started_at', dataIndex: 'started_at', key: 'started_at', render: formatDateTime },
    { title: 'completed_at', dataIndex: 'completed_at', key: 'completed_at', render: formatDateTime },
    {
      title: 'actions',
      key: 'actions',
      render: (_, row) => ['queued', 'running', 'cancelling'].includes(row.status) ? (
        <Can permission="registry:publish">
          <Button size="small" danger loading={cancelMutation.isPending} onClick={() => cancelMutation.mutate(row.evaluation_run_id)}>cancel</Button>
        </Can>
      ) : null,
    },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>Evaluation Runs</h1>
          <p>查看真实 Evaluation Runtime 运行状态、结果和 Gate Decision。</p>
        </div>
        <Space>
          <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
          <Can permission="registry:publish">
            <Button type="primary" data-testid="evaluation-run-create" onClick={() => setCreateOpen(true)}>创建 Run</Button>
          </Can>
        </Space>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" onFinish={(values) => setFilters(clean(values))}>
          <Form.Item name="status"><Select allowClear placeholder="status" style={{ width: 150 }} options={statuses.map((status) => ({ value: status, label: status }))} /></Form.Item>
          <Form.Item name="dataset_id"><Input placeholder="dataset_id" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="resource_id"><Input placeholder="subject/resource id" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="trigger_type"><Select allowClear placeholder="trigger" style={{ width: 150 }} options={triggers.map((trigger) => ({ value: trigger, label: trigger }))} /></Form.Item>
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
          locale={{ emptyText: <EmptyState description="暂无 Evaluation Run" /> }}
        />
      </section>
      <Modal
        title="Create Evaluation Run"
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
          <Form.Item name="dataset_version" label="Dataset exact version" rules={[{ required: true }]}><InputNumber data-testid="evaluation-run-dataset-version" min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="dataset_hash" label="Dataset exact hash" rules={[{ required: true, len: 64 }]}><Input data-testid="evaluation-run-dataset-hash" /></Form.Item>
          <Form.Item name="primary_subject_type" label="Primary subject type"><Select data-testid="evaluation-run-primary-subject-type" options={subjectTypes.map((type) => ({ value: type, label: type }))} /></Form.Item>
          <Form.Item name="primary_subject_id" label="Primary subject id"><Input data-testid="evaluation-run-primary-subject-id" /></Form.Item>
          <Form.Item name="primary_subject_version" label="Primary subject version"><InputNumber data-testid="evaluation-run-primary-subject-version" min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="subject_snapshot_ref" label="Subject snapshot ref" rules={[{ required: true }]}><Input data-testid="evaluation-run-subject-snapshot-ref" /></Form.Item>
          <Form.Item name="subject_snapshot_hash" label="Subject snapshot hash" rules={[{ required: true, len: 64 }]}><Input data-testid="evaluation-run-subject-snapshot-hash" /></Form.Item>
          <Form.Item name="evaluation_execution_plan_ref" label="EvaluationExecutionPlan ref" rules={[{ required: true }]}><Input data-testid="evaluation-run-execution-plan-ref" /></Form.Item>
          <Form.Item name="evaluation_execution_plan_hash" label="EvaluationExecutionPlan hash" rules={[{ required: true, len: 64 }]}><Input data-testid="evaluation-run-execution-plan-hash" /></Form.Item>
          <Form.Item name="baseline_run_id" label="Optional baseline run"><Input data-testid="evaluation-run-baseline-run-id" /></Form.Item>
          <Form.Item name="trigger_type" label="Trigger type" rules={[{ required: true }]}><Select data-testid="evaluation-run-trigger-type" options={triggers.map((trigger) => ({ value: trigger, label: trigger }))} /></Form.Item>
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
