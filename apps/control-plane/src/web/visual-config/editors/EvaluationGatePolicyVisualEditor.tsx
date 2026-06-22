import type { EvaluationGatePolicy } from '@dar/contracts';
import type { ApiClient } from '../../api/client.js';
import { Checkbox, Form, Input, InputNumber, Select, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import type { VisualEditorProps } from '../types.js';
import { ExactVersionSelect } from '../components/ExactVersionSelect.js';
import { StringListEditor } from '../components/StringListEditor.js';

export function EvaluationGatePolicyVisualEditor({
  value,
  readOnly,
  onChange,
  client,
}: VisualEditorProps<EvaluationGatePolicy> & { client: ApiClient }) {
  const { t } = useTranslation();
  const thresholds = value.thresholds;
  const regression = value.regression_rules;
  const datasetRef = value.required_dataset_refs[0]
    ? {
        resource_id: value.required_dataset_refs[0].dataset_id,
        version: value.required_dataset_refs[0].version,
        sha256: value.required_dataset_refs[0].dataset_hash,
      }
    : undefined;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form layout="vertical">
        <Form.Item label="gate_policy_id"><Input data-testid="vc-gate-policy-id" value={value.gate_policy_id} disabled={readOnly} onChange={(event) => onChange({ ...value, gate_policy_id: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.common.version')}><InputNumber min={1} value={value.version} disabled={readOnly} onChange={(next) => onChange({ ...value, version: typeof next === 'number' ? next : value.version })} /></Form.Item>
        <Form.Item label={t('visualConfig.gate.resourceTypes')}><Select mode="multiple" value={value.resource_types} disabled={readOnly} options={['prompt', 'agent', 'model_policy'].map((item) => ({ value: item, label: item }))} onChange={(resource_types) => onChange({ ...value, resource_types })} /></Form.Item>
        <Form.Item label={t('visualConfig.gate.requiredTags')}><StringListEditor value={value.required_case_tags} readOnly={readOnly} onChange={(required_case_tags) => onChange({ ...value, required_case_tags })} /></Form.Item>
        <Checkbox checked={value.allow_override} disabled={readOnly} onChange={(event) => onChange({ ...value, allow_override: event.target.checked })}>{t('visualConfig.gate.allowOverride')}</Checkbox>
        <Form.Item label={t('visualConfig.gate.datasetRef')}>
          <ExactVersionSelect
            client={client}
            resourceType="evaluation_dataset"
            status="published"
            includeHash
            testId="vc-gate-dataset-ref"
            readOnly={readOnly}
            {...(datasetRef ? { value: datasetRef } : {})}
            onChange={(next) => {
              if (next && typeof next.version === 'number' && next.sha256) {
                onChange({ ...value, required_dataset_refs: [{ dataset_id: next.resource_id, version: next.version, dataset_hash: next.sha256 }] });
              }
            }}
          />
        </Form.Item>
        <Threshold label="minimum_pass_rate" testId="vc-gate-minimum-pass-rate" value={thresholds.minimum_pass_rate} max={1} step={0.01} readOnly={readOnly} onChange={(minimum_pass_rate) => onChange({ ...value, thresholds: { ...thresholds, minimum_pass_rate: minimum_pass_rate ?? 0 } })} />
        <Threshold label="minimum_weighted_score" value={thresholds.minimum_weighted_score} max={1} step={0.01} readOnly={readOnly} onChange={(minimum_weighted_score) => onChange({ ...value, thresholds: { ...thresholds, minimum_weighted_score: minimum_weighted_score ?? 0 } })} />
        <Threshold label="minimum_tool_selection_score" value={thresholds.minimum_tool_selection_score} max={1} step={0.01} readOnly={readOnly} onChange={(minimum_tool_selection_score) => onChange({ ...value, thresholds: { ...thresholds, minimum_tool_selection_score: minimum_tool_selection_score ?? 0 } })} />
        <Threshold label="maximum_forbidden_tool_calls" value={thresholds.maximum_forbidden_tool_calls} readOnly={readOnly} onChange={(maximum_forbidden_tool_calls) => onChange({ ...value, thresholds: { ...thresholds, maximum_forbidden_tool_calls: maximum_forbidden_tool_calls ?? 0 } })} />
        <Threshold label="maximum_policy_violations" value={thresholds.maximum_policy_violations} readOnly={readOnly} onChange={(maximum_policy_violations) => onChange({ ...value, thresholds: { ...thresholds, maximum_policy_violations: maximum_policy_violations ?? 0 } })} />
        <Threshold label="maximum_system_error_rate" value={thresholds.maximum_system_error_rate} max={1} step={0.01} readOnly={readOnly} onChange={(maximum_system_error_rate) => onChange({ ...value, thresholds: { ...thresholds, maximum_system_error_rate: maximum_system_error_rate ?? 0 } })} />
        <Threshold label="maximum_latency_ms" value={thresholds.maximum_latency_ms} readOnly={readOnly} onChange={(maximum_latency_ms) => onChange({ ...value, thresholds: { ...thresholds, maximum_latency_ms } })} />
        <Threshold label="maximum_total_tokens" value={thresholds.maximum_total_tokens} readOnly={readOnly} onChange={(maximum_total_tokens) => onChange({ ...value, thresholds: { ...thresholds, maximum_total_tokens } })} />
        <Threshold label="maximum_cost" value={thresholds.maximum_cost} readOnly={readOnly} onChange={(maximum_cost) => onChange({ ...value, thresholds: { ...thresholds, maximum_cost } })} />
        <Threshold label="maximum_score_regression" value={regression.maximum_score_regression} max={1} step={0.01} readOnly={readOnly} onChange={(maximum_score_regression) => onChange({ ...value, regression_rules: { ...regression, maximum_score_regression: maximum_score_regression ?? 0 } })} />
        <Threshold label="maximum_pass_rate_regression" value={regression.maximum_pass_rate_regression} max={1} step={0.01} readOnly={readOnly} onChange={(maximum_pass_rate_regression) => onChange({ ...value, regression_rules: { ...regression, maximum_pass_rate_regression: maximum_pass_rate_regression ?? 0 } })} />
        <Threshold label="maximum_latency_regression_percent" testId="vc-gate-maximum-latency-regression-percent" value={regression.maximum_latency_regression_percent} readOnly={readOnly} onChange={(maximum_latency_regression_percent) => onChange({ ...value, regression_rules: { ...regression, maximum_latency_regression_percent: maximum_latency_regression_percent ?? 0 } })} />
        <Checkbox checked={regression.block_newly_failed_cases} disabled={readOnly} onChange={(event) => onChange({ ...value, regression_rules: { ...regression, block_newly_failed_cases: event.target.checked } })}>block_newly_failed_cases</Checkbox>
        <Checkbox checked={regression.block_safety_regression} disabled={readOnly} onChange={(event) => onChange({ ...value, regression_rules: { ...regression, block_safety_regression: event.target.checked } })}>block_safety_regression</Checkbox>
        <Checkbox checked={regression.block_tool_regression} disabled={readOnly} onChange={(event) => onChange({ ...value, regression_rules: { ...regression, block_tool_regression: event.target.checked } })}>block_tool_regression</Checkbox>
        <Checkbox checked={regression.require_same_dataset} disabled={readOnly} onChange={(event) => onChange({ ...value, regression_rules: { ...regression, require_same_dataset: event.target.checked } })}>require_same_dataset</Checkbox>
      </Form>
    </Space>
  );
}

function Threshold({ label, value, readOnly, max, step, testId, onChange }: { label: string; value: number | undefined; readOnly: boolean; max?: number; step?: number; testId?: string; onChange(value: number | undefined): void }) {
  return (
    <Form.Item label={label}>
      <InputNumber
        data-testid={testId}
        min={0}
        {...(max !== undefined ? { max } : {})}
        {...(step !== undefined ? { step } : {})}
        value={value ?? null}
        disabled={readOnly}
        onChange={(next) => onChange(typeof next === 'number' ? next : undefined)}
      />
    </Form.Item>
  );
}
