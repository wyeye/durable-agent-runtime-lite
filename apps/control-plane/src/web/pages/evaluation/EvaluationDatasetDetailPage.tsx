import type { EvaluationCase, EvaluationDataset } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Descriptions, Drawer, InputNumber, Modal, Space, Switch, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { JsonEditor } from '../../components/JsonEditor.js';
import { useApiClient } from '../../api/use-api-client.js';
import {
  cloneDataset,
  createCase,
  deleteCase,
  getDataset,
  listCases,
  listDatasetVersions,
  publishDataset,
  rollbackDataset,
  updateCase,
  updateDataset,
  validateDataset,
} from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import { parseJson, stringifyPretty } from '../../utils/json.js';
import { CopyHashButton, EvaluationStatusTag, HashText, SafeJsonPreview } from './evaluation-utils.js';

export function EvaluationDatasetDetailPage() {
  const { datasetId, version } = useParams();
  const datasetVersion = Number(version);
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [datasetText, setDatasetText] = useState('');
  const [caseText, setCaseText] = useState('');
  const [caseDrawerOpen, setCaseDrawerOpen] = useState(false);
  const [editingCaseId, setEditingCaseId] = useState<string | undefined>();
  const [rollbackTarget, setRollbackTarget] = useState<number | undefined>();

  const datasetQuery = useQuery({
    queryKey: ['evaluation-dataset', datasetId, datasetVersion],
    enabled: Boolean(datasetId && datasetVersion),
    queryFn: ({ signal }) => getDataset(client, datasetId!, datasetVersion, { signal }),
  });

  const versionsQuery = useQuery({
    queryKey: ['evaluation-dataset-versions', datasetId],
    enabled: Boolean(datasetId),
    queryFn: ({ signal }) => listDatasetVersions(client, datasetId!, { signal }),
  });

  const casesQuery = useQuery({
    queryKey: ['evaluation-cases', datasetId, datasetVersion],
    enabled: Boolean(datasetId && datasetVersion),
    queryFn: ({ signal }) => listCases(client, datasetId!, datasetVersion, { signal }),
  });

  useEffect(() => {
    if (datasetQuery.data) {
      setDatasetText(stringifyPretty(datasetPatchView(datasetQuery.data)));
    }
  }, [datasetQuery.data]);

  const refresh = async (dataset?: EvaluationDataset) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['evaluation-dataset', datasetId, datasetVersion] }),
      queryClient.invalidateQueries({ queryKey: ['evaluation-dataset-versions', datasetId] }),
      queryClient.invalidateQueries({ queryKey: ['evaluation-cases', datasetId, datasetVersion] }),
      queryClient.invalidateQueries({ queryKey: ['evaluation-datasets'] }),
    ]);
    if (dataset && dataset.version !== datasetVersion) {
      navigate(`/evaluation/datasets/${encodeURIComponent(dataset.dataset_id)}/versions/${dataset.version}`);
    }
  };

  const updateDatasetMutation = useMutation({
    mutationFn: async () => {
      if (!datasetQuery.data || !datasetId) {
        throw new Error('Dataset 未加载');
      }
      const parsed = parseJson(datasetText);
      if (!parsed.ok) {
        throw new Error(parsed.error ?? 'JSON 格式错误');
      }
      return updateDataset(client, datasetId, datasetVersion, {
        dataset: parsed.value as Partial<EvaluationDataset>,
        expected_revision: datasetQuery.data.revision,
      });
    },
    onSuccess: async (dataset) => {
      message.success('Dataset draft 已保存');
      await refresh(dataset);
    },
  });

  const validateMutation = useMutation({
    mutationFn: () => validateDataset(client, datasetId!, datasetVersion),
    onSuccess: async (dataset) => {
      message.success('validate 已完成');
      await refresh(dataset);
    },
  });

  const publishMutation = useMutation({
    mutationFn: () => publishDataset(client, datasetId!, datasetVersion),
    onSuccess: async (dataset) => {
      message.success('Dataset 已发布');
      await refresh(dataset);
    },
  });

  const cloneMutation = useMutation({
    mutationFn: () => cloneDataset(client, datasetId!, datasetVersion),
    onSuccess: async (dataset) => {
      message.success('已 clone 新 draft');
      await refresh(dataset);
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: () => {
      if (!rollbackTarget || !datasetId) {
        throw new Error('请选择 rollback target_version');
      }
      return rollbackDataset(client, datasetId, { target_version: rollbackTarget });
    },
    onSuccess: async (dataset) => {
      message.success('Dataset rollback 已完成');
      setRollbackTarget(undefined);
      await refresh(dataset);
    },
  });

  const saveCaseMutation = useMutation({
    mutationFn: async () => {
      if (!datasetId) {
        throw new Error('缺少 dataset_id');
      }
      const parsed = parseJson(caseText);
      if (!parsed.ok) {
        throw new Error(parsed.error ?? 'JSON 格式错误');
      }
      const payload = parsed.value as EvaluationCase;
      return editingCaseId
        ? updateCase(client, editingCaseId, payload)
        : createCase(client, datasetId, datasetVersion, payload);
    },
    onSuccess: async () => {
      message.success(editingCaseId ? 'Case 已更新' : 'Case 已创建');
      setCaseDrawerOpen(false);
      setEditingCaseId(undefined);
      await refresh();
    },
  });

  const deleteCaseMutation = useMutation({
    mutationFn: (caseId: string) => deleteCase(client, caseId),
    onSuccess: async () => {
      message.success('Case 已删除');
      await refresh();
    },
  });

  const dataset = datasetQuery.data;
  const cases = casesQuery.data ?? [];
  const editable = dataset ? ['draft', 'validated'].includes(dataset.status) : false;
  const enabledCases = useMemo(() => cases.filter((item) => item.enabled).length, [cases]);

  const caseColumns: ColumnsType<EvaluationCase> = [
    {
      title: 'case',
      dataIndex: 'case_id',
      key: 'case_id',
      render: (value: string, row) => (
        <Button type="link" onClick={() => openCaseEditor(row)}>{value}</Button>
      ),
    },
    { title: 'enabled', dataIndex: 'enabled', key: 'enabled', render: (value: boolean) => <Switch size="small" checked={value} disabled /> },
    { title: 'weight', dataIndex: 'weight', key: 'weight', width: 90 },
    { title: 'expected status', dataIndex: 'expected_status', key: 'expected_status', render: (value: string | undefined) => value ?? '-' },
    { title: 'tool assertions', dataIndex: 'expected_tool_calls', key: 'tools', render: (value: unknown[]) => value?.length ?? 0 },
    { title: 'final assertions', dataIndex: 'final_assertions', key: 'final', render: (value: unknown[]) => value?.length ?? 0 },
    { title: 'performance budget', key: 'budget', render: (_, row) => budgetText(row) },
    {
      title: 'actions',
      key: 'actions',
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => openCaseEditor(row)}>编辑</Button>
          <Can permission="registry:write">
            <Button
              size="small"
              danger
              disabled={!editable}
              loading={deleteCaseMutation.isPending}
              onClick={() => {
                Modal.confirm({
                  title: `删除 ${row.case_id}`,
                  content: '仅 draft Dataset 的 Case 可删除。后端会再次校验权限与状态。',
                  onOk: () => deleteCaseMutation.mutate(row.case_id),
                });
              }}
            >
              删除
            </Button>
          </Can>
        </Space>
      ),
    },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>Dataset Detail</h1>
          <p><Link to="/evaluation/datasets">Evaluation Datasets</Link> / {datasetId}@{version}</p>
        </div>
        <Space wrap>
          <Button onClick={() => datasetQuery.refetch()} loading={datasetQuery.isFetching}>刷新</Button>
          <Can permission="registry:write">
            <Button onClick={() => cloneMutation.mutate()} loading={cloneMutation.isPending}>clone</Button>
          </Can>
          <Can permission="registry:validate">
            <Button disabled={!editable} onClick={() => validateMutation.mutate()} loading={validateMutation.isPending}>validate</Button>
          </Can>
          <Can permission="registry:publish">
            <Button
              type="primary"
              disabled={!editable}
              loading={publishMutation.isPending}
              onClick={() => {
                Modal.confirm({
                  title: 'Publish Dataset exact version',
                  content: '发布后 Dataset hash 将作为评测源，不会被运行中的 Evaluation Run 自动改写。',
                  onOk: () => publishMutation.mutate(),
                });
              }}
            >
              publish
            </Button>
          </Can>
        </Space>
      </div>
      <ReadOnlyNotice />
      {datasetQuery.error ? <ErrorAlert error={datasetQuery.error} /> : null}
      {updateDatasetMutation.error ? <ErrorAlert error={updateDatasetMutation.error} /> : null}
      {validateMutation.error ? <ErrorAlert error={validateMutation.error} /> : null}
      {publishMutation.error ? <ErrorAlert error={publishMutation.error} /> : null}
      {cloneMutation.error ? <ErrorAlert error={cloneMutation.error} /> : null}
      {rollbackMutation.error ? <ErrorAlert error={rollbackMutation.error} /> : null}
      {deleteCaseMutation.error ? <ErrorAlert error={deleteCaseMutation.error} /> : null}
      {dataset ? (
        <>
          <section className="cp-section">
            <Descriptions size="small" bordered column={{ xs: 1, md: 3 }}>
              <Descriptions.Item label="dataset_id">{dataset.dataset_id}</Descriptions.Item>
              <Descriptions.Item label="version">{dataset.version}</Descriptions.Item>
              <Descriptions.Item label="status"><EvaluationStatusTag status={dataset.status} /></Descriptions.Item>
              <Descriptions.Item label="revision">{dataset.revision}</Descriptions.Item>
              <Descriptions.Item label="domain">{dataset.domain ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="enabled cases">{enabledCases}/{cases.length}</Descriptions.Item>
              <Descriptions.Item label="dataset hash"><HashText value={dataset.dataset_hash} /></Descriptions.Item>
              <Descriptions.Item label="updated_at">{formatDateTime(dataset.updated_at)}</Descriptions.Item>
              <Descriptions.Item label="published_at">{formatDateTime(dataset.published_at)}</Descriptions.Item>
            </Descriptions>
            <div style={{ marginTop: 12 }}>
              <CopyHashButton value={dataset.dataset_hash} label="copy dataset hash" />
            </div>
          </section>
          <Tabs
            items={[
              {
                key: 'metadata',
                label: 'Metadata',
                children: (
                  <section className="cp-section">
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <JsonEditor value={datasetText} onChange={setDatasetText} readOnly={!editable} minRows={10} />
                      <Can permission="registry:write">
                        <Button
                          type="primary"
                          disabled={!editable}
                          loading={updateDatasetMutation.isPending}
                          onClick={() => updateDatasetMutation.mutate()}
                          data-testid="evaluation-dataset-save"
                        >
                          保存 draft
                        </Button>
                      </Can>
                      {!editable ? <Typography.Text type="secondary">published Dataset 只读；需要修改请 clone 新版本。</Typography.Text> : null}
                    </Space>
                  </section>
                ),
              },
              {
                key: 'cases',
                label: 'Cases',
                children: (
                  <section className="cp-section">
                    <div className="cp-page-header">
                      <div>
                        <Typography.Title level={4} style={{ margin: 0 }}>Case 列表</Typography.Title>
                        <Typography.Text type="secondary">只展示安全结构化断言，不提供 arbitrary code assertion editor。</Typography.Text>
                      </div>
                      <Can permission="registry:write">
                        <Button
                          type="primary"
                          disabled={!editable}
                          data-testid="evaluation-case-create"
                          onClick={() => openCaseEditor()}
                        >
                          创建 Case
                        </Button>
                      </Can>
                    </div>
                    {casesQuery.error ? <ErrorAlert error={casesQuery.error} /> : null}
                    <Table
                      style={{ marginTop: 12 }}
                      rowKey="case_id"
                      loading={casesQuery.isLoading}
                      columns={caseColumns}
                      dataSource={cases}
                      pagination={{ pageSize: 10 }}
                      locale={{ emptyText: <EmptyState description="暂无 Evaluation Case" /> }}
                    />
                  </section>
                ),
              },
              {
                key: 'versions',
                label: 'Versions',
                children: (
                  <section className="cp-section">
                    <Table
                      rowKey={(row) => `${row.dataset_id}:${row.version}`}
                      dataSource={versionsQuery.data ?? []}
                      loading={versionsQuery.isLoading}
                      pagination={false}
                      columns={[
                        { title: 'version', dataIndex: 'version', key: 'version' },
                        { title: 'status', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
                        { title: 'hash', dataIndex: 'dataset_hash', key: 'hash', render: (value: string | undefined) => <HashText value={value} /> },
                        {
                          title: 'open',
                          key: 'open',
                          render: (_, row) => <Link to={`/evaluation/datasets/${encodeURIComponent(row.dataset_id)}/versions/${row.version}`}>打开</Link>,
                        },
                      ]}
                    />
                    <Can permission="registry:rollback">
                      <Space style={{ marginTop: 12 }} wrap>
                        <InputNumber min={1} value={rollbackTarget ?? null} onChange={(value) => setRollbackTarget(typeof value === 'number' ? value : undefined)} placeholder="target_version" />
                        <Button
                          disabled={!rollbackTarget}
                          loading={rollbackMutation.isPending}
                          onClick={() => {
                            Modal.confirm({
                              title: 'Rollback Dataset pointer',
                              content: 'Rollback 只切换后端版本指针，运行中的 Evaluation Run 仍使用已锁定 Dataset 版本。',
                              onOk: () => rollbackMutation.mutate(),
                            });
                          }}
                        >
                          rollback
                        </Button>
                      </Space>
                    </Can>
                  </section>
                ),
              },
            ]}
          />
        </>
      ) : (
        <section className="cp-section"><EmptyState description="Dataset 未加载" /></section>
      )}
      <Drawer
        title={editingCaseId ? `编辑 Case ${editingCaseId}` : '创建 Case'}
        open={caseDrawerOpen}
        onClose={() => setCaseDrawerOpen(false)}
        width={820}
      >
        {saveCaseMutation.error ? <ErrorAlert error={saveCaseMutation.error} /> : null}
        <Space direction="vertical" style={{ width: '100%' }}>
          <JsonEditor value={caseText} onChange={setCaseText} minRows={18} readOnly={!editable} />
          <SafeJsonPreview value={{ note: '完整 Tool Result、raw Provider Response、hidden reasoning 不应写入 Case 编辑器。' }} maxHeight={120} />
          <Can permission="registry:write">
            <Button
              type="primary"
              disabled={!editable}
              loading={saveCaseMutation.isPending}
              onClick={() => saveCaseMutation.mutate()}
              data-testid="evaluation-case-submit"
            >
              保存 Case
            </Button>
          </Can>
        </Space>
      </Drawer>
    </div>
  );

  function openCaseEditor(row?: EvaluationCase) {
    const next = row ?? caseTemplate(datasetId ?? 'dataset_id', datasetVersion || 1);
    setEditingCaseId(row?.case_id);
    setCaseText(stringifyPretty(next));
    setCaseDrawerOpen(true);
  }
}

function datasetPatchView(dataset: EvaluationDataset): Partial<EvaluationDataset> {
  return {
    name: dataset.name,
    description: dataset.description,
    domain: dataset.domain,
    tags: dataset.tags ?? [],
    default_weight: dataset.default_weight,
  };
}

function caseTemplate(datasetId: string, version: number): EvaluationCase {
  return {
    case_id: `case_${Date.now()}`,
    dataset_id: datasetId,
    dataset_version: version,
    name: 'Evaluation case',
    input: { text: 'input text' },
    context_refs: [],
    expected_status: 'completed',
    expected_tool_calls: [],
    forbidden_tools: [],
    final_assertions: [{ type: 'non_empty' }],
    policy_assertions: [],
    weight: 1,
    tags: [],
    enabled: true,
  };
}

function budgetText(row: EvaluationCase): React.ReactNode {
  const values = [
    row.latency_budget_ms ? `${row.latency_budget_ms}ms` : undefined,
    row.total_token_budget ? `${row.total_token_budget} tokens` : undefined,
    row.cost_budget !== undefined ? `$${row.cost_budget}` : undefined,
  ].filter(Boolean);
  return values.length ? values.map((item) => <Tag key={item}>{item}</Tag>) : '-';
}
