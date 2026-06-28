import { translate } from '@dar/i18n';
import type {
  EvaluationDataset,
  EvaluationGateDecisionWithFreshness,
  EvaluationGatePolicy,
  EvaluationRun,
} from '@dar/contracts';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, List, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router';
import { ReadOnlyNotice } from '../../auth/role-guard.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { listDatasets, listGateDecisions, listGatePolicies, listRuns } from '../../api/evaluation-api.js';
import { formatDateTime } from '../../utils/format.js';
import {
  EvaluationScoreSummary,
  EvaluationStatusTag,
  GateDecisionBadge,
  HashText,
} from './evaluation-utils.js';

const DATASET_SAMPLE_SIZE = 20;
const RUN_SAMPLE_SIZE = 20;
const GATE_POLICY_SAMPLE_SIZE = 20;
const GATE_DECISION_SAMPLE_SIZE = 8;

export function EvaluationOverviewPage() {
  const client = useApiClient();
  const datasetsQuery = useQuery({
    queryKey: ['evaluation-overview', 'datasets'],
    queryFn: ({ signal }) => listDatasets(client, { page_size: DATASET_SAMPLE_SIZE }, { signal }),
  });
  const runsQuery = useQuery({
    queryKey: ['evaluation-overview', 'runs'],
    queryFn: ({ signal }) => listRuns(client, { page_size: RUN_SAMPLE_SIZE }, { signal }),
  });
  const gatePoliciesQuery = useQuery({
    queryKey: ['evaluation-overview', 'gate-policies'],
    queryFn: ({ signal }) => listGatePolicies(client, { page_size: GATE_POLICY_SAMPLE_SIZE }, { signal }),
  });
  const gateDecisionsQuery = useQuery({
    queryKey: ['evaluation-overview', 'gate-decisions'],
    queryFn: ({ signal }) => listGateDecisions(client, { page_size: GATE_DECISION_SAMPLE_SIZE }, { signal }),
  });

  const datasets = datasetsQuery.data?.items ?? [];
  const runs = runsQuery.data ?? [];
  const gatePolicies = gatePoliciesQuery.data?.items ?? [];
  const gateDecisions = gateDecisionsQuery.data?.items ?? [];
  const loading = [
    datasetsQuery.isFetching,
    runsQuery.isFetching,
    gatePoliciesQuery.isFetching,
    gateDecisionsQuery.isFetching,
  ].some(Boolean);
  const errors = [
    datasetsQuery.error,
    runsQuery.error,
    gatePoliciesQuery.error,
    gateDecisionsQuery.error,
  ].filter((error): error is NonNullable<typeof error> => Boolean(error));

  const refreshAll = () => {
    void Promise.allSettled([
      datasetsQuery.refetch(),
      runsQuery.refetch(),
      gatePoliciesQuery.refetch(),
      gateDecisionsQuery.refetch(),
    ]);
  };

  const runColumns: ColumnsType<EvaluationRun> = [
    {
      title: t('evaluation.overview.table.runId'),
      dataIndex: 'evaluation_run_id',
      key: 'evaluation_run_id',
      render: (value: string) => (
        <Link to={`/evaluation/runs/${encodeURIComponent(value)}`}>{value.slice(0, 18)}</Link>
      ),
    },
    {
      title: t('evaluation.overview.table.dataset'),
      key: 'dataset',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>
            {row.dataset_id}@{row.dataset_version}
          </span>
          <HashText value={row.dataset_hash} />
        </Space>
      ),
    },
    { title: t('evaluation.overview.table.trigger'), dataIndex: 'trigger_type', key: 'trigger_type' },
    {
      title: t('evaluation.overview.table.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => <EvaluationStatusTag status={status} />,
    },
    {
      title: t('evaluation.overview.table.aggregate'),
      key: 'aggregate',
      render: (_, row) => (
        <EvaluationScoreSummary
          score={row.aggregate_score}
          passed={row.passed_cases}
          failed={row.failed_cases}
          systemErrors={row.system_error_cases}
        />
      ),
    },
    {
      title: t('evaluation.overview.table.updatedAt'),
      key: 'updated_at',
      render: (_, row) => formatDateTime(row.completed_at ?? row.started_at),
    },
  ];

  const gateDecisionColumns: ColumnsType<EvaluationGateDecisionWithFreshness> = [
    {
      title: t('evaluation.overview.table.resource'),
      key: 'resource',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <span>
            {row.decision.resource_type}/{row.decision.resource_id}@{row.decision.resource_version}
          </span>
          <HashText value={row.decision.resource_hash} />
        </Space>
      ),
    },
    {
      title: t('evaluation.overview.table.status'),
      key: 'decision',
      render: (_, row) => <GateDecisionBadge decision={row.decision.decision} />,
    },
    {
      title: t('evaluation.overview.table.freshness'),
      key: 'freshness',
      render: (_, row) => <Tag color={row.freshness.status === 'fresh' ? 'success' : 'warning'}>{displayFreshness(row.freshness.status)}</Tag>,
    },
    {
      title: t('evaluation.overview.table.decidedAt'),
      dataIndex: ['decision', 'decided_at'],
      key: 'decided_at',
      render: (value: string | undefined) => formatDateTime(value),
    },
    {
      title: t('evaluation.overview.table.open'),
      key: 'open',
      render: (_, row) => (
        <Link to={`/evaluation/gate-decisions/${encodeURIComponent(row.decision.gate_decision_id)}`}>
          {t('evaluation.overview.table.open')}
        </Link>
      ),
    },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>{t('evaluation.overview.title')}</h1>
          <p>{t('evaluation.overview.subtitle')}</p>
        </div>
        <Button onClick={refreshAll} loading={loading}>
          {t('evaluation.overview.refresh')}
        </Button>
      </div>
      <ReadOnlyNotice />
      {errors.map((error, index) => (
        <ErrorAlert key={`${index}-${String(error)}`} error={error} />
      ))}
      <section className="cp-section cp-eval-overview-hero">
        <div className="cp-eval-overview-banner">
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('evaluation.overview.modulesTitle')}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t('evaluation.overview.modulesSubtitle')}
          </Typography.Paragraph>
        </div>
        <Alert
          type="info"
          showIcon
          message={t('evaluation.overview.sampleNotice', {
            datasets: DATASET_SAMPLE_SIZE,
            runs: RUN_SAMPLE_SIZE,
            decisions: GATE_DECISION_SAMPLE_SIZE,
          })}
        />
        <div className="cp-eval-module-grid">
          <OverviewModuleCard
            tone="dataset"
            eyebrow={t('evaluation.pages.datasets')}
            title={t('evaluation.overview.modules.datasetsTitle')}
            description={t('evaluation.overview.modules.datasetsDescription')}
            primaryValue={countStatus(datasets, 'published')}
            primaryLabel={t('evaluation.overview.highlights.publishedDatasets')}
            sampleLabel={t('evaluation.overview.sampleWindow', { count: datasets.length })}
            to="/evaluation/datasets"
            stats={[
              { label: t('evaluation.overview.moduleStats.loaded'), value: datasets.length },
              { label: t('evaluation.overview.moduleStats.validated'), value: countStatus(datasets, 'validated') },
              { label: t('evaluation.overview.moduleStats.draft'), value: countStatus(datasets, 'draft') },
            ]}
          />
          <OverviewModuleCard
            tone="run"
            eyebrow={t('evaluation.pages.runs')}
            title={t('evaluation.overview.modules.runsTitle')}
            description={t('evaluation.overview.modules.runsDescription')}
            primaryValue={countStatus(runs, 'running')}
            primaryLabel={t('evaluation.overview.highlights.runningRuns')}
            sampleLabel={t('evaluation.overview.sampleWindow', { count: runs.length })}
            to="/evaluation/runs"
            stats={[
              { label: t('evaluation.overview.moduleStats.queued'), value: countStatus(runs, 'queued') },
              { label: t('evaluation.overview.moduleStats.completed'), value: countStatus(runs, 'completed') },
              { label: t('evaluation.overview.moduleStats.failed'), value: countStatus(runs, 'failed') },
            ]}
          />
          <OverviewModuleCard
            tone="gate"
            eyebrow={t('evaluation.pages.gates')}
            title={t('evaluation.overview.modules.gatesTitle')}
            description={t('evaluation.overview.modules.gatesDescription')}
            primaryValue={countStatus(gatePolicies, 'published')}
            primaryLabel={t('evaluation.overview.highlights.publishedGates')}
            sampleLabel={t('evaluation.overview.sampleWindow', { count: gatePolicies.length })}
            to="/evaluation/gates"
            stats={[
              { label: t('evaluation.overview.moduleStats.loaded'), value: gatePolicies.length },
              { label: t('evaluation.overview.moduleStats.validated'), value: countStatus(gatePolicies, 'validated') },
              { label: t('evaluation.overview.moduleStats.draft'), value: countStatus(gatePolicies, 'draft') },
            ]}
          />
        </div>
      </section>
      <section className="cp-section">
        <div className="cp-page-header">
          <div>
            <h2 className="cp-eval-section-title">{t('evaluation.overview.statsTitle')}</h2>
            <p>{t('evaluation.overview.statsSubtitle')}</p>
          </div>
        </div>
        <div className="cp-stat-grid">
          <Statistic
            title={t('evaluation.overview.highlights.publishedDatasets')}
            value={countStatus(datasets, 'published')}
            loading={datasetsQuery.isLoading}
          />
          <Statistic
            title={t('evaluation.overview.highlights.runningRuns')}
            value={countStatus(runs, 'running')}
            loading={runsQuery.isLoading}
          />
          <Statistic
            title={t('evaluation.overview.highlights.failedRuns')}
            value={countStatus(runs, 'failed')}
            loading={runsQuery.isLoading}
          />
          <Statistic
            title={t('evaluation.overview.highlights.completedRuns')}
            value={countStatus(runs, 'completed')}
            loading={runsQuery.isLoading}
          />
          <Statistic
            title={t('evaluation.overview.highlights.freshPassedDecisions')}
            value={countFreshPassed(gateDecisions)}
            loading={gateDecisionsQuery.isLoading}
          />
          <Statistic
            title={t('evaluation.overview.highlights.staleDecisions')}
            value={gateDecisions.filter((item) => item.freshness.status === 'stale').length}
            loading={gateDecisionsQuery.isLoading}
          />
        </div>
      </section>
      <div className="cp-split">
        <section className="cp-section">
          <div className="cp-page-header">
            <div>
              <h2 className="cp-eval-section-title">{t('evaluation.overview.recentRuns')}</h2>
              <p>{t('evaluation.overview.recentRunsSubtitle')}</p>
            </div>
            <Link to="/evaluation/runs">{t('evaluation.overview.moduleAction')}</Link>
          </div>
          <Table
            size="small"
            rowKey="evaluation_run_id"
            loading={runsQuery.isLoading}
            columns={runColumns}
            dataSource={runs.slice(0, 6)}
            pagination={false}
            locale={{ emptyText: <EmptyState description={t('evaluation.overview.noRuns')} /> }}
          />
        </section>
        <section className="cp-section">
          <div className="cp-page-header">
            <div>
              <h2 className="cp-eval-section-title">{t('evaluation.overview.recentDecisions')}</h2>
              <p>{t('evaluation.overview.recentDecisionsSubtitle')}</p>
            </div>
            <Link to="/evaluation/gates">{t('evaluation.overview.moduleAction')}</Link>
          </div>
          <Table
            size="small"
            rowKey={(row) => row.decision.gate_decision_id}
            loading={gateDecisionsQuery.isLoading}
            columns={gateDecisionColumns}
            dataSource={gateDecisions}
            pagination={false}
            locale={{ emptyText: <EmptyState description={t('evaluation.overview.noDecisions')} /> }}
          />
        </section>
      </div>
      <div className="cp-split">
        <section className="cp-section">
          <div className="cp-page-header">
            <div>
              <h2 className="cp-eval-section-title">{t('evaluation.overview.sampleDatasets')}</h2>
              <p>{t('evaluation.overview.sampleDatasetsSubtitle')}</p>
            </div>
            <Link to="/evaluation/datasets">{t('evaluation.overview.moduleAction')}</Link>
          </div>
          <List
            dataSource={datasets.slice(0, 5)}
            loading={datasetsQuery.isLoading}
            locale={{ emptyText: <EmptyState description={t('evaluation.overview.noDatasets')} /> }}
            renderItem={(dataset) => (
              <List.Item
                className="cp-eval-list-item"
                extra={
                  <Space direction="vertical" size={6} style={{ alignItems: 'flex-end' }}>
                    <EvaluationStatusTag status={dataset.status} />
                    <HashText value={dataset.dataset_hash} />
                  </Space>
                }
              >
                <List.Item.Meta
                  title={
                    <Link to={`/evaluation/datasets/${encodeURIComponent(dataset.dataset_id)}/versions/${dataset.version}`}>
                      {dataset.dataset_id}@{dataset.version}
                    </Link>
                  }
                  description={
                    <Space direction="vertical" size={2}>
                      <span>{dataset.name}</span>
                      <Typography.Text type="secondary">
                        {dataset.domain ?? '-'} · {formatDateTime(dataset.updated_at)}
                      </Typography.Text>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        </section>
        <section className="cp-section">
          <div className="cp-page-header">
            <div>
              <h2 className="cp-eval-section-title">{t('evaluation.overview.sampleGates')}</h2>
              <p>{t('evaluation.overview.sampleGatesSubtitle')}</p>
            </div>
            <Link to="/evaluation/gates">{t('evaluation.overview.moduleAction')}</Link>
          </div>
          <List
            dataSource={gatePolicies.slice(0, 5)}
            loading={gatePoliciesQuery.isLoading}
            locale={{ emptyText: <EmptyState description={t('evaluation.overview.noGatePolicies')} /> }}
            renderItem={(policy) => (
              <List.Item
                className="cp-eval-list-item"
                extra={
                  <Space direction="vertical" size={6} style={{ alignItems: 'flex-end' }}>
                    <EvaluationStatusTag status={policy.status} />
                    <HashText value={policy.gate_policy_hash} />
                  </Space>
                }
              >
                <List.Item.Meta
                  title={
                    <Link to={`/evaluation/gates/${encodeURIComponent(policy.gate_policy_id)}/versions/${policy.version}`}>
                      {policy.gate_policy_id}@{policy.version}
                    </Link>
                  }
                  description={
                    <Space direction="vertical" size={2}>
                      <span>{policy.resource_types.join(', ')}</span>
                      <Typography.Text type="secondary">
                        {policy.required_dataset_refs.length} 个 exact dataset 引用 · {formatDateTime(policy.updated_at)}
                      </Typography.Text>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        </section>
      </div>
    </div>
  );
}

function OverviewModuleCard({
  tone,
  eyebrow,
  title,
  description,
  primaryValue,
  primaryLabel,
  sampleLabel,
  stats,
  to,
}: {
  tone: 'dataset' | 'run' | 'gate';
  eyebrow: string;
  title: string;
  description: string;
  primaryValue: number;
  primaryLabel: string;
  sampleLabel: string;
  stats: Array<{ label: string; value: number }>;
  to: string;
}) {
  return (
    <article className={`cp-eval-module-card cp-eval-module-card-${tone}`}>
      <div>
        <div className="cp-eval-module-eyebrow">{eyebrow}</div>
        <Typography.Title level={3} className="cp-eval-module-title">
          {title}
        </Typography.Title>
        <Typography.Paragraph type="secondary" className="cp-eval-module-description">
          {description}
        </Typography.Paragraph>
      </div>
      <div className="cp-eval-module-primary">
        <strong>{primaryValue}</strong>
        <span>{primaryLabel}</span>
        <Typography.Text type="secondary">{sampleLabel}</Typography.Text>
      </div>
      <div className="cp-eval-module-stats">
        {stats.map((stat) => (
          <div key={stat.label} className="cp-eval-module-stat">
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </div>
      <div className="cp-eval-module-actions">
        <Link to={to}>{t('evaluation.overview.moduleAction')}</Link>
      </div>
    </article>
  );
}

function countStatus(items: Array<{ status: string }>, status: string): number {
  return items.filter((item) => item.status === status).length;
}

function countFreshPassed(items: EvaluationGateDecisionWithFreshness[]): number {
  return items.filter((item) => item.decision.decision === 'passed' && item.freshness.status === 'fresh').length;
}

function displayFreshness(status: 'fresh' | 'stale' | undefined): string {
  if (status === 'fresh') {
    return t('evaluation.overview.freshness.fresh');
  }
  if (status === 'stale') {
    return t('evaluation.overview.freshness.stale');
  }
  return '-';
}

function t(key: string, params?: Record<string, string | number>) {
  return translate(key, params);
}
