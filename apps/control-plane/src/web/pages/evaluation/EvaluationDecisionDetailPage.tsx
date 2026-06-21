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
        throw new Error('Gate Decision 未加载');
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
          <h1>Gate Decision Detail</h1>
          <p><Link to="/evaluation/gates">Evaluation Gates</Link> / {decisionId}</p>
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
                { label: 'decision', value: <GateDecisionBadge decision={item.decision.decision} /> },
                { label: 'freshness', value: item.freshness.status },
                { label: 'resource', value: `${item.decision.resource_type}/${item.decision.resource_id}@${item.decision.resource_version}` },
                { label: 'resource hash', value: <HashText value={item.decision.resource_hash} /> },
                { label: 'candidate bundle hash', value: <HashText value={item.decision.candidate_bundle_hash} /> },
                { label: 'gate policy', value: `${item.decision.gate_policy_id}@${item.decision.gate_policy_version}` },
                { label: 'gate policy hash', value: <HashText value={item.decision.gate_policy_hash} /> },
                { label: 'run ids', value: item.decision.evaluation_run_ids.map((runId) => <Link key={runId} to={`/evaluation/runs/${encodeURIComponent(runId)}`}>{runId}</Link>) },
                { label: 'decided_at', value: formatDateTime(item.decision.decided_at) },
                { label: 'checked_at', value: formatDateTime(item.freshness.checked_at) },
              ]}
            />
            <div style={{ marginTop: 12 }}><GateFreshnessAlert status={item.freshness.status} reasons={item.freshness.reasons} /></div>
          </section>
          <section className="cp-section">
            <Typography.Title level={4}>Reasons</Typography.Title>
            {item.decision.reasons.length ? item.decision.reasons.map((reason) => <p key={reason}>{reason}</p>) : <EmptyState description="无 Gate reason" />}
          </section>
          {isAdmin ? (
            <section className="cp-section">
              <Typography.Title level={4}>Override</Typography.Title>
              <Typography.Paragraph type="secondary">Override 绑定当前 exact resource hash，reason 和 expires_at 必填。过期或 hash 改变后后端会阻断发布。</Typography.Paragraph>
              <Form form={form} layout="vertical">
                <Form.Item name="reason" label="reason" rules={[{ required: true, min: 12 }]}>
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
                      title: 'Create Gate Override',
                      content: 'Override 会允许该 exact resource hash 使用当前 Gate Decision 发布，请确认风险和过期时间。',
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
            <Typography.Title level={4}>Safe JSON</Typography.Title>
            <SafeJsonPreview value={item} />
          </section>
        </>
      ) : (
        <section className="cp-section"><EmptyState description="Gate Decision 未加载" /></section>
      )}
    </div>
  );
}
