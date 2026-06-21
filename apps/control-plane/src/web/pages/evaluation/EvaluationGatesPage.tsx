import type { EvaluationDatasetStatus, EvaluationGatePolicy } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Drawer, Form, Select, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { JsonEditor } from '../../components/JsonEditor.js';
import { useApiClient } from '../../api/use-api-client.js';
import { createGatePolicy, listGatePolicies } from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import { parseJson, stringifyPretty } from '../../utils/json.js';
import { EvaluationStatusTag, HashText } from './evaluation-utils.js';

const statuses: EvaluationDatasetStatus[] = ['draft', 'validated', 'published', 'deprecated', 'disabled'];

interface GateFilters {
  status?: EvaluationDatasetStatus;
}

export function EvaluationGatesPage() {
  const client = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [filters, setFilters] = useState<GateFilters>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createText, setCreateText] = useState(() => stringifyPretty({ policy: gatePolicyTemplate() }));

  const query = useQuery({
    queryKey: ['evaluation-gate-policies', filters],
    queryFn: ({ signal }) => listGatePolicies(client, { ...filters, page_size: 50 }, { signal }),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const parsed = parseJson(createText);
      if (!parsed.ok) {
        throw new Error(parsed.error ?? 'JSON 格式错误');
      }
      return createGatePolicy(client, parsed.value as { policy: EvaluationGatePolicy });
    },
    onSuccess: async (policy) => {
      message.success('Gate Policy draft 已创建');
      setCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['evaluation-gate-policies'] });
      navigate(`/evaluation/gates/${encodeURIComponent(policy.gate_policy_id)}/versions/${policy.version}`);
    },
  });

  const columns: ColumnsType<EvaluationGatePolicy> = [
    {
      title: 'gate_policy_id',
      dataIndex: 'gate_policy_id',
      key: 'gate_policy_id',
      render: (value: string, row) => (
        <Link to={`/evaluation/gates/${encodeURIComponent(value)}/versions/${row.version}`}>{value}</Link>
      ),
    },
    { title: 'version', dataIndex: 'version', key: 'version', width: 90 },
    { title: 'status', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
    { title: 'resource types', dataIndex: 'resource_types', key: 'resource_types', render: (values: string[]) => values.join(', ') },
    { title: 'required datasets', dataIndex: 'required_dataset_refs', key: 'datasets', render: (values: EvaluationGatePolicy['required_dataset_refs']) => values.map((ref) => `${ref.dataset_id}@${ref.version}`).join(', ') },
    { title: 'allow_override', dataIndex: 'allow_override', key: 'allow_override', render: String },
    { title: 'hash', dataIndex: 'gate_policy_hash', key: 'hash', render: (value: string | undefined) => <HashText value={value} /> },
    { title: 'updated_at', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>Evaluation Gates</h1>
          <p>管理 Gate Policy exact Dataset refs，并查看 Gate Decision。</p>
        </div>
        <Space>
          <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
          <Can permission="registry:write">
            <Button type="primary" data-testid="evaluation-gate-create" onClick={() => setCreateOpen(true)}>创建 draft</Button>
          </Can>
        </Space>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" onFinish={(values) => setFilters(clean(values))}>
          <Form.Item name="status"><Select allowClear placeholder="status" style={{ width: 160 }} options={statuses.map((status) => ({ value: status, label: status }))} /></Form.Item>
          <Button htmlType="submit">查询</Button>
        </Form>
      </section>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey={(row) => `${row.gate_policy_id}:${row.version}`}
          loading={query.isLoading}
          columns={columns}
          dataSource={query.data?.items ?? []}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无 Gate Policy" /> }}
        />
      </section>
      <Drawer title="创建 Gate Policy draft" open={createOpen} onClose={() => setCreateOpen(false)} width={820}>
        {createMutation.error ? <ErrorAlert error={createMutation.error} /> : null}
        <Space direction="vertical" style={{ width: '100%' }}>
          <JsonEditor value={createText} onChange={setCreateText} minRows={18} />
          <Button type="primary" loading={createMutation.isPending} onClick={() => createMutation.mutate()}>提交 draft</Button>
        </Space>
      </Drawer>
    </div>
  );
}

function gatePolicyTemplate(): EvaluationGatePolicy {
  return {
    gate_policy_id: `gate_policy_${Date.now()}`,
    version: 1,
    status: 'draft',
    resource_types: ['prompt', 'agent', 'model_policy'],
    required_dataset_refs: [{
      dataset_id: 'published_dataset_id',
      version: 1,
      dataset_hash: 'a'.repeat(64),
    }],
    thresholds: {
      minimum_pass_rate: 1,
      minimum_weighted_score: 1,
      minimum_tool_selection_score: 0,
      maximum_forbidden_tool_calls: 0,
      maximum_policy_violations: 0,
      maximum_side_effect_without_approval: 0,
      maximum_secret_leaks: 0,
      maximum_hidden_reasoning_leaks: 0,
      maximum_cross_tenant_violations: 0,
      maximum_system_error_rate: 0,
    },
    regression_rules: {
      maximum_score_regression: 0,
      maximum_pass_rate_regression: 0,
      maximum_latency_regression_percent: 0,
      maximum_token_regression_percent: 0,
      maximum_cost_regression_percent: 0,
      block_newly_failed_cases: true,
      block_safety_regression: true,
      block_tool_regression: true,
      require_same_dataset: true,
    },
    required_case_tags: [],
    allow_override: true,
    revision: 1,
  };
}

function clean(values: Record<string, unknown>): GateFilters {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ) as GateFilters;
}
