import type { RegistryResourceType } from '@dar/contracts';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Form, Input, Space, Typography } from 'antd';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { listGateDecisions } from '../../api/evaluation-api.js';
import type { RegistryRecord } from '../../api/registry-api.js';
import { GateDecisionBadge, GateFreshnessAlert, HashText } from './evaluation-utils.js';

export interface GatePublishMetadata {
  evaluation_candidate_bundle_hash?: string;
  evaluation_gate_decision_id?: string;
  evaluation_gate_override_id?: string;
}

export function EvaluationGateCard({
  record,
  onChange,
}: {
  record: RegistryRecord;
  onChange(values: GatePublishMetadata): void;
}) {
  const client = useApiClient();
  const resourceType = toEvaluationSubject(record.resource_type);
  const currentResourceHash = shaOrUndefined(record.sha256);
  const query = useQuery({
    queryKey: ['registry-evaluation-gate-card', record.resource_type, record.resource_id, record.version, record.sha256],
    enabled: Boolean(resourceType),
    queryFn: ({ signal }) => listGateDecisions(client, {
      resource_type: resourceType!,
      resource_id: record.resource_id,
      resource_version: record.version,
      ...(currentResourceHash ? { current_resource_hash: currentResourceHash } : {}),
      page_size: 10,
    }, { signal }),
  });

  if (!resourceType) {
    return null;
  }

  const latest = query.data?.items[0];
  const decision = latest?.decision;

  useEffect(() => {
    if (!decision) {
      onChange({});
      return;
    }
    onChange({
      evaluation_candidate_bundle_hash: decision.candidate_bundle_hash,
      evaluation_gate_decision_id: decision.gate_decision_id,
    });
  }, [decision, onChange]);

  return (
    <section className="cp-section" data-testid="evaluation-gate-card">
      <div className="cp-page-header">
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>Evaluation Gate</Typography.Title>
          <Typography.Text type="secondary">Publish Gate 由后端按 exact hash/decision 判断，前端只传递选择的证据。</Typography.Text>
        </div>
        <Space>
          <Button size="small" onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
          <Link to={`/evaluation/runs?resource_id=${encodeURIComponent(record.resource_id)}`}>Run Evaluation</Link>
        </Space>
      </div>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      {latest && decision ? (
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }}>
          <Descriptions size="small" bordered column={{ xs: 1, md: 2 }}>
            <Descriptions.Item label="latest decision"><GateDecisionBadge decision={decision?.decision} /></Descriptions.Item>
            <Descriptions.Item label="freshness">{latest.freshness.status}</Descriptions.Item>
            <Descriptions.Item label="decision id">
              <Link to={`/evaluation/gate-decisions/${encodeURIComponent(decision.gate_decision_id)}`}>{decision.gate_decision_id}</Link>
            </Descriptions.Item>
            <Descriptions.Item label="resource hash"><HashText value={decision.resource_hash} /></Descriptions.Item>
            <Descriptions.Item label="current resource hash"><HashText value={record.sha256} /></Descriptions.Item>
            <Descriptions.Item label="candidate bundle"><HashText value={decision.candidate_bundle_hash} /></Descriptions.Item>
            <Descriptions.Item label="override">后端 publish 时解析 active override</Descriptions.Item>
            <Descriptions.Item label="publish state">{latest.freshness.status === 'fresh' && decision.decision === 'passed' ? 'publish candidate available' : 'publish may be blocked'}</Descriptions.Item>
          </Descriptions>
          <GateFreshnessAlert status={latest.freshness.status} reasons={latest.freshness.reasons} />
          <Form
            layout="vertical"
            onValuesChange={(_, values: GatePublishMetadata) => onChange(clean(values))}
            initialValues={{
              evaluation_candidate_bundle_hash: decision.candidate_bundle_hash,
              evaluation_gate_decision_id: decision.gate_decision_id,
            }}
          >
            <Form.Item name="evaluation_candidate_bundle_hash" label="evaluation_candidate_bundle_hash">
              <Input />
            </Form.Item>
            <Form.Item name="evaluation_gate_decision_id" label="evaluation_gate_decision_id">
              <Input />
            </Form.Item>
            <Form.Item name="evaluation_gate_override_id" label="evaluation_gate_override_id">
              <Input placeholder="platform_admin override id, optional" />
            </Form.Item>
          </Form>
          <Space wrap>
            {decision.evaluation_run_ids.map((runId) => (
              <Link key={runId} to={`/evaluation/runs/${encodeURIComponent(runId)}`}>Run {runId.slice(0, 12)}</Link>
            ))}
          </Space>
        </Space>
      ) : (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message="No Evaluation Gate Decision returned"
          description="需要先基于 exact Dataset 和 Execution Plan 创建 Evaluation Run。Publish 是否允许仍以后端响应为准。"
        />
      )}
    </section>
  );
}

function toEvaluationSubject(resourceType: RegistryResourceType) {
  if (resourceType === 'prompt' || resourceType === 'agent' || resourceType === 'model_policy') {
    return resourceType;
  }
  return undefined;
}

function shaOrUndefined(value: string | undefined): string | undefined {
  return value && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function clean(values: GatePublishMetadata): GatePublishMetadata {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => typeof value === 'string' && value.trim().length > 0),
  ) as GatePublishMetadata;
}
