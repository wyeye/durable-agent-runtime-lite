import type { EvaluationDataset, EvaluationDatasetStatus } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Drawer, Form, Input, InputNumber, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { createDataset, listDatasets } from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import { displayStatus } from '../../utils/i18n-labels.js';
import { FormErrorSummary } from '../../visual-config/components/FormErrorSummary.js';
import { ReadonlyJsonPreview } from '../../visual-config/components/ReadonlyJsonPreview.js';
import { issuesFromError } from '../../visual-config/form-error-mapper.js';
import { evaluationDatasetAdapter } from '../../visual-config/registry.js';
import { EvaluationDatasetVisualEditor } from '../../visual-config/editors/EvaluationDatasetVisualEditor.js';
import { useUnsavedChangeGuard } from '../../visual-config/useUnsavedChangeGuard.js';
import { EvaluationStatusTag, HashText } from './evaluation-utils.js';

const statuses: EvaluationDatasetStatus[] = ['draft', 'validated', 'published', 'deprecated', 'disabled'];

interface DatasetFilters {
  status?: EvaluationDatasetStatus;
  keyword?: string;
  dataset_id?: string;
}

export function EvaluationDatasetsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [filters, setFilters] = useState<DatasetFilters>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createSpec, setCreateSpec] = useState<EvaluationDataset>(() => evaluationDatasetAdapter.createDefault());
  const [createDirty, setCreateDirty] = useState(false);

  useUnsavedChangeGuard(createOpen && createDirty, '当前 Dataset 创建表单有未保存改动，确认离开吗？');

  const query = useQuery({
    queryKey: ['evaluation-datasets', filters],
    queryFn: ({ signal }) => listDatasets(client, { ...filters, page_size: 50 }, { signal }),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const parsed = evaluationDatasetAdapter.schema.safeParse(evaluationDatasetAdapter.formToSpec(createSpec));
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => issue.message).join('；'));
      }
      return createDataset(client, parsed.data);
    },
    onSuccess: async (dataset) => {
      message.success('评测数据集草稿已创建');
      setCreateOpen(false);
      setCreateSpec(evaluationDatasetAdapter.createDefault());
      setCreateDirty(false);
      await queryClient.invalidateQueries({ queryKey: ['evaluation-datasets'] });
      navigate(`/evaluation/datasets/${encodeURIComponent(dataset.dataset_id)}/versions/${dataset.version}`);
    },
  });

  const rows = useMemo(() => {
    const keyword = filters.keyword?.trim().toLowerCase();
    const items = query.data?.items ?? [];
    if (!keyword) {
      return items;
    }
    return items.filter((item) => [
      item.dataset_id,
      item.name,
      item.domain,
      item.dataset_hash,
      ...(item.tags ?? []),
    ].some((value) => value?.toLowerCase().includes(keyword)));
  }, [filters.keyword, query.data?.items]);

  const columns: ColumnsType<EvaluationDataset> = [
    {
      title: 'dataset_id',
      dataIndex: 'dataset_id',
      key: 'dataset_id',
      render: (value: string, row) => (
        <Link to={`/evaluation/datasets/${encodeURIComponent(value)}/versions/${row.version}`}>{value}</Link>
      ),
    },
    { title: '名称', dataIndex: 'name', key: 'name' },
    { title: '版本', dataIndex: 'version', key: 'version', width: 90 },
    { title: '状态', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
    { title: '领域', dataIndex: 'domain', key: 'domain', render: (value: string | undefined) => value ?? '-' },
    { title: '启用 Case', key: 'enabled', render: () => <Typography.Text type="secondary">详情页统计</Typography.Text> },
    { title: 'Dataset Hash', dataIndex: 'dataset_hash', key: 'dataset_hash', render: (value: string | undefined) => <HashText value={value} /> },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
    {
      title: '版本',
      key: 'versions',
      width: 100,
      render: (_, row) => (
        <Link to={`/evaluation/datasets/${encodeURIComponent(row.dataset_id)}/versions/${row.version}`}>查看</Link>
      ),
    },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>评测数据集</h1>
          <p>管理评测 Dataset exact version、Case 和发布 hash。</p>
        </div>
        <Can permission="registry:write">
          <Button
            type="primary"
            data-testid="evaluation-dataset-create"
            onClick={() => {
              setCreateOpen(true);
              setCreateDirty(false);
            }}
          >
            创建 draft
          </Button>
        </Can>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" onFinish={(values) => setFilters(clean(values))}>
          <Form.Item name="status"><Select allowClear placeholder="状态" style={{ width: 150 }} options={statuses.map((status) => ({ value: status, label: displayStatus(status) }))} /></Form.Item>
          <Form.Item name="dataset_id"><Input placeholder="dataset_id" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="keyword"><Input data-testid="evaluation-dataset-keyword" placeholder="关键字" style={{ width: 220 }} /></Form.Item>
          <Button htmlType="submit" data-testid="evaluation-dataset-search">查询</Button>
          <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
        </Form>
      </section>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      <section className="cp-section">
        <Table
          data-testid="evaluation-dataset-table"
          rowKey={(row) => `${row.dataset_id}:${row.version}`}
          loading={query.isLoading}
          columns={columns}
          dataSource={rows}
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <EmptyState description="暂无评测数据集" /> }}
        />
      </section>
      <Drawer
        title="创建评测数据集草稿"
        open={createOpen}
        onClose={() => {
          if (createDirty && !globalThis.confirm('当前 Dataset 创建表单有未保存改动，确认关闭吗？')) {
            return;
          }
          setCreateOpen(false);
          setCreateDirty(false);
        }}
        width={760}
      >
        {createMutation.error ? <ErrorAlert error={createMutation.error} /> : null}
        <Space direction="vertical" style={{ width: '100%' }}>
          <FormErrorSummary apiIssues={issuesFromError(createMutation.error)} />
          <Form layout="inline" className="cp-filter-bar">
            <Form.Item label="version">
              <InputNumber value={1} min={1} disabled />
            </Form.Item>
          </Form>
          <EvaluationDatasetVisualEditor
            value={createSpec}
            readOnly={false}
            onChange={(spec) => {
              setCreateSpec(spec);
              setCreateDirty(true);
            }}
          />
          <ReadonlyJsonPreview value={evaluationDatasetAdapter.getPreview(createSpec)} filename={`${createSpec.dataset_id}.json`} maxHeight={260} />
          <Button
            type="primary"
            loading={createMutation.isPending}
            onClick={() => createMutation.mutate()}
            data-testid="evaluation-dataset-submit"
          >
            提交 draft
          </Button>
        </Space>
      </Drawer>
    </div>
  );
}

function clean(values: Record<string, unknown>): DatasetFilters {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ) as DatasetFilters;
}
