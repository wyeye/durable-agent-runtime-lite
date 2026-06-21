import { useMutation, useQuery } from '@tanstack/react-query';
import { App, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { Link, useParams } from 'react-router';
import { useIdentity } from '../../auth/identity-context.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { createOverride, getGateDecision } from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import { ExactRefDescriptions, GateDecisionBadge, GateFreshnessAlert, HashText, SafeJsonPreview } from './evaluation-utils.js';

interface OverrideFormValues {
  reason: string;
  expires_at: string;
}

export function EvaluationDecisionDetailPage() {
  const { decisionId } = useParams();
  const client = useApiClient();
  const { identity } = useIdentity();
  const { message } = App.useApp();
  const [form] = Form.useForm<OverrideFormValues>();

  const query = useQuery({
    queryKey: ['evaluation-gate-decision', decisionId],
    enabled: Boolean(decisionId),
    queryFn: ({ signal }) => getGateDecision(client, decisionId!, { signal }),
  });

  const overrideMutation = useMutation({
    mutationFn: async () => {
      const values = await form.validateFields();
      if (!query.data) {
        throw new Error('门禁结论未加载');
      }
      return createOverride(client, query.data.decision.gate_decision_id, {
        resource_hash: query.data.decision.resource_hash,
        reason: values.reason,
        scope: 'single_resource_hash',
        expires_at: new Date(values.expires_at).toISOString(),
      });
    },
    onSuccess: async () => {
      message.success('Override 已创建');
      form.resetFields();
      await query.refetch();
    },
  });

  const item = query.data;
  const isAdmin = identity?.roles.includes('platform_admin') ?? false;

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>门禁结论详情</h1>
          <p><Link to="/evaluation/gates">发布门禁</Link> / {decisionId}</p>
        </div>
        <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
      </div>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      {overrideMutation.error ? <ErrorAlert error={overrideMutation.error} /> : null}
      {item ? (
        <>
          <section className="cp-section">
            <ExactRefDescriptions
              items={[
	                { label: '结论', value: <GateDecisionBadge decision={item.decision.decision} /> },
	                { label: '新鲜度', value: item.freshness.status },
	                { label: '资源', value: `${item.decision.resource_type}/${item.decision.resource_id}@${item.decision.resource_version}` },
	                { label: '资源 hash', value: <HashText value={item.decision.resource_hash} /> },
	                { label: '候选包 hash', value: <HashText value={item.decision.candidate_bundle_hash} /> },
	                { label: 'Gate Policy', value: `${item.decision.gate_policy_id}@${item.decision.gate_policy_version}` },
	                { label: 'Gate Policy hash', value: <HashText value={item.decision.gate_policy_hash} /> },
	                { label: '评测任务', value: item.decision.evaluation_run_ids.map((runId) => <Link key={runId} to={`/evaluation/runs/${encodeURIComponent(runId)}`}>{runId}</Link>) },
	                { label: '结论时间', value: formatDateTime(item.decision.decided_at) },
	                { label: '检查时间', value: formatDateTime(item.freshness.checked_at) },
              ]}
            />
            <div style={{ marginTop: 12 }}><GateFreshnessAlert status={item.freshness.status} reasons={item.freshness.reasons} /></div>
          </section>
          <section className="cp-section">
	            <Typography.Title level={4}>原因</Typography.Title>
	            {item.decision.reasons.length ? item.decision.reasons.map((reason) => <p key={reason}>{reason}</p>) : <EmptyState description="无门禁原因" />}
          </section>
          {isAdmin ? (
            <section className="cp-section">
              <Typography.Title level={4}>Override</Typography.Title>
	              <Typography.Paragraph type="secondary">Override 绑定当前 exact resource hash，原因和过期时间必填。过期或 hash 改变后后端会阻断发布。</Typography.Paragraph>
              <Form form={form} layout="vertical">
	                <Form.Item name="reason" label="原因" rules={[{ required: true, min: 12 }]}>
                  <Input.TextArea rows={3} />
                </Form.Item>
                <Form.Item name="expires_at" label="expires_at" rules={[{ required: true }]}>
                  <Input data-testid="evaluation-override-expires-at" placeholder="2026-06-21T12:00:00.000Z" />
                </Form.Item>
                <Space>
                  <Button
                    danger
                    loading={overrideMutation.isPending}
                    onClick={() => Modal.confirm({
	                      title: '创建 Gate Override',
	                      content: 'Override 会允许该 exact resource hash 使用当前门禁结论发布，请确认风险和过期时间。',
                      onOk: () => overrideMutation.mutate(),
                    })}
                  >
                    创建 Override
                  </Button>
                </Space>
              </Form>
            </section>
          ) : null}
          <section className="cp-section">
	            <Typography.Title level={4}>安全 JSON</Typography.Title>
            <SafeJsonPreview value={item} />
          </section>
        </>
      ) : (
	        <section className="cp-section"><EmptyState description="门禁结论未加载" /></section>
      )}
    </div>
  );
}
