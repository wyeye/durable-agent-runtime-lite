import type {
  EvaluationCaseStatus,
  EvaluationDatasetStatus,
  EvaluationGateDecisionStatus,
  EvaluationGateFreshnessReason,
  EvaluationRunStatus,
} from '@dar/contracts';
import { Alert, Button, Descriptions, Progress, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router';
import { stringifyPretty } from '../../utils/json.js';

export function EvaluationStatusTag({ status }: { status: EvaluationRunStatus | EvaluationCaseStatus | EvaluationDatasetStatus | string }) {
  const color = statusColor(status);
  return <Tag color={color}>{status}</Tag>;
}

export function GateDecisionBadge({ decision }: { decision: EvaluationGateDecisionStatus | string | undefined }) {
  if (!decision) {
    return <Tag>no_decision</Tag>;
  }
  const color = decision === 'passed' ? 'success'
    : decision === 'overridden' ? 'processing'
      : decision === 'stale' ? 'warning'
        : decision === 'advisory_failed' ? 'orange'
          : 'error';
  return <Tag color={color}>{decision}</Tag>;
}

export function GateFreshnessAlert({
  status,
  reasons,
}: {
  status: 'fresh' | 'stale' | undefined;
  reasons?: EvaluationGateFreshnessReason[] | string[];
}) {
  if (!status) {
    return <Alert type="info" showIcon message="No freshness check returned" />;
  }
  if (status === 'fresh') {
    return <Alert type="success" showIcon message="Gate decision is fresh for the supplied exact hashes" />;
  }
  return (
    <Alert
      type="warning"
      showIcon
      message="Gate decision is stale"
      description={reasons && reasons.length > 0 ? reasons.join(', ') : 'No stale reason was returned.'}
    />
  );
}

export function EvaluationProgress({ completed, total, status }: { completed?: number; total?: number; status?: string }) {
  const safeTotal = total ?? 0;
  const safeCompleted = completed ?? 0;
  const percent = safeTotal > 0 ? Math.round((safeCompleted / safeTotal) * 100) : 0;
  const progressProps = status === 'failed' ? { status: 'exception' as const } : {};
  return (
    <Space direction="vertical" size={2} style={{ width: 180 }}>
      <Progress percent={percent} size="small" {...progressProps} />
      <Typography.Text type="secondary">{safeCompleted}/{safeTotal} cases</Typography.Text>
    </Space>
  );
}

export function EvaluationScoreSummary({
  score,
  passed,
  failed,
  systemErrors,
}: {
  score?: number | undefined;
  passed?: number | undefined;
  failed?: number | undefined;
  systemErrors?: number | undefined;
}) {
  return (
    <Space wrap>
      <Tag color={score === undefined ? 'default' : score >= 0.8 ? 'success' : score >= 0.5 ? 'warning' : 'error'}>
        score {score === undefined ? '-' : `${Math.round(score * 100)}%`}
      </Tag>
      <Tag color="success">passed {passed ?? 0}</Tag>
      <Tag color={(failed ?? 0) > 0 ? 'error' : 'default'}>failed {failed ?? 0}</Tag>
      <Tag color={(systemErrors ?? 0) > 0 ? 'volcano' : 'default'}>system_error {systemErrors ?? 0}</Tag>
    </Space>
  );
}

export function HashText({ value }: { value?: string | undefined }) {
  if (!value) {
    return <Typography.Text type="secondary">-</Typography.Text>;
  }
  return (
    <Typography.Text copyable={{ text: value }} code>
      {value.slice(0, 12)}
    </Typography.Text>
  );
}

export function SafeJsonPreview({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre className="cp-json-pre" style={{ maxHeight }}>
      {stringifyPretty(redactUnsafe(value))}
    </pre>
  );
}

export function EvidenceLinks({ taskRunId, agentRunId, toolCallIds }: {
  taskRunId?: string | undefined;
  agentRunId?: string | undefined;
  toolCallIds?: string[] | undefined;
}) {
  return (
    <Space wrap>
      {taskRunId ? <Link to={`/task-runs?task_run_id=${encodeURIComponent(taskRunId)}`}>TaskRun</Link> : null}
      {agentRunId ? <Link to={`/agent-runs?agent_run_id=${encodeURIComponent(agentRunId)}`}>AgentRun</Link> : null}
      {toolCallIds?.length ? <Link to={`/tool-calls?task_run_id=${encodeURIComponent(taskRunId ?? '')}`}>ToolCalls {toolCallIds.length}</Link> : null}
    </Space>
  );
}

export function ExactRefDescriptions({ items }: { items: Array<{ label: string; value?: React.ReactNode }> }) {
  return (
    <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 3 }}>
      {items.map((item) => (
        <Descriptions.Item key={item.label} label={item.label}>
          {item.value ?? '-'}
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}

export function CopyHashButton({ value, label = 'copy hash' }: { value?: string | undefined; label?: string }) {
  return (
    <Button
      size="small"
      disabled={!value}
      onClick={() => {
        if (value) {
          void navigator.clipboard?.writeText(value);
        }
      }}
    >
      {label}
    </Button>
  );
}

function statusColor(status: string): string {
  if (['published', 'completed', 'passed', 'validated'].includes(status)) {
    return 'success';
  }
  if (['running', 'queued', 'cancelling'].includes(status)) {
    return 'processing';
  }
  if (['failed', 'system_error', 'cancelled'].includes(status)) {
    return 'error';
  }
  if (['deprecated', 'disabled', 'stale'].includes(status)) {
    return 'warning';
  }
  return 'default';
}

function redactUnsafe(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactUnsafe);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('secret') ||
      lower.includes('token') ||
      lower.includes('authorization') ||
      lower.includes('raw_provider_response') ||
      lower.includes('hidden_reasoning') ||
      lower.includes('chain_of_thought')
    ) {
      output[key] = '[redacted]';
    } else {
      output[key] = redactUnsafe(entry);
    }
  }
  return output;
}
