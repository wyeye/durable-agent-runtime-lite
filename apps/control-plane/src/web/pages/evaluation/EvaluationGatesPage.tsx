import type { EvaluationDatasetStatus, EvaluationGatePolicy } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Drawer, Form, Select, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { createGatePolicy, listGatePolicies } from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import { displayStatus } from '../../utils/i18n-labels.js';
import { FormErrorSummary } from '../../visual-config/components/FormErrorSummary.js';
import { ReadonlyJsonPreview } from '../../visual-config/components/ReadonlyJsonPreview.js';
import { issuesFromError } from '../../visual-config/form-error-mapper.js';
import { evaluationGatePolicyAdapter } from '../../visual-config/registry.js';
import { EvaluationGatePolicyVisualEditor } from '../../visual-config/editors/EvaluationGatePolicyVisualEditor.js';
import { useUnsavedChangeGuard } from '../../visual-config/useUnsavedChangeGuard.js';
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
  const [createSpec, setCreateSpec] = useState<EvaluationGatePolicy>(() => evaluationGatePolicyAdapter.createDefault());
  const [createDirty, setCreateDirty] = useState(false);

  useUnsavedChangeGuard(createOpen && createDirty, '当前 Gate Policy 创建表单有未保存改动，确认离开吗？');

  const query = useQuery({
    queryKey: ['evaluation-gate-policies', filters],
    queryFn: ({ signal }) => listGatePolicies(client, { ...filters, page_size: 50 }, { signal }),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const parsed = evaluationGatePolicyAdapter.schema.safeParse(evaluationGatePolicyAdapter.formToSpec(createSpec));
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => issue.message).join('；'));
      }
      return createGatePolicy(client, { policy: parsed.data });
    },
    onSuccess: async (policy) => {
      message.success('发布门禁策略草稿已创建');
      setCreateOpen(false);
      setCreateDirty(false);
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
    { title: '版本', dataIndex: 'version', key: 'version', width: 90 },
    { title: '状态', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
    { title: '资源类型', dataIndex: 'resource_types', key: 'resource_types', render: (values: string[]) => values.join(', ') },
    { title: '必需数据集', dataIndex: 'required_dataset_refs', key: 'datasets', render: (values: EvaluationGatePolicy['required_dataset_refs']) => values.map((ref) => `${ref.dataset_id}@${ref.version}`).join(', ') },
    { title: 'allow_override', dataIndex: 'allow_override', key: 'allow_override', render: String },
    { title: 'hash', dataIndex: 'gate_policy_hash', key: 'hash', render: (value: string | undefined) => <HashText value={value} /> },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>发布门禁</h1>
          <p>管理 Gate Policy 的 exact Dataset 引用，并查看门禁结论。</p>
        </div>
        <Space>
          <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
          <Can permission="registry:write">
            <Button
              type="primary"
              data-testid="evaluation-gate-create"
              onClick={() => {
                setCreateOpen(true);
                setCreateDirty(false);
              }}
            >
              创建 draft
            </Button>
          </Can>
        </Space>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" onFinish={(values) => setFilters(clean(values))}>
          <Form.Item name="status"><Select allowClear placeholder="状态" style={{ width: 160 }} options={statuses.map((status) => ({ value: status, label: displayStatus(status) }))} /></Form.Item>
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
          locale={{ emptyText: <EmptyState description="暂无发布门禁策略" /> }}
        />
      </section>
      <Drawer
        title="创建发布门禁策略草稿"
        open={createOpen}
        onClose={() => {
          if (createDirty && !globalThis.confirm('当前 Gate Policy 创建表单有未保存改动，确认关闭吗？')) {
            return;
          }
          setCreateOpen(false);
          setCreateDirty(false);
        }}
        width={820}
      >
        {createMutation.error ? <ErrorAlert error={createMutation.error} /> : null}
        <Space direction="vertical" style={{ width: '100%' }}>
          <FormErrorSummary apiIssues={issuesFromError(createMutation.error)} />
          <EvaluationGatePolicyVisualEditor
            value={createSpec}
            readOnly={false}
            onChange={(spec) => {
              setCreateSpec(spec);
              setCreateDirty(true);
            }}
            client={client}
          />
          <ReadonlyJsonPreview value={{ policy: evaluationGatePolicyAdapter.getPreview(createSpec) }} filename={`${createSpec.gate_policy_id}.json`} maxHeight={260} />
          <Button type="primary" loading={createMutation.isPending} onClick={() => createMutation.mutate()}>提交 draft</Button>
        </Space>
      </Drawer>
    </div>
  );
}

function clean(values: Record<string, unknown>): GateFilters {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ) as GateFilters;
}
