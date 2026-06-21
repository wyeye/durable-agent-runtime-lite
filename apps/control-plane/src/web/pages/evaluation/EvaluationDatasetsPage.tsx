import type { EvaluationDataset, EvaluationDatasetStatus } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Drawer, Form, Input, InputNumber, Select, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { JsonEditor } from '../../components/JsonEditor.js';
import { useApiClient } from '../../api/use-api-client.js';
import { createDataset, listDatasets } from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import { parseJson, stringifyPretty } from '../../utils/json.js';
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
  const [createText, setCreateText] = useState(() => stringifyPretty(datasetTemplate()));

  const query = useQuery({
    queryKey: ['evaluation-datasets', filters],
    queryFn: ({ signal }) => listDatasets(client, { ...filters, page_size: 50 }, { signal }),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const parsed = parseJson(createText);
      if (!parsed.ok) {
        throw new Error(parsed.error ?? 'JSON 格式错误');
      }
      return createDataset(client, parsed.value as EvaluationDataset);
    },
    onSuccess: async (dataset) => {
      message.success('Dataset draft 已创建');
      setCreateOpen(false);
      setCreateText(stringifyPretty(datasetTemplate()));
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
    { title: 'name', dataIndex: 'name', key: 'name' },
    { title: 'version', dataIndex: 'version', key: 'version', width: 90 },
    { title: 'status', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
    { title: 'domain', dataIndex: 'domain', key: 'domain', render: (value: string | undefined) => value ?? '-' },
    { title: 'enabled cases', key: 'enabled', render: () => <Typography.Text type="secondary">详情页统计</Typography.Text> },
    { title: 'dataset hash', dataIndex: 'dataset_hash', key: 'dataset_hash', render: (value: string | undefined) => <HashText value={value} /> },
    { title: 'updated_at', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
    {
      title: 'versions',
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
          <h1>Evaluation Datasets</h1>
          <p>管理评测 Dataset exact version、Case 和发布 hash。</p>
        </div>
        <Can permission="registry:write">
          <Button type="primary" data-testid="evaluation-dataset-create" onClick={() => setCreateOpen(true)}>创建 draft</Button>
        </Can>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" onFinish={(values) => setFilters(clean(values))}>
          <Form.Item name="status"><Select allowClear placeholder="status" style={{ width: 150 }} options={statuses.map((status) => ({ value: status, label: status }))} /></Form.Item>
          <Form.Item name="dataset_id"><Input placeholder="dataset_id" style={{ width: 220 }} /></Form.Item>
          <Form.Item name="keyword"><Input data-testid="evaluation-dataset-keyword" placeholder="keyword" style={{ width: 220 }} /></Form.Item>
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
          locale={{ emptyText: <EmptyState description="暂无 Evaluation Dataset" /> }}
        />
      </section>
      <Drawer title="创建 Dataset draft" open={createOpen} onClose={() => setCreateOpen(false)} width={760}>
        {createMutation.error ? <ErrorAlert error={createMutation.error} /> : null}
        <Space direction="vertical" style={{ width: '100%' }}>
          <Form layout="inline" className="cp-filter-bar">
            <Form.Item label="version">
              <InputNumber value={1} min={1} disabled />
            </Form.Item>
          </Form>
          <JsonEditor value={createText} onChange={setCreateText} minRows={16} />
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

function datasetTemplate(): EvaluationDataset {
  return {
    dataset_id: `dataset_${Date.now()}`,
    version: 1,
    name: 'Evaluation dataset',
    status: 'draft',
    domain: 'runtime',
    tags: [],
    default_weight: 1,
    revision: 1,
  };
}

function clean(values: Record<string, unknown>): DatasetFilters {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ) as DatasetFilters;
}
