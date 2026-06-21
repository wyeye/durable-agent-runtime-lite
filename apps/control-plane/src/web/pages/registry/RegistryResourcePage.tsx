import type { CapabilityRelease, RegistryResourceType, RegistryValidationResult, SpecStatus } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Divider, Drawer, Form, Input, InputNumber, Select, Space, Table, Tabs, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { ConfirmActionModal, type ConfirmActionValues } from '../../components/ConfirmActionModal.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { JsonEditor } from '../../components/JsonEditor.js';
import { ReleaseActionButtons, type ReleaseAction } from '../../components/ReleaseActionButtons.js';
import { StatusTag } from '../../components/StatusTag.js';
import { ValidationResult } from '../../components/ValidationResult.js';
import { VersionSelector } from '../../components/VersionSelector.js';
import { useApiClient } from '../../api/use-api-client.js';
import {
  cloneVersion,
  createDraft,
  deprecateResource,
  disableResource,
  getVersion,
  grayResource,
  listReleaseHistory,
  listResources,
  listVersions,
  publishResource,
  rollbackResource,
  updateDraft,
  validateResource,
  type RegistryRecord,
} from '../../api/registry-api.js';
import { formatDateTime } from '../../utils/format.js';
import { parseJson, stringifyPretty } from '../../utils/json.js';
import { EvaluationGateCard, type GatePublishMetadata } from '../evaluation/EvaluationGateCard.js';
import { resourceConfigs } from './resource-config.js';

interface Filters {
  status?: SpecStatus;
  keyword?: string;
  resource_id?: string;
}

interface CreateState {
  open: boolean;
  text: string;
}

const statuses: SpecStatus[] = ['draft', 'validated', 'published', 'gray', 'deprecated', 'disabled'];

export function RegistryResourcePage({ resourceType }: { resourceType: RegistryResourceType }) {
  const config = resourceConfigs[resourceType];
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [filters, setFilters] = useState<Filters>({});
  const [selected, setSelected] = useState<RegistryRecord | undefined>();
  const [editorText, setEditorText] = useState('');
  const [validation, setValidation] = useState<RegistryValidationResult | undefined>();
  const [createState, setCreateState] = useState<CreateState>({ open: false, text: stringifyPretty(config.makeDraftTemplate()) });
  const [action, setAction] = useState<ReleaseAction | undefined>();
  const [cloneTarget, setCloneTarget] = useState<number | undefined>();
  const [compareLeft, setCompareLeft] = useState<number | undefined>();
  const [compareRight, setCompareRight] = useState<number | undefined>();
  const [gatePublishMetadata, setGatePublishMetadata] = useState<GatePublishMetadata>({});

  const listQuery = useQuery({
    queryKey: ['registry', resourceType, filters],
    queryFn: () => listResources(apiClient, resourceType, { ...filters, page_size: 50 }),
  });

  const versionsQuery = useQuery({
    queryKey: ['registry-versions', resourceType, selected?.resource_id],
    enabled: Boolean(selected?.resource_id),
    queryFn: () => listVersions(apiClient, resourceType, selected!.resource_id),
  });

  const releaseQuery = useQuery({
    queryKey: ['registry-releases', resourceType, selected?.resource_id],
    enabled: Boolean(selected?.resource_id),
    queryFn: () => listReleaseHistory(apiClient, resourceType, selected!.resource_id),
  });

  const compareLeftQuery = useQuery({
    queryKey: ['registry-compare-left', resourceType, selected?.resource_id, compareLeft],
    enabled: Boolean(selected?.resource_id && compareLeft),
    queryFn: () => getVersion(apiClient, resourceType, selected!.resource_id, compareLeft!),
  });

  const compareRightQuery = useQuery({
    queryKey: ['registry-compare-right', resourceType, selected?.resource_id, compareRight],
    enabled: Boolean(selected?.resource_id && compareRight),
    queryFn: () => getVersion(apiClient, resourceType, selected!.resource_id, compareRight!),
  });

  const refreshSelected = async (record: RegistryRecord) => {
    setSelected(record);
    setEditorText(stringifyPretty(record.spec));
    setValidation(undefined);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['registry', resourceType] }),
      queryClient.invalidateQueries({ queryKey: ['registry-versions', resourceType, record.resource_id] }),
      queryClient.invalidateQueries({ queryKey: ['registry-releases', resourceType, record.resource_id] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const parsed = parseJson(createState.text);
      if (!parsed.ok) {
        throw new Error(parsed.error ?? 'JSON 格式错误');
      }
      return createDraft(apiClient, resourceType, parsed.value);
    },
    onSuccess: async (record) => {
      message.success('draft 已创建');
      setCreateState({ open: false, text: stringifyPretty(config.makeDraftTemplate()) });
      await refreshSelected(record);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!selected) {
        throw new Error('请选择版本');
      }
      const parsed = parseJson(editorText);
      if (!parsed.ok) {
        throw new Error(parsed.error ?? 'JSON 格式错误');
      }
      return updateDraft(apiClient, resourceType, selected.resource_id, selected.version, parsed.value, selected.revision);
    },
    onSuccess: async (record) => {
      message.success('draft 已更新，revision 已刷新');
      await refreshSelected(record);
    },
  });

  const validateMutation = useMutation({
    mutationFn: async () => {
      if (!selected) {
        throw new Error('请选择版本');
      }
      return validateResource(apiClient, resourceType, selected.resource_id, selected.version);
    },
    onSuccess: ({ validation: next }) => {
      setValidation(next);
      message.success(next.can_publish ? 'validate 通过' : 'validate 完成但暂不可发布');
    },
  });

  const cloneMutation = useMutation({
    mutationFn: async () => {
      if (!selected) {
        throw new Error('请选择版本');
      }
      return cloneVersion(apiClient, resourceType, selected.resource_id, selected.version, cloneTarget);
    },
    onSuccess: async (record) => {
      setCloneTarget(undefined);
      message.success('已 clone 新 draft 版本');
      await refreshSelected(record);
    },
  });

  const releaseMutation = useMutation({
    mutationFn: async (values: ConfirmActionValues) => {
      if (!selected || !action) {
        throw new Error('请选择版本和操作');
      }
      const base = { release_note: values.release_note, metadata_json: {} };
      if (action === 'publish') {
        return publishResource(apiClient, resourceType, selected.resource_id, selected.version, {
          ...base,
          ...gatePublishMetadata,
        });
      }
      if (action === 'gray') {
        return grayResource(apiClient, resourceType, selected.resource_id, selected.version, {
          ...base,
          tenant_allowlist: splitCsv(values.tenant_allowlist),
          user_allowlist: splitCsv(values.user_allowlist),
        });
      }
      if (action === 'deprecate') {
        return deprecateResource(apiClient, resourceType, selected.resource_id, selected.version, base);
      }
      if (action === 'disable') {
        return disableResource(apiClient, resourceType, selected.resource_id, selected.version, base);
      }
      if (action === 'rollback' && values.target_version) {
        return rollbackResource(apiClient, resourceType, selected.resource_id, {
          ...base,
          target_version: values.target_version,
        });
      }
      throw new Error('不支持的操作');
    },
    onSuccess: async () => {
      message.success('发布操作已完成');
      setAction(undefined);
      if (selected) {
        const next = await getVersion(apiClient, resourceType, selected.resource_id, selected.version);
        await refreshSelected(next);
      }
    },
  });

  const records = listQuery.data?.items ?? [];
  const versions = versionsQuery.data ?? [];
  const editable = selected ? ['draft', 'validated'].includes(selected.status) : false;
  const selectedVersionOptions = versions.map((record) => record.version).sort((a, b) => a - b);

  const columns = useMemo<ColumnsType<RegistryRecord>>(() => [
    {
      title: config.idLabel,
      dataIndex: 'resource_id',
      key: 'resource_id',
      render: (value: string, record) => (
        <Button
          type="link"
          onClick={() => {
            setSelected(record);
            setEditorText(stringifyPretty(record.spec));
            setValidation(undefined);
            setCompareLeft(undefined);
            setCompareRight(undefined);
          }}
        >
          {value}
        </Button>
      ),
    },
    { title: 'version', dataIndex: 'version', key: 'version', width: 90 },
    { title: 'status', dataIndex: 'status', key: 'status', render: (status: SpecStatus) => <StatusTag status={status} /> },
    { title: 'revision', dataIndex: 'revision', key: 'revision', width: 90 },
    { title: 'extra', key: 'extra', render: (_, record) => config.renderListExtra?.(record) ?? null },
    { title: 'updated_by', dataIndex: 'updated_by', key: 'updated_by', render: (value: string | undefined) => value ?? '-' },
    { title: 'updated_at', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
  ], [config]);

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>{config.title}</h1>
          <p>{config.description}</p>
        </div>
        <Can permission="registry:write">
          <Button
            type="primary"
            data-testid="registry-create"
            onClick={() => setCreateState({ open: true, text: stringifyPretty(config.makeDraftTemplate()) })}
          >
            创建 draft
          </Button>
        </Can>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form
          layout="inline"
          className="cp-filter-bar"
          onFinish={(values: Filters) => setFilters(cleanFilters(values))}
        >
          <Form.Item name="status">
            <Select allowClear placeholder="status" style={{ width: 160 }} options={statuses.map((status) => ({ value: status, label: status }))} />
          </Form.Item>
          <Form.Item name="resource_id">
            <Input placeholder={config.idLabel} style={{ width: 220 }} />
          </Form.Item>
          <Form.Item name="keyword">
            <Input data-testid="registry-keyword" placeholder="keyword" style={{ width: 220 }} />
          </Form.Item>
          <Button htmlType="submit" data-testid="registry-search">查询</Button>
          <Button onClick={() => listQuery.refetch()}>刷新</Button>
        </Form>
      </section>
      {listQuery.error ? <ErrorAlert error={listQuery.error} /> : null}
      <div className="cp-split">
        <section className="cp-section">
          <Table
            data-testid="registry-table"
            rowKey={(record) => `${record.resource_id}:${record.version}`}
            loading={listQuery.isLoading}
            columns={columns}
            dataSource={records}
            pagination={{ pageSize: 10 }}
            locale={{ emptyText: <EmptyState description="没有匹配的 Registry 资源" /> }}
          />
        </section>
        <section className="cp-section">
          {selected ? (
            <>
              <Space direction="vertical" style={{ width: '100%' }} size="middle">
                <div className="cp-page-header">
                  <div>
                    <Typography.Title level={3} style={{ margin: 0 }}>
                      {selected.resource_id}@{selected.version} <StatusTag status={selected.status} />
                    </Typography.Title>
                    <Typography.Text type="secondary">revision {selected.revision} · sha256 {selected.sha256.slice(0, 12)}</Typography.Text>
                  </div>
                  <ReleaseActionButtons
                    status={selected.status}
                    disabled={releaseMutation.isPending || validateMutation.isPending}
                    onAction={(nextAction) => {
                      if (nextAction === 'validate') {
                        validateMutation.mutate();
                        return;
                      }
                      if (nextAction === 'clone') {
                        cloneMutation.mutate();
                        return;
                      }
                      setAction(nextAction);
                    }}
                  />
                </div>
                {validateMutation.error ? <ErrorAlert error={validateMutation.error} /> : null}
                {updateMutation.error ? <ErrorAlert error={updateMutation.error} /> : null}
                {releaseMutation.error ? <ErrorAlert error={releaseMutation.error} /> : null}
                {cloneMutation.error ? <ErrorAlert error={cloneMutation.error} /> : null}
                {config.renderSummary(selected)}
                {isEvaluationGatedResource(resourceType) ? (
                  <EvaluationGateCard record={selected} onChange={setGatePublishMetadata} />
                ) : null}
                <Tabs
                  items={[
                    {
                      key: 'editor',
                      label: 'JSON 编辑',
                      children: (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <JsonEditor value={editorText} onChange={setEditorText} readOnly={!editable} />
                          <Can permission="registry:write">
                            <Button
                              type="primary"
                              disabled={!editable}
                              loading={updateMutation.isPending}
                              onClick={() => updateMutation.mutate()}
                              data-testid="registry-save"
                            >
                              保存 draft
                            </Button>
                          </Can>
                          {!editable ? <Typography.Text type="secondary">当前状态不可原地修改，需要 clone 新版本。</Typography.Text> : null}
                        </Space>
                      ),
                    },
                    {
                      key: 'validation',
                      label: 'Validate',
                      children: <ValidationResult result={validation} />,
                    },
                    {
                      key: 'versions',
                      label: '版本对比',
                      children: (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Space wrap>
                            <VersionSelector versions={versions} value={compareLeft} onChange={setCompareLeft} placeholder="左侧版本" />
                            <VersionSelector versions={versions} value={compareRight} onChange={setCompareRight} placeholder="右侧版本" />
                          </Space>
                          <div className="cp-json-compare">
                            <pre className="cp-json-pre">{compareLeftQuery.data ? stringifyPretty(compareLeftQuery.data.spec) : '选择左侧版本'}</pre>
                            <pre className="cp-json-pre">{compareRightQuery.data ? stringifyPretty(compareRightQuery.data.spec) : '选择右侧版本'}</pre>
                          </div>
                        </Space>
                      ),
                    },
                    {
                      key: 'releases',
                      label: 'Release History',
                      children: <ReleaseHistoryTable releases={releaseQuery.data ?? []} />,
                    },
                  ]}
                />
                <Divider />
                <Space wrap>
                  <InputNumber min={1} placeholder="clone target version" value={cloneTarget ?? null} onChange={(value) => setCloneTarget(typeof value === 'number' ? value : undefined)} />
                  <Typography.Text type="secondary">不填写时后端自动生成下一可用版本。</Typography.Text>
                </Space>
              </Space>
            </>
          ) : (
            <EmptyState description="请选择一个资源版本" />
          )}
        </section>
      </div>
      <Drawer
        title={`创建 ${config.title} draft`}
        open={createState.open}
        onClose={() => setCreateState((current) => ({ ...current, open: false }))}
        width={720}
      >
        {createMutation.error ? <ErrorAlert error={createMutation.error} /> : null}
        <JsonEditor value={createState.text} onChange={(text) => setCreateState((current) => ({ ...current, text }))} minRows={18} />
        <Button
          type="primary"
          loading={createMutation.isPending}
          onClick={() => createMutation.mutate()}
          data-testid="draft-submit"
          style={{ marginTop: 12 }}
        >
          提交 draft
        </Button>
      </Drawer>
      <ConfirmActionModal
        title={actionTitle(action)}
        open={Boolean(action && action !== 'validate' && action !== 'clone')}
        loading={releaseMutation.isPending}
        requireGrayPolicy={action === 'gray'}
        versionOptions={action === 'rollback' ? selectedVersionOptions : []}
        onCancel={() => setAction(undefined)}
        onConfirm={(values) => releaseMutation.mutate(values)}
      />
    </div>
  );
}

function ReleaseHistoryTable({ releases }: { releases: CapabilityRelease[] }) {
  const columns: ColumnsType<CapabilityRelease> = [
    { title: 'action', dataIndex: 'action', key: 'action' },
    { title: 'version', dataIndex: 'resource_version', key: 'resource_version' },
    { title: 'target_status', dataIndex: 'target_status', key: 'target_status', render: (status: SpecStatus) => <StatusTag status={status} /> },
    { title: 'operator', dataIndex: 'operator_id', key: 'operator_id' },
    { title: 'note', dataIndex: 'release_note', key: 'release_note', render: (value: string | undefined) => value ?? '-' },
    { title: 'created_at', dataIndex: 'created_at', key: 'created_at', render: formatDateTime },
    { title: 'release', dataIndex: 'release_id', key: 'release_id', render: (value: string) => <Link to={`/releases?release_id=${encodeURIComponent(value)}`}>{value.slice(0, 12)}</Link> },
  ];
  return <Table size="small" rowKey="release_id" columns={columns} dataSource={releases} pagination={{ pageSize: 6 }} />;
}

function splitCsv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function cleanFilters(values: Filters): Filters {
  const next: Filters = {};
  if (values.status) {
    next.status = values.status;
  }
  if (values.keyword) {
    next.keyword = values.keyword.trim();
  }
  if (values.resource_id) {
    next.resource_id = values.resource_id.trim();
  }
  return next;
}

function actionTitle(action: ReleaseAction | undefined): string {
  if (action === 'publish') {
    return '发布版本';
  }
  if (action === 'gray') {
    return '设置灰度';
  }
  if (action === 'deprecate') {
    return '废弃版本';
  }
  if (action === 'disable') {
    return '禁用版本';
  }
  if (action === 'rollback') {
    return '回滚当前发布指针';
  }
  return '确认操作';
}

function isEvaluationGatedResource(resourceType: RegistryResourceType): boolean {
  return resourceType === 'prompt' || resourceType === 'agent' || resourceType === 'model_policy';
}
