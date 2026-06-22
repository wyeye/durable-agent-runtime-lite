import type { TenantRuntimePolicy } from '@dar/contracts';
import { Alert, Form, Input, InputNumber, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { VisualEditorProps } from '../types.js';
import { StringListEditor } from '../components/StringListEditor.js';

export function TenantRuntimePolicyVisualEditor({ value, readOnly, onChange }: VisualEditorProps<TenantRuntimePolicy>) {
  const { t } = useTranslation();
  const budget = value.budget_cap ?? {};
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert type="info" showIcon message={t('visualConfig.tenantPolicy.deniedFirst')} />
      <Form layout="vertical">
        <Form.Item label="tenant_id"><Input data-testid="vc-tenant-id" value={value.tenant_id} disabled={readOnly} onChange={(event) => onChange({ ...value, tenant_id: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.common.version')}><InputNumber min={1} value={value.version} disabled={readOnly} onChange={(next) => onChange({ ...value, version: typeof next === 'number' ? next : value.version })} /></Form.Item>
        <Form.Item label={t('visualConfig.tenantPolicy.maxConcurrent')}><InputNumber min={1} value={value.max_concurrent_agent_runs} disabled={readOnly} onChange={(next) => onChange({ ...value, max_concurrent_agent_runs: typeof next === 'number' ? next : value.max_concurrent_agent_runs })} /></Form.Item>
        <RuleList title={t('visualConfig.tenantPolicy.allowedTools')} values={value.allowed_tools.map((rule) => rule.tool_name)} readOnly={readOnly} onChange={(items) => onChange({ ...value, allowed_tools: items.map((tool_name) => ({ tool_name, allowed_operations: ['invoke'] })) })} />
        <RuleList title={t('visualConfig.tenantPolicy.deniedTools')} values={value.denied_tools.map((rule) => rule.tool_name)} readOnly={readOnly} danger onChange={(items) => onChange({ ...value, denied_tools: items.map((tool_name) => ({ tool_name, allowed_operations: ['invoke'] })) })} />
        <RuleList title={t('visualConfig.tenantPolicy.allowedModels')} values={value.allowed_models.map((rule) => rule.model_id)} readOnly={readOnly} onChange={(items) => onChange({ ...value, allowed_models: items.map((model_id) => ({ model_id })) })} />
        <RuleList title={t('visualConfig.tenantPolicy.deniedModels')} values={value.denied_models.map((rule) => rule.model_id)} readOnly={readOnly} danger onChange={(items) => onChange({ ...value, denied_models: items.map((model_id) => ({ model_id })) })} />
        <RuleList title={t('visualConfig.tenantPolicy.allowedHandoffs')} values={value.allowed_handoffs.map((rule) => rule.flow_id)} readOnly={readOnly} onChange={(items) => onChange({ ...value, allowed_handoffs: items.map((flow_id) => ({ flow_id })) })} />
        <RuleList title={t('visualConfig.tenantPolicy.deniedHandoffs')} values={value.denied_handoffs.map((rule) => rule.flow_id)} readOnly={readOnly} danger onChange={(items) => onChange({ ...value, denied_handoffs: items.map((flow_id) => ({ flow_id })) })} />
        <BudgetField label="max_segments" value={budget.max_segments} readOnly={readOnly} onChange={(max_segments) => onChange({ ...value, budget_cap: { ...budget, max_segments } })} />
        <BudgetField label="max_model_turns" value={budget.max_model_turns} readOnly={readOnly} onChange={(max_model_turns) => onChange({ ...value, budget_cap: { ...budget, max_model_turns } })} />
        <BudgetField label="max_tool_calls" value={budget.max_tool_calls} readOnly={readOnly} onChange={(max_tool_calls) => onChange({ ...value, budget_cap: { ...budget, max_tool_calls } })} />
        <BudgetField label="max_handoffs" value={budget.max_handoffs} readOnly={readOnly} onChange={(max_handoffs) => onChange({ ...value, budget_cap: { ...budget, max_handoffs } })} />
        <BudgetField label="max_total_tokens" value={budget.max_total_tokens} readOnly={readOnly} onChange={(max_total_tokens) => onChange({ ...value, budget_cap: { ...budget, max_total_tokens } })} />
        <BudgetField label="max_duration_ms" value={budget.max_duration_ms} readOnly={readOnly} onChange={(max_duration_ms) => onChange({ ...value, budget_cap: { ...budget, max_duration_ms } })} />
        <BudgetField label="max_context_bytes" value={budget.max_context_bytes} readOnly={readOnly} onChange={(max_context_bytes) => onChange({ ...value, budget_cap: { ...budget, max_context_bytes } })} />
        <BudgetField label="max_cost" value={budget.max_cost} readOnly={readOnly} onChange={(max_cost) => onChange({ ...value, budget_cap: { ...budget, max_cost } })} />
      </Form>
    </Space>
  );
}

function RuleList({
  title,
  values,
  readOnly,
  danger = false,
  onChange,
}: {
  title: string;
  values: string[];
  readOnly: boolean;
  danger?: boolean;
  onChange(value: string[]): void;
}) {
  return (
    <Form.Item label={danger ? <Typography.Text type="danger">{title}</Typography.Text> : title}>
      <StringListEditor value={values} readOnly={readOnly} onChange={onChange} />
    </Form.Item>
  );
}

function BudgetField({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: number | undefined;
  readOnly: boolean;
  onChange(value: number | undefined): void;
}) {
  return (
    <Form.Item label={label}>
      <InputNumber min={0} value={value ?? null} disabled={readOnly} onChange={(next) => onChange(typeof next === 'number' ? next : undefined)} />
    </Form.Item>
  );
}
