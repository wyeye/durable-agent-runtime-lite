import type { RegistryValidationResult, RouteSpec, SpecStatus } from '@dar/contracts';
import { routeSpecSchema } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { ConfirmActionModal, type ConfirmActionValues } from '../../components/ConfirmActionModal.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { ReleaseActionButtons, type ReleaseAction } from '../../components/ReleaseActionButtons.js';
import { StatusTag } from '../../components/StatusTag.js';
import { ValidationResult } from '../../components/ValidationResult.js';
import { useApiClient } from '../../api/use-api-client.js';
import { fetchRoleCatalog, listTenants } from '../../api/iam-api.js';
import {
  cloneVersion,
  createDraft,
  deprecateResource,
  disableResource,
  getVersion,
  grayResource,
  listResources,
  listVersions,
  publishResource,
  rollbackResource,
  updateDraft,
  validateResource,
  type RegistryRecord,
} from '../../api/registry-api.js';
import { formatDateTime, formatList } from '../../utils/format.js';
import { displayRole } from '../../utils/i18n-labels.js';
import { validationFeedback } from '../../utils/errors.js';
import { stripServerManagedFields } from '../../visual-config/canonicalize.js';
import { FormErrorSummary } from '../../visual-config/components/FormErrorSummary.js';
import { ReadonlyJsonPreview } from '../../visual-config/components/ReadonlyJsonPreview.js';
import { issuesFromError } from '../../visual-config/form-error-mapper.js';
import { RouteVisualEditor } from '../../visual-config/editors/RouteVisualEditor.js';
import { useUnsavedChangeGuard } from '../../visual-config/useUnsavedChangeGuard.js';
import { actionHelperText, canPublishFromStatus, isRollbackEligible, publishDisabledReason } from '../registry/registry-page-helpers.js';

type RouteRegistryRecord = RegistryRecord<RouteSpec>;

interface Filters {
  status?: SpecStatus;
  tenant_id?: string;
  role?: string;
  resource_id?: string;
}

interface CreateState {
  open: boolean;
  spec: RouteSpec;
}

const statuses: SpecStatus[] = ['draft', 'validated', 'published', 'gray', 'deprecated', 'disabled'];

export function FallbackRoutesPage() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [filters, setFilters] = useState<Filters>({});
  const [selected, setSelected] = useState<RouteRegistryRecord | undefined>();
  const [editorSpec, setEditorSpec] = useState<RouteSpec>(() => createFallbackDraft());
  const [validation, setValidation] = useState<RegistryValidationResult | undefined>();
  const [createState, setCreateState] = useState<CreateState>({ open: false, spec: createFallbackDraft() });
  const [action, setAction] = useState<ReleaseAction | undefined>();
  const [cloneTarget, setCloneTarget] = useState<number | undefined>();
  const [editorDirty, setEditorDirty] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);

  const listQuery = useQuery({
    queryKey: ['fallback-routes', filters.status],
    queryFn: () => listResources(apiClient, 'route', {
      ...(filters.status ? { status: filters.status } : {}),
      page_size: 100,
    }),
  });

  const tenantsQuery = useQuery({
    queryKey: ['iam-tenants-for-fallback-routes'],
    queryFn: () => listTenants(apiClient, { page_size: '100', status: 'active' }),
  });

  const rolesQuery = useQuery({
    queryKey: ['iam-roles-for-fallback-routes'],
    queryFn: () => fetchRoleCatalog(apiClient),
  });

  const versionsQuery = useQuery({
    queryKey: ['fallback-route-versions', selected?.resource_id],
    enabled: Boolean(selected?.resource_id),
    queryFn: () => listVersions(apiClient, 'route', selected!.resource_id) as Promise<RouteRegistryRecord[]>,
  });

  const refreshSelected = async (record: RouteRegistryRecord) => {
    setSelected(record);
    setEditorSpec(record.spec);
    setEditorDirty(false);
    setValidation(undefined);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['fallback-routes'] }),
      queryClient.invalidateQueries({ queryKey: ['fallback-route-versions', record.resource_id] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const spec = stripServerManagedFields(ensureFallbackRoute(createState.spec));
      const parsed = routeSpecSchema.safeParse(spec);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => issue.message).join('；'));
      }
      assertPublishableFallbackDraft(parsed.data);
      return createDraft(apiClient, 'route', parsed.data) as Promise<RouteRegistryRecord>;
    },
    onSuccess: async (record) => {
      message.success('兜底路由 draft 已创建');
      setCreateState({ open: false, spec: createFallbackDraft() });
      setCreateDirty(false);
      await refreshSelected(record);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!selected) {
        throw new Error('请选择兜底路由');
      }
      const spec = stripServerManagedFields(ensureFallbackRoute(editorSpec));
      const parsed = routeSpecSchema.safeParse(spec);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => issue.message).join('；'));
      }
      assertPublishableFallbackDraft(parsed.data);
      return updateDraft(apiClient, 'route', selected.resource_id, selected.version, parsed.data, selected.revision) as Promise<RouteRegistryRecord>;
    },
    onSuccess: async (record) => {
      message.success('兜底路由 draft 已更新');
      await refreshSelected(record);
    },
  });

  const validateMutation = useMutation({
    mutationFn: async () => {
      if (!selected) {
        throw new Error('请选择兜底路由');
      }
      return validateResource(apiClient, 'route', selected.resource_id, selected.version);
    },
    onSuccess: ({ validation: next }) => {
      setValidation(next);
      const feedback = validationFeedback(next);
      message[feedback.type](feedback.content);
    },
  });

  const cloneMutation = useMutation({
    mutationFn: async () => {
      if (!selected) {
        throw new Error('请选择兜底路由');
      }
      return cloneVersion(apiClient, 'route', selected.resource_id, selected.version, cloneTarget) as Promise<RouteRegistryRecord>;
    },
    onSuccess: async (record) => {
      setCloneTarget(undefined);
      message.success('已 clone 新 draft 版本');
      await refreshSelected(ensureFallbackRecord(record));
    },
  });

  const releaseMutation = useMutation({
    mutationFn: async (values: ConfirmActionValues) => {
      if (!selected || !action) {
        throw new Error('请选择兜底路由和操作');
      }
      const base = { release_note: values.release_note, metadata_json: { source_page: 'fallback_routes' } };
      if (action === 'publish') {
        return publishResource(apiClient, 'route', selected.resource_id, selected.version, base);
      }
      if (action === 'gray') {
        return grayResource(apiClient, 'route', selected.resource_id, selected.version, {
          ...base,
          tenant_allowlist: splitCsv(values.tenant_allowlist),
          user_allowlist: splitCsv(values.user_allowlist),
        });
      }
      if (action === 'deprecate') {
        return deprecateResource(apiClient, 'route', selected.resource_id, selected.version, base);
      }
      if (action === 'disable') {
        return disableResource(apiClient, 'route', selected.resource_id, selected.version, base);
      }
      if (action === 'rollback' && values.target_version) {
        return rollbackResource(apiClient, 'route', selected.resource_id, {
          ...base,
          target_version: values.target_version,
        });
      }
      throw new Error('不支持的操作');
    },
    onSuccess: async (_release, values) => {
      message.success('发布操作已完成');
      setAction(undefined);
      if (selected) {
        const versionToLoad = action === 'rollback' && values.target_version ? values.target_version : selected.version;
        const next = await getVersion(apiClient, 'route', selected.resource_id, versionToLoad) as RouteRegistryRecord;
        await refreshSelected(ensureFallbackRecord(next));
      }
    },
  });

  const allFallbackRecords = ((listQuery.data?.items ?? []) as RouteRegistryRecord[])
    .filter((record) => record.spec.route.fallback_enabled === true);
  const records = allFallbackRecords
    .filter((record) => !filters.resource_id || record.resource_id.includes(filters.resource_id))
    .filter((record) => matchesScope(record.spec.route.tenant_constraints, filters.tenant_id))
    .filter((record) => matchesScope(record.spec.route.role_constraints, filters.role))
    .sort((left, right) => {
      if (right.spec.route.priority !== left.spec.route.priority) {
        return right.spec.route.priority - left.spec.route.priority;
      }
      return left.resource_id.localeCompare(right.resource_id);
    });
  const versions = versionsQuery.data ?? [];
  const editable = selected ? ['draft', 'validated'].includes(selected.status) : false;
  const hasUnsavedEditorChanges = editable && editorDirty;
  const publishBlocked = selected ? !canPublishFromStatus(selected.status) : true;
  const selectedVersionOptions = versions
    .filter((record) => isRollbackEligible(record.status, 'route'))
    .map((record) => record.version)
    .sort((a, b) => a - b);
  const editorValidation = routeSpecSchema.safeParse(editorSpec);
  const tenantOptions = useMemo(
    () => (tenantsQuery.data?.items ?? []).map((tenant) => ({
      value: tenant.tenant_id,
      label: tenant.display_name ? `${tenant.display_name} (${tenant.tenant_id})` : tenant.tenant_id,
    })),
    [tenantsQuery.data?.items],
  );
  const roleOptions = useMemo(() => {
    const roles = [
      ...(rolesQuery.data?.roles ?? []),
      ...(rolesQuery.data?.membership_roles ?? []),
    ];
    return uniqueOptions(roles.map((role) => ({ value: role.role, label: displayRole(role.role) })));
  }, [rolesQuery.data?.membership_roles, rolesQuery.data?.roles]);
  const selectedConflictRecords = selected
    ? records.filter((record) => isConflictingFallback(record, selected) && record.version !== selected.version)
    : [];
  const createConflictRecords = records.filter((record) => isConflictingWithSpec(record.spec, createState.spec));

  useUnsavedChangeGuard(
    hasUnsavedEditorChanges || (createState.open && createDirty),
    '当前兜底路由配置有未保存改动，确认离开吗？',
  );

  const columns = useMemo<ColumnsType<RouteRegistryRecord>>(() => [
    {
      title: 'route_id',
      dataIndex: 'resource_id',
      key: 'resource_id',
      render: (value: string, record) => (
        <Button type="link" onClick={() => requestSelectRecord(record)}>
          {value}
        </Button>
      ),
    },
    { title: '状态', dataIndex: 'status', key: 'status', width: 110, render: (status: SpecStatus) => <StatusTag status={status} /> },
    { title: '版本', dataIndex: 'version', key: 'version', width: 80 },
    { title: '优先级', key: 'priority', width: 90, render: (_, record) => record.spec.route.priority },
    { title: '租户', key: 'tenants', render: (_, record) => scopeTag(record.spec.route.tenant_constraints ?? [], '全部租户') },
    { title: '角色', key: 'roles', render: (_, record) => scopeTag(record.spec.route.role_constraints.map(displayRole), '全部角色') },
    { title: '渠道', key: 'channels', render: (_, record) => formatList(record.spec.route.supported_channels) },
    { title: '兜底智能体', key: 'agent', render: (_, record) => record.spec.route.fallback_agent_ref ?? '-' },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
  ], [hasUnsavedEditorChanges]);

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>兜底路由</h1>
          <p>按租户、角色和优先级管理明确启用的 fallback RouteSpec。</p>
        </div>
        <Space>
          <Link to="/registry/routes">查看全部路由</Link>
          <Can permission="registry:write">
            <Button
              type="primary"
              data-testid="fallback-route-create"
              onClick={() => {
                setCreateState({ open: true, spec: createFallbackDraft() });
                setCreateDirty(false);
              }}
            >
              创建兜底路由
            </Button>
          </Can>
        </Space>
      </div>
      <ReadOnlyNotice />
      <section className="cp-section">
        <Form layout="inline" className="cp-filter-bar" onFinish={(values: Filters) => setFilters(cleanFilters(values))}>
          <Form.Item name="status">
            <Select allowClear placeholder="状态" style={{ width: 150 }} options={statuses.map((status) => ({ value: status, label: status }))} />
          </Form.Item>
          <Form.Item name="tenant_id">
            <Select allowClear showSearch placeholder="租户" style={{ width: 220 }} options={tenantOptions} loading={tenantsQuery.isLoading} />
          </Form.Item>
          <Form.Item name="role">
            <Select allowClear showSearch placeholder="角色" style={{ width: 220 }} options={roleOptions} loading={rolesQuery.isLoading} />
          </Form.Item>
          <Form.Item name="resource_id">
            <Input placeholder="route_id" style={{ width: 220 }} />
          </Form.Item>
          <Button htmlType="submit" data-testid="fallback-route-search">查询</Button>
          <Button onClick={() => listQuery.refetch()}>刷新</Button>
        </Form>
      </section>
      {listQuery.error ? <ErrorAlert error={listQuery.error} /> : null}
      <section className="cp-section">
        <Table
          data-testid="fallback-routes-table"
          rowKey={(record) => `${record.resource_id}:${record.version}`}
          loading={listQuery.isLoading}
          columns={columns}
          dataSource={records}
          pagination={{ pageSize: 10 }}
          onRow={(record) => ({ onClick: () => requestSelectRecord(record) })}
          scroll={{ x: 1100 }}
          locale={{ emptyText: <EmptyState description="暂无兜底路由" /> }}
        />
      </section>
      <Drawer
        title={selected ? (
          <Space size="small" wrap>
            <Typography.Text strong>{selected.resource_id}@{selected.version}</Typography.Text>
            <StatusTag status={selected.status} />
          </Space>
        ) : '兜底路由详情'}
        open={Boolean(selected)}
        onClose={requestCloseDetailDrawer}
        width="min(920px, 100vw)"
        extra={selected ? (
          <ReleaseActionButtons
            status={selected.status}
            disabled={releaseMutation.isPending || validateMutation.isPending || updateMutation.isPending || cloneMutation.isPending}
            {...(publishBlocked ? { publishDisabledReason: publishDisabledReason(selected.status) } : {})}
            rollbackDisabled={selectedVersionOptions.length === 0}
            onAction={(nextAction) => {
              if (hasUnsavedEditorChanges && !globalThis.confirm('当前草稿有未保存改动，继续会基于已保存版本执行操作，确认继续吗？')) {
                return;
              }
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
        ) : null}
      >
        {selected ? (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Typography.Text type="secondary">
              revision {selected.revision} · sha256 {selected.sha256.slice(0, 12)}
            </Typography.Text>
            {hasUnsavedEditorChanges ? (
              <Alert
                type="warning"
                showIcon
                message="当前存在未保存改动"
                description="校验、发布、灰度、禁用等操作都会基于服务端已保存内容执行。"
              />
            ) : null}
            <Alert
              type="info"
              showIcon
              message={`当前优先级：${editorSpec.route.priority}`}
              description="同一租户和角色范围内允许存在多个兜底路由，但运行时只会选择优先级最高的一条。"
            />
            {selectedConflictRecords.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message="检测到同范围的其他兜底路由"
                description={`可能与当前配置同时命中：${selectedConflictRecords.map((record) => `${record.resource_id}@${record.version}（优先级 ${record.spec.route.priority}）`).join('、')}`}
              />
            ) : null}
            {updateMutation.error ? <ErrorAlert error={updateMutation.error} /> : null}
            {validateMutation.error ? <ErrorAlert error={validateMutation.error} /> : null}
            {releaseMutation.error ? <ErrorAlert error={releaseMutation.error} /> : null}
            {cloneMutation.error ? <ErrorAlert error={cloneMutation.error} /> : null}
            <Tabs
              items={[
                {
                  key: 'editor',
                  label: '兜底配置',
                  children: (
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <FormErrorSummary
                        issues={editorValidation.success ? [] : editorValidation.error.issues}
                        apiIssues={issuesFromError(updateMutation.error)}
                      />
                      <RouteVisualEditor
                        value={editorSpec}
                        readOnly={!editable}
                        client={apiClient}
                        onChange={(spec) => {
                          setEditorSpec(ensureFallbackRoute(spec));
                          setEditorDirty(true);
                        }}
                      />
                      <Can permission="registry:write">
                        <Button
                          type="primary"
                          disabled={!editable}
                          loading={updateMutation.isPending}
                          onClick={() => updateMutation.mutate()}
                          data-testid="fallback-route-save"
                        >
                          保存 draft
                        </Button>
                      </Can>
                      {!editable ? <Typography.Text type="secondary">当前状态不可原地修改，需要 clone 新版本。</Typography.Text> : null}
                    </Space>
                  ),
                },
                {
                  key: 'json',
                  label: 'JSON 查看',
                  children: <ReadonlyJsonPreview value={stripServerManagedFields(editorSpec)} filename={`${selected.resource_id}-${selected.version}.json`} />,
                },
                {
                  key: 'validation',
                  label: '校验结果',
                  children: <ValidationResult result={validation} />,
                },
              ]}
            />
            <Space wrap>
              <InputNumber min={1} placeholder="克隆目标版本" value={cloneTarget ?? null} onChange={(value) => setCloneTarget(typeof value === 'number' ? value : undefined)} />
              <Typography.Text type="secondary">不填写时后端自动生成下一可用版本。</Typography.Text>
            </Space>
          </Space>
        ) : null}
      </Drawer>
      <Drawer
        title="创建兜底路由 draft"
        open={createState.open}
        onClose={() => {
          if (createDirty && !globalThis.confirm('当前创建表单有未保存改动，确认关闭吗？')) {
            return;
          }
          setCreateState((current) => ({ ...current, open: false }));
          setCreateDirty(false);
        }}
        width={760}
      >
        {createMutation.error ? <ErrorAlert error={createMutation.error} /> : null}
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message={`当前优先级：${createState.spec.route.priority}`}
            description="建议在同一租户和角色范围内只保留一条主要兜底路由。"
          />
          {createConflictRecords.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message="已存在同范围兜底路由"
              description={`提交后运行时会按优先级挑选：${createConflictRecords.map((record) => `${record.resource_id}@${record.version}（优先级 ${record.spec.route.priority}）`).join('、')}`}
            />
          ) : null}
          <FormErrorSummary apiIssues={issuesFromError(createMutation.error)} />
          <RouteVisualEditor
            value={createState.spec}
            readOnly={false}
            client={apiClient}
            onChange={(spec) => {
              setCreateState((current) => ({ ...current, spec: ensureFallbackRoute(spec) }));
              setCreateDirty(true);
            }}
          />
          <ReadonlyJsonPreview value={stripServerManagedFields(createState.spec)} filename="fallback-route-draft-preview.json" maxHeight={260} />
          <Button
            type="primary"
            loading={createMutation.isPending}
            onClick={() => createMutation.mutate()}
            data-testid="fallback-route-submit"
            style={{ marginTop: 12 }}
          >
            提交 draft
          </Button>
        </Space>
      </Drawer>
      <ConfirmActionModal
        title={actionTitle(action)}
        open={Boolean(action && action !== 'validate' && action !== 'clone')}
        loading={releaseMutation.isPending}
        requireGrayPolicy={action === 'gray'}
        versionOptions={action === 'rollback' ? selectedVersionOptions : []}
        onCancel={() => setAction(undefined)}
        {...(action === 'publish' && selected?.status === 'draft' ? { noteLabel: '发布说明（将先自动校验）' } : {})}
        {...(action ? (() => {
          const helperText = actionHelperText(action, selected?.status, selectedVersionOptions.length);
          return helperText ? { helperText } : {};
        })() : {})}
        onConfirm={(values) => releaseMutation.mutate(values)}
      />
    </div>
  );

  function requestSelectRecord(record: RouteRegistryRecord) {
    if (hasUnsavedEditorChanges && !globalThis.confirm('当前兜底路由配置有未保存改动，确认切换资源吗？')) {
      return;
    }
    setSelected(record);
    setEditorSpec(record.spec);
    setEditorDirty(false);
    setValidation(undefined);
    setCloneTarget(undefined);
    setAction(undefined);
  }

  function requestCloseDetailDrawer() {
    if (hasUnsavedEditorChanges && !globalThis.confirm('当前兜底路由配置有未保存改动，确认关闭详情吗？')) {
      return;
    }
    setSelected(undefined);
    setEditorDirty(false);
    setValidation(undefined);
    setCloneTarget(undefined);
    setAction(undefined);
  }
}

function createFallbackDraft(): RouteSpec {
  return routeSpecSchema.parse({
    route_id: 'fallback_route_here',
    flow_id: 'flow_id_here',
    version: 1,
    route: {
      priority: 50,
      keywords: [],
      examples: [],
      negative_examples: [],
      supported_channels: ['chat', 'api', 'web'],
      tenant_constraints: [],
      role_constraints: [],
      confidence_threshold: 0.7,
      ambiguous_threshold: 0.5,
      fallback_enabled: true,
    },
  });
}

function assertPublishableFallbackDraft(spec: RouteSpec): void {
  const errors: string[] = [];
  if (spec.flow_id === 'flow_id_here') {
    errors.push('请选择已发布或灰度 Flow 精确版本');
  }
  if (!spec.route.fallback_agent_ref) {
    errors.push('请选择已发布兜底智能体精确版本');
  }
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }
}

function ensureFallbackRoute(spec: RouteSpec): RouteSpec {
  return {
    ...spec,
    route: {
      ...spec.route,
      keywords: spec.route.keywords ?? [],
      examples: spec.route.examples ?? [],
      negative_examples: spec.route.negative_examples ?? [],
      supported_channels: spec.route.supported_channels ?? [],
      tenant_constraints: spec.route.tenant_constraints ?? [],
      role_constraints: spec.route.role_constraints ?? [],
      fallback_enabled: true,
    },
  };
}

function ensureFallbackRecord(record: RouteRegistryRecord): RouteRegistryRecord {
  return { ...record, spec: ensureFallbackRoute(record.spec) };
}

function matchesScope(values: string[], filter: string | undefined): boolean {
  return !filter || values.length === 0 || values.includes(filter);
}

function scopeTag(values: string[], emptyLabel: string) {
  if (values.length === 0) {
    return <Tag>{emptyLabel}</Tag>;
  }
  return (
    <Space size={[4, 4]} wrap>
      {values.map((value) => <Tag key={value}>{value}</Tag>)}
    </Space>
  );
}

function cleanFilters(values: Filters): Filters {
  const next: Filters = {};
  if (values.status) {
    next.status = values.status;
  }
  if (values.tenant_id) {
    next.tenant_id = values.tenant_id;
  }
  if (values.role) {
    next.role = values.role;
  }
  if (values.resource_id?.trim()) {
    next.resource_id = values.resource_id.trim();
  }
  return next;
}

function splitCsv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function uniqueOptions(options: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) {
      return false;
    }
    seen.add(option.value);
    return true;
  });
}

function isConflictingFallback(record: RouteRegistryRecord, selectedRecord: RouteRegistryRecord): boolean {
  if (record.resource_id === selectedRecord.resource_id) {
    return false;
  }
  return isConflictingWithSpec(record.spec, selectedRecord.spec);
}

function isConflictingWithSpec(existing: RouteSpec, candidate: RouteSpec): boolean {
  return scopesOverlap(existing.route.tenant_constraints, candidate.route.tenant_constraints)
    && scopesOverlap(existing.route.role_constraints, candidate.route.role_constraints);
}

function scopesOverlap(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) {
    return true;
  }
  return left.some((value) => right.includes(value));
}

function actionTitle(action: ReleaseAction | undefined): string {
  if (action === 'publish') {
    return '发布兜底路由';
  }
  if (action === 'gray') {
    return '设置兜底路由灰度';
  }
  if (action === 'deprecate') {
    return '废弃兜底路由';
  }
  if (action === 'disable') {
    return '禁用兜底路由';
  }
  if (action === 'rollback') {
    return '回滚兜底路由发布指针';
  }
  return '确认操作';
}
