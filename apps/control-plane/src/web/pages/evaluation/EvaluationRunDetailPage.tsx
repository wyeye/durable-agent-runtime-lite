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
      message.success('取消已提交');
      await runQuery.refetch();
    },
  });

  const comparisonMutation = useMutation({
    mutationFn: async () => {
      const values = await comparisonForm.validateFields();
      return createComparison(client, { candidate_run_id: runId!, baseline_run_id: values.baseline_run_id });
    },
    onSuccess: (result) => {
      message.success('对比已创建');
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
    { title: 'Case', dataIndex: 'case_id', key: 'case_id' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (status: string) => <EvaluationStatusTag status={status} /> },
    { title: '分数', dataIndex: 'score', key: 'score', render: (value: number | undefined) => value === undefined ? '-' : `${Math.round(value * 100)}%` },
    { title: '实际状态', dataIndex: 'actual_status', key: 'actual_status', render: (value: string | undefined) => value ?? '-' },
    { title: '工具调用', dataIndex: 'tool_call_ids', key: 'tool_calls', render: (value: string[]) => value.length },
    { title: '模型调用', dataIndex: 'model_call_ids', key: 'model_calls', render: (value: string[]) => value.length },
    { title: '延迟', dataIndex: 'latency_ms', key: 'latency_ms', render: (value: number | undefined) => value === undefined ? '-' : `${value}ms` },
    { title: 'Token 数', dataIndex: 'total_tokens', key: 'tokens', render: (value: number | undefined) => value ?? '-' },
    { title: '成本', dataIndex: 'estimated_cost', key: 'cost', render: (value: number | undefined) => value === undefined ? '-' : value.toFixed(6) },
    { title: '错误码', dataIndex: 'error_code', key: 'error_code', render: (value: string | undefined) => value ?? '-' },
    {
	      title: '证据',
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
          <h1>评测任务详情</h1>
          <p><Link to="/evaluation/runs">评测任务</Link> / {runId}</p>
        </div>
        <Space>
          <Button onClick={() => { void runQuery.refetch(); void resultsQuery.refetch(); }}>刷新</Button>
          {run && ['queued', 'running', 'cancelling'].includes(run.status) ? (
            <Can permission="registry:publish">
	              <Button danger loading={cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>取消</Button>
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
	                { label: '状态', value: <EvaluationStatusTag status={run.status} /> },
                { label: 'workflow_id', value: run.workflow_id ?? '-' },
                { label: 'workflow_run_id', value: run.workflow_run_id ?? '-' },
	                { label: '数据集', value: `${run.dataset_id}@${run.dataset_version}` },
	                { label: 'dataset hash', value: <HashText value={run.dataset_hash} /> },
	                { label: '对象快照', value: run.subject_snapshot_ref },
	                { label: '对象 hash', value: <HashText value={run.subject_snapshot_hash} /> },
	                { label: '执行计划', value: run.evaluation_execution_plan_ref },
	                { label: '执行计划 hash', value: <HashText value={run.evaluation_execution_plan_hash} /> },
	                { label: '触发方式', value: run.trigger_type },
	                { label: '开始时间', value: formatDateTime(run.started_at) },
	                { label: '完成时间', value: formatDateTime(run.completed_at) },
              ]}
            />
            <div className="cp-stat-grid" style={{ marginTop: 12 }}>
	              <div className="cp-metadata-item"><span>进度</span><EvaluationProgress completed={run.completed_cases} total={run.total_cases} status={run.status} /></div>
	              <div className="cp-metadata-item"><span>汇总</span><EvaluationScoreSummary score={run.aggregate_score} passed={run.passed_cases} failed={run.failed_cases} systemErrors={run.system_error_cases} /></div>
	              <div className="cp-metadata-item"><span>证据</span>{run.evidence_collection_status}</div>
            </div>
          </section>
          <Tabs
            items={[
              {
                key: 'results',
	                label: 'Case 结果',
                children: (
                  <section className="cp-section">
                    <Table
                      rowKey="evaluation_case_result_id"
                      loading={resultsQuery.isLoading}
                      columns={caseColumns}
                      dataSource={results}
                      pagination={{ pageSize: 10 }}
	                      locale={{ emptyText: <EmptyState description="暂无 Case 结果" /> }}
                    />
                  </section>
                ),
              },
              {
                key: 'comparison',
	                label: '对比',
                children: (
                  <section className="cp-section">
                    <Space direction="vertical" style={{ width: '100%' }}>
                      <Form form={comparisonForm} layout="inline" initialValues={{ baseline_run_id: run.baseline_run_id }}>
                        <Form.Item name="baseline_run_id" rules={[{ required: true }]}><Input placeholder="baseline_run_id" style={{ width: 320 }} /></Form.Item>
                        <Can permission="registry:publish">
	                          <Button loading={comparisonMutation.isPending} onClick={() => comparisonMutation.mutate()}>创建对比</Button>
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
	                label: '门禁结论',
                children: (
                  <section className="cp-section">
                    {gateQuery.error ? <ErrorAlert error={gateQuery.error} /> : null}
	                    {decisions.length ? decisions.map((item) => (
	                      <GateDecisionSummary key={item.decision.gate_decision_id} item={item} />
	                    )) : <EmptyState description="当前评测任务暂无门禁结论" />}
                  </section>
                ),
              },
              {
                key: 'json',
	                label: '安全 JSON',
                children: <SafeJsonPreview value={run} />,
              },
            ]}
          />
        </>
      ) : (
        <section className="cp-section"><EmptyState description="评测任务未加载" /></section>
      )}
      <Drawer title="安全证据 JSON" open={Boolean(evidence)} onClose={() => setEvidence(undefined)} width={780}>
        <Typography.Paragraph type="secondary">这里只展示后端返回的安全证据快照和引用，不展示完整 Tool Result、raw Provider Response 或 hidden reasoning。</Typography.Paragraph>
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
        <Descriptions.Item label="可对比">{String(comparison.comparable)}</Descriptions.Item>
        <Descriptions.Item label="严重级别">{comparison.regression_severity}</Descriptions.Item>
        <Descriptions.Item label="分数变化">{comparison.overall_score_delta ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="通过率变化">{comparison.pass_rate_delta ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="新增失败">{comparison.newly_failed_cases.length}</Descriptions.Item>
      </Descriptions>
      <SafeJsonPreview value={comparison} />
    </Space>
  );
}

function GateDecisionSummary({ item }: { item: EvaluationGateDecisionWithFreshness }) {
  return (
    <Space direction="vertical" style={{ width: '100%', marginBottom: 16 }}>
      <Descriptions bordered size="small" column={{ xs: 1, md: 3 }}>
        <Descriptions.Item label="结论"><GateDecisionBadge decision={item.decision.decision} /></Descriptions.Item>
        <Descriptions.Item label="decision_id"><Link to={`/evaluation/gate-decisions/${encodeURIComponent(item.decision.gate_decision_id)}`}>{item.decision.gate_decision_id}</Link></Descriptions.Item>
        <Descriptions.Item label="资源">{item.decision.resource_type}/{item.decision.resource_id}@{item.decision.resource_version}</Descriptions.Item>
        <Descriptions.Item label="资源 hash"><HashText value={item.decision.resource_hash} /></Descriptions.Item>
        <Descriptions.Item label="候选包"><HashText value={item.decision.candidate_bundle_hash} /></Descriptions.Item>
        <Descriptions.Item label="策略 hash"><HashText value={item.decision.gate_policy_hash} /></Descriptions.Item>
      </Descriptions>
      <GateFreshnessAlert status={item.freshness.status} reasons={item.freshness.reasons} />
    </Space>
  );
}
