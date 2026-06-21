import type { EvaluationCaseResult, EvaluationComparison, EvaluationGateDecisionWithFreshness, EvaluationRun } from '@dar/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { App, Button, Descriptions, Drawer, Form, Input, Space, Table, Tabs, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Can } from '../../auth/role-guard.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { cancelRun, createComparison, getComparison, getRun, listGateDecisions, listRunResults } from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import {
  EvaluationProgress,
  EvaluationScoreSummary,
  EvaluationStatusTag,
  ExactRefDescriptions,
  EvidenceLinks,
  GateDecisionBadge,
  GateFreshnessAlert,
  HashText,
  SafeJsonPreview,
} from './evaluation-utils.js';

export function EvaluationRunDetailPage() {
  const { runId } = useParams();
  const client = useApiClient();
  const { message } = App.useApp();
  const [evidence, setEvidence] = useState<EvaluationCaseResult | undefined>();
  const [comparisonId, setComparisonId] = useState<string | undefined>();
  const [comparison, setComparison] = useState<EvaluationComparison | undefined>();
  const [comparisonForm] = Form.useForm<{ baseline_run_id: string }>();

  const runQuery = useQuery<EvaluationRun>({
    queryKey: ['evaluation-run', runId],
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ['queued', 'running', 'cancelling'].includes(status) ? 2500 : false;
    },
    queryFn: ({ signal }) => getRun(client, runId!, { signal }),
  });

  const resultsQuery = useQuery<{ evaluation_run_id: string; results: EvaluationCaseResult[] }>({
    queryKey: ['evaluation-run-results', runId],
    enabled: Boolean(runId),
    refetchInterval: runQuery.data && ['queued', 'running', 'cancelling'].includes(runQuery.data.status) ? 2500 : false,
    queryFn: ({ signal }) => listRunResults(client, runId!, { signal }),
  });

  const gateQuery = useQuery({
    queryKey: ['evaluation-run-gate-decisions', runId],
    enabled: Boolean(runId),
    queryFn: ({ signal }) => listGateDecisions(client, { page_size: 50 }, { signal }),
  });

  const getComparisonQuery = useQuery({
    queryKey: ['evaluation-comparison', comparisonId],
    enabled: Boolean(comparisonId),
    queryFn: ({ signal }) => getComparison(client, comparisonId!, { signal }),
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelRun(client, runId!),
    onSuccess: async () => {
      message.success('cancel 已提交');
      await runQuery.refetch();
    },
  });

  const comparisonMutation = useMutation({
    mutationFn: async () => {
      const values = await comparisonForm.validateFields();
      return createComparison(client, { candidate_run_id: runId!, baseline_run_id: values.baseline_run_id });
    },
    onSuccess: (result) => {
      message.success('Comparison 已创建');
      setComparison(result);
      setComparisonId(result.comparison_id);
    },
  });

  const run = runQuery.data;
  const results = resultsQuery.data?.results ?? [];
  const decisions = useMemo(
    () => (gateQuery.data?.items ?? []).filter((item) => item.decision.evaluation_run_ids.includes(runId ?? '')),
    [gateQuery.data?.items, runId],
  );

  const caseColumns: ColumnsType<EvaluationCaseResult> = [
    { title: 'case', dataIndex: 'case_id', key: 'case_id' },
    { title: 'status', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
    { title: 'score', dataIndex: 'score', key: 'score', render: (value: number | undefined) => value === undefined ? '-' : `${Math.round(value * 100)}%` },
    { title: 'actual status', dataIndex: 'actual_status', key: 'actual_status', render: (value: string | undefined) => value ?? '-' },
    { title: 'tool calls', dataIndex: 'tool_call_ids', key: 'tool_calls', render: (value: string[]) => value.length },
    { title: 'model calls', dataIndex: 'model_call_ids', key: 'model_calls', render: (value: string[]) => value.length },
    { title: 'latency', dataIndex: 'latency_ms', key: 'latency_ms', render: (value: number | undefined) => value === undefined ? '-' : `${value}ms` },
    { title: 'tokens', dataIndex: 'total_tokens', key: 'tokens', render: (value: number | undefined) => value ?? '-' },
    { title: 'cost', dataIndex: 'estimated_cost', key: 'cost', render: (value: number | undefined) => value === undefined ? '-' : value.toFixed(6) },
    { title: 'error code', dataIndex: 'error_code', key: 'error_code', render: (value: string | undefined) => value ?? '-' },
    {
      title: 'evidence',
      key: 'evidence',
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => setEvidence(row)}>安全 evidence</Button>
          <EvidenceLinks taskRunId={row.task_run_id} agentRunId={row.agent_run_id} toolCallIds={row.tool_call_ids} />
        </Space>
      ),
    },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>Evaluation Run Detail</h1>
          <p><Link to="/evaluation/runs">Evaluation Runs</Link> / {runId}</p>
        </div>
        <Space>
          <Button onClick={() => { void runQuery.refetch(); void resultsQuery.refetch(); }}>刷新</Button>
          {run && ['queued', 'running', 'cancelling'].includes(run.status) ? (
            <Can permission="registry:publish">
              <Button danger loading={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>cancel</Button>
            </Can>
          ) : null}
        </Space>
      </div>
      {runQuery.error ? <ErrorAlert error={runQuery.error} /> : null}
      {resultsQuery.error ? <ErrorAlert error={resultsQuery.error} /> : null}
      {cancelMutation.error ? <ErrorAlert error={cancelMutation.error} /> : null}
      {comparisonMutation.error ? <ErrorAlert error={comparisonMutation.error} /> : null}
      {run ? (
        <>
          <section className="cp-section">
            <ExactRefDescriptions
              items={[
                { label: 'status', value: <EvaluationStatusTag status={run.status} /> },
                { label: 'workflow_id', value: run.workflow_id ?? '-' },
                { label: 'workflow_run_id', value: run.workflow_run_id ?? '-' },
                { label: 'dataset', value: `${run.dataset_id}@${run.dataset_version}` },
                { label: 'dataset hash', value: <HashText value={run.dataset_hash} /> },
                { label: 'subject snapshot', value: run.subject_snapshot_ref },
                { label: 'subject hash', value: <HashText value={run.subject_snapshot_hash} /> },
                { label: 'execution plan', value: run.evaluation_execution_plan_ref },
                { label: 'execution plan hash', value: <HashText value={run.evaluation_execution_plan_hash} /> },
                { label: 'trigger', value: run.trigger_type },
                { label: 'started_at', value: formatDateTime(run.started_at) },
                { label: 'completed_at', value: formatDateTime(run.completed_at) },
              ]}
            />
            <div className="cp-stat-grid" style={{ marginTop: 12 }}>
              <div className="cp-metadata-item"><span>progress</span><EvaluationProgress completed={run.completed_cases} total={run.total_cases} status={run.status} /></div>
              <div className="cp-metadata-item"><span>aggregate</span><EvaluationScoreSummary score={run.aggregate_score} passed={run.passed_cases} failed={run.failed_cases} systemErrors={run.system_error_cases} /></div>
              <div className="cp-metadata-item"><span>evidence</span>{run.evidence_collection_status}</div>
            </div>
          </section>
          <Tabs
            items={[
              {
                key: 'results',
                label: 'Case Results',
                children: (
                  <section className="cp-section">
                    <Table
                      rowKey="evaluation_case_result_id"
                      loading={resultsQuery.isLoading}
                      columns={caseColumns}
                      dataSource={results}
                      pagination={{ pageSize: 10 }}
                      locale={{ emptyText: <EmptyState description="暂无 Case Result" /> }}
                    />
                  </section>
                ),
              },
              {
                key: 'comparison',
                label: 'Comparison',
                children: (
                  <section className="cp-section">
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Form form={comparisonForm} layout="inline" initialValues={{ baseline_run_id: run.baseline_run_id }}>
                        <Form.Item name="baseline_run_id" rules={[{ required: true }]}><Input placeholder="baseline_run_id" style={{ width: 320 }} /></Form.Item>
                        <Can permission="registry:publish">
                          <Button loading={comparisonMutation.isPending} onClick={() => comparisonMutation.mutate()}>create comparison</Button>
                        </Can>
                      </Form>
                      {getComparisonQuery.error ? <ErrorAlert error={getComparisonQuery.error} /> : null}
                      {comparison || getComparisonQuery.data ? <ComparisonSummary comparison={comparison ?? getComparisonQuery.data!} /> : <EmptyState description="选择 baseline 后创建 Comparison" />}
                    </Space>
                  </section>
                ),
              },
              {
                key: 'gate',
                label: 'Gate Decision',
                children: (
                  <section className="cp-section">
                    {gateQuery.error ? <ErrorAlert error={gateQuery.error} /> : null}
                    {decisions.length ? decisions.map((item) => (
                      <GateDecisionSummary key={item.decision.gate_decision_id} item={item} />
                    )) : <EmptyState description="当前 Run 暂无 Gate Decision" />}
                  </section>
                ),
              },
              {
                key: 'json',
                label: 'Safe JSON',
                children: <SafeJsonPreview value={run} />,
              },
            ]}
          />
        </>
      ) : (
        <section className="cp-section"><EmptyState description="Run 未加载" /></section>
      )}
      <Drawer title="Safe Evidence JSON" open={Boolean(evidence)} onClose={() => setEvidence(undefined)} width={780}>
        <Typography.Paragraph type="secondary">这里只展示后端返回的安全 evidence snapshot 和引用，不展示完整 Tool Result、raw Provider Response 或 hidden reasoning。</Typography.Paragraph>
        <SafeJsonPreview value={evidence} maxHeight={640} />
      </Drawer>
    </div>
  );
}

function ComparisonSummary({ comparison }: { comparison: EvaluationComparison }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 3 }}>
        <Descriptions.Item label="comparison_id">{comparison.comparison_id}</Descriptions.Item>
        <Descriptions.Item label="comparable">{String(comparison.comparable)}</Descriptions.Item>
        <Descriptions.Item label="severity">{comparison.regression_severity}</Descriptions.Item>
        <Descriptions.Item label="score_delta">{comparison.overall_score_delta ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="pass_rate_delta">{comparison.pass_rate_delta ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="newly_failed">{comparison.newly_failed_cases.length}</Descriptions.Item>
      </Descriptions>
      <SafeJsonPreview value={comparison} />
    </Space>
  );
}

function GateDecisionSummary({ item }: { item: EvaluationGateDecisionWithFreshness }) {
  return (
    <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 3 }}>
        <Descriptions.Item label="decision"><GateDecisionBadge decision={item.decision.decision} /></Descriptions.Item>
        <Descriptions.Item label="decision_id"><Link to={`/evaluation/gate-decisions/${encodeURIComponent(item.decision.gate_decision_id)}`}>{item.decision.gate_decision_id}</Link></Descriptions.Item>
        <Descriptions.Item label="resource">{item.decision.resource_type}/{item.decision.resource_id}@{item.decision.resource_version}</Descriptions.Item>
        <Descriptions.Item label="resource hash"><HashText value={item.decision.resource_hash} /></Descriptions.Item>
        <Descriptions.Item label="candidate bundle"><HashText value={item.decision.candidate_bundle_hash} /></Descriptions.Item>
        <Descriptions.Item label="policy hash"><HashText value={item.decision.gate_policy_hash} /></Descriptions.Item>
      </Descriptions>
      <GateFreshnessAlert status={item.freshness.status} reasons={item.freshness.reasons} />
    </Space>
  );
}
