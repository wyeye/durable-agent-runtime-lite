import type { EvaluationGatePolicy } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Descriptions, InputNumber, Modal, Space, Table, Tabs, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Can, ReadOnlyNotice } from '../../auth/role-guard.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { JsonEditor } from '../../components/JsonEditor.js';
import { useApiClient } from '../../api/use-api-client.js';
import {
  cloneGatePolicy,
  getGatePolicy,
  listGatePolicyVersions,
  publishGatePolicy,
  updateGatePolicy,
  validateGatePolicy,
} from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import { parseJson, stringifyPretty } from '../../utils/json.js';
import { CopyHashButton, EvaluationStatusTag, HashText, SafeJsonPreview } from './evaluation-utils.js';

export function EvaluationGateDetailPage() {
  const { gatePolicyId, version } = useParams();
  const policyVersion = Number(version);
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [editorText, setEditorText] = useState('');
  const [cloneTarget, setCloneTarget] = useState<number | undefined>();

  const policyQuery = useQuery({
    queryKey: ['evaluation-gate-policy', gatePolicyId, policyVersion],
    enabled: Boolean(gatePolicyId && policyVersion),
    queryFn: ({ signal }) => getGatePolicy(client, gatePolicyId!, policyVersion, { signal }),
  });

  const versionsQuery = useQuery({
    queryKey: ['evaluation-gate-policy-versions', gatePolicyId],
    enabled: Boolean(gatePolicyId),
    queryFn: ({ signal }) => listGatePolicyVersions(client, gatePolicyId!, { signal }),
  });

  useEffect(() => {
    if (policyQuery.data) {
      setEditorText(stringifyPretty(policyPatchView(policyQuery.data)));
    }
  }, [policyQuery.data]);

  const refresh = async (policy?: EvaluationGatePolicy) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['evaluation-gate-policy', gatePolicyId, policyVersion] }),
      queryClient.invalidateQueries({ queryKey: ['evaluation-gate-policy-versions', gatePolicyId] }),
      queryClient.invalidateQueries({ queryKey: ['evaluation-gate-policies'] }),
    ]);
    if (policy && policy.version !== policyVersion) {
      navigate(`/evaluation/gates/${encodeURIComponent(policy.gate_policy_id)}/versions/${policy.version}`);
    }
  };

  const updateMutation = useMutation({
    mutationFn: async () => {
      const policy = policyQuery.data;
      if (!policy || !gatePolicyId) {
        throw new Error('Gate Policy 未加载');
      }
      const parsed = parseJson(editorText);
      if (!parsed.ok) {
        throw new Error(parsed.error ?? 'JSON 格式错误');
      }
      return updateGatePolicy(client, gatePolicyId, policyVersion, {
        policy: parsed.value as Partial<EvaluationGatePolicy>,
        expected_revision: policy.revision,
      });
    },
    onSuccess: async (policy) => {
      message.success('Gate Policy 已保存');
      await refresh(policy);
    },
  });

  const validateMutation = useMutation({
    mutationFn: () => validateGatePolicy(client, gatePolicyId!, policyVersion),
    onSuccess: async (policy) => {
      message.success('Gate Policy validate 已完成');
      await refresh(policy);
    },
  });

  const publishMutation = useMutation({
    mutationFn: () => publishGatePolicy(client, gatePolicyId!, policyVersion),
    onSuccess: async (policy) => {
      message.success('Gate Policy 已发布');
      await refresh(policy);
    },
  });

  const cloneMutation = useMutation({
    mutationFn: () => cloneGatePolicy(client, gatePolicyId!, policyVersion, cloneTarget ? { version: cloneTarget } : {}),
    onSuccess: async (policy) => {
      message.success('已 clone Gate Policy draft');
      setCloneTarget(undefined);
      await refresh(policy);
    },
  });

  const policy = policyQuery.data;
  const editable = policy ? ['draft', 'validated'].includes(policy.status) : false;

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>Gate Policy Detail</h1>
          <p><Link to="/evaluation/gates">Evaluation Gates</Link> / {gatePolicyId}@{version}</p>
        </div>
        <Space wrap>
          <Button onClick={() => policyQuery.refetch()} loading={policyQuery.isFetching}>刷新</Button>
          <InputNumber min={1} value={cloneTarget ?? null} onChange={(value) => setCloneTarget(typeof value === 'number' ? value : undefined)} placeholder="clone version" />
          <Can permission="registry:write"><Button onClick={() => cloneMutation.mutate()} loading={cloneMutation.isPending}>clone</Button></Can>
          <Can permission="registry:validate"><Button disabled={!editable} onClick={() => validateMutation.mutate()} loading={validateMutation.isPending}>validate</Button></Can>
          <Can permission="registry:publish">
            <Button
              type="primary"
              disabled={!editable}
              loading={publishMutation.isPending}
              onClick={() => Modal.confirm({
                title: 'Publish Gate Policy exact version',
                content: 'required_dataset_refs 必须是后端已发布的 exact version/hash。',
                onOk: () => publishMutation.mutate(),
              })}
            >
              publish
            </Button>
          </Can>
        </Space>
      </div>
      <ReadOnlyNotice />
      {policyQuery.error ? <ErrorAlert error={policyQuery.error} /> : null}
      {updateMutation.error ? <ErrorAlert error={updateMutation.error} /> : null}
      {validateMutation.error ? <ErrorAlert error={validateMutation.error} /> : null}
      {publishMutation.error ? <ErrorAlert error={publishMutation.error} /> : null}
      {cloneMutation.error ? <ErrorAlert error={cloneMutation.error} /> : null}
      {policy ? (
        <>
          <section className="cp-section">
            <Descriptions size="small" bordered column={{ xs: 1, md: 3 }}>
              <Descriptions.Item label="gate_policy_id">{policy.gate_policy_id}</Descriptions.Item>
              <Descriptions.Item label="version">{policy.version}</Descriptions.Item>
              <Descriptions.Item label="status"><EvaluationStatusTag status={policy.status} /></Descriptions.Item>
              <Descriptions.Item label="resource_types">{policy.resource_types.join(', ')}</Descriptions.Item>
              <Descriptions.Item label="allow_override">{String(policy.allow_override)}</Descriptions.Item>
              <Descriptions.Item label="hash"><HashText value={policy.gate_policy_hash} /></Descriptions.Item>
              <Descriptions.Item label="updated_at">{formatDateTime(policy.updated_at)}</Descriptions.Item>
              <Descriptions.Item label="published_at">{formatDateTime(policy.published_at)}</Descriptions.Item>
            </Descriptions>
            <div style={{ marginTop: 12 }}><CopyHashButton value={policy.gate_policy_hash} label="copy gate policy hash" /></div>
          </section>
          <Tabs
            items={[
              {
                key: 'editor',
                label: 'Policy Editor',
                children: (
                  <section className="cp-section">
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <JsonEditor value={editorText} onChange={setEditorText} readOnly={!editable} minRows={18} />
                      <Can permission="registry:write">
                        <Button type="primary" disabled={!editable} loading={updateMutation.isPending} onClick={() => updateMutation.mutate()}>保存 draft</Button>
                      </Can>
                      {!editable ? <Typography.Text type="secondary">published Gate Policy 只读；需要修改请 clone 新版本。</Typography.Text> : null}
                    </Space>
                  </section>
                ),
              },
              {
                key: 'datasets',
                label: 'Required Datasets',
                children: (
                  <section className="cp-section">
                    <Table
                      rowKey={(row) => `${row.dataset_id}:${row.version}:${row.dataset_hash}`}
                      dataSource={policy.required_dataset_refs}
                      pagination={false}
                      columns={[
                        { title: 'dataset_id', dataIndex: 'dataset_id', key: 'dataset_id' },
                        { title: 'version', dataIndex: 'version', key: 'version' },
                        { title: 'dataset_hash', dataIndex: 'dataset_hash', key: 'dataset_hash', render: (value: string) => <HashText value={value} /> },
                      ]}
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
                      rowKey={(row) => `${row.gate_policy_id}:${row.version}`}
                      dataSource={versionsQuery.data ?? []}
                      loading={versionsQuery.isLoading}
                      pagination={false}
                      columns={[
                        { title: 'version', dataIndex: 'version', key: 'version' },
                        { title: 'status', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
                        { title: 'hash', dataIndex: 'gate_policy_hash', key: 'hash', render: (value: string | undefined) => <HashText value={value} /> },
                        { title: 'open', key: 'open', render: (_, row) => <Link to={`/evaluation/gates/${encodeURIComponent(row.gate_policy_id)}/versions/${row.version}`}>打开</Link> },
                      ]}
                    />
                  </section>
                ),
              },
              {
                key: 'json',
                label: 'Safe JSON',
                children: <SafeJsonPreview value={policy} />,
              },
            ]}
          />
        </>
      ) : (
        <section className="cp-section"><EmptyState description="Gate Policy 未加载" /></section>
      )}
    </div>
  );
}

function policyPatchView(policy: EvaluationGatePolicy): Partial<EvaluationGatePolicy> {
  return {
    resource_types: policy.resource_types,
    required_dataset_refs: policy.required_dataset_refs,
    thresholds: policy.thresholds,
    regression_rules: policy.regression_rules,
    required_case_tags: policy.required_case_tags,
    allow_override: policy.allow_override,
  };
}
