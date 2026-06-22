import type { EvaluationAssertion, EvaluationCase, ExpectedToolCall } from '@dar/contracts';
import { Button, Checkbox, Form, Input, InputNumber, Select, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import type { VisualEditorProps } from '../types.js';
import { JsonSchemaBuilder } from '../components/JsonSchemaBuilder.js';
import { StringListEditor } from '../components/StringListEditor.js';
import { StructuredValueEditor, jsonObjectFromUnknown, toJsonValue } from '../components/StructuredValueEditor.js';

export function EvaluationCaseVisualEditor({ value, readOnly, onChange }: VisualEditorProps<EvaluationCase>) {
  const { t } = useTranslation();
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form layout="vertical">
        <Form.Item label="case_id"><Input data-field-path="case_id" data-testid="vc-case-id" value={value.case_id} disabled={readOnly} onChange={(event) => onChange({ ...value, case_id: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.case.name')}><Input data-field-path="name" data-testid="vc-case-name" value={value.name} disabled={readOnly} onChange={(event) => onChange({ ...value, name: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.case.description')}><Input.TextArea value={value.description ?? ''} disabled={readOnly} autoSize onChange={(event) => onChange({ ...value, description: event.target.value || undefined })} /></Form.Item>
        <Form.Item label={t('visualConfig.case.input')}><StructuredValueEditor value={toJsonValue(value.input)} readOnly={readOnly} onChange={(input) => onChange({ ...value, input: jsonObjectFromUnknown(input) })} /></Form.Item>
        <Form.Item label={t('visualConfig.case.contextRefs')}><StringListEditor value={value.context_refs} readOnly={readOnly} onChange={(context_refs) => onChange({ ...value, context_refs })} /></Form.Item>
        <Form.Item label={t('visualConfig.case.expectedStatus')}><Input value={value.expected_status ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...value, expected_status: event.target.value || undefined })} /></Form.Item>
        <Form.Item label={t('visualConfig.case.forbiddenTools')}><StringListEditor value={value.forbidden_tools} readOnly={readOnly} onChange={(forbidden_tools) => onChange({ ...value, forbidden_tools })} /></Form.Item>
        <Budget label="latency_budget_ms" testId="vc-case-latency-budget-ms" value={value.latency_budget_ms} readOnly={readOnly} onChange={(latency_budget_ms) => onChange({ ...value, latency_budget_ms })} />
        <Budget label="input_token_budget" value={value.input_token_budget} readOnly={readOnly} onChange={(input_token_budget) => onChange({ ...value, input_token_budget })} />
        <Budget label="output_token_budget" value={value.output_token_budget} readOnly={readOnly} onChange={(output_token_budget) => onChange({ ...value, output_token_budget })} />
        <Budget label="total_token_budget" value={value.total_token_budget} readOnly={readOnly} onChange={(total_token_budget) => onChange({ ...value, total_token_budget })} />
        <Budget label="cost_budget" value={value.cost_budget} readOnly={readOnly} onChange={(cost_budget) => onChange({ ...value, cost_budget })} />
        <Form.Item label={t('visualConfig.case.minimumScore')}><InputNumber min={0} max={1} step={0.01} value={value.minimum_case_score ?? null} disabled={readOnly} onChange={(minimum_case_score) => onChange({ ...value, minimum_case_score: typeof minimum_case_score === 'number' ? minimum_case_score : undefined })} /></Form.Item>
        <Form.Item label={t('visualConfig.case.weight')}><InputNumber min={0.01} value={value.weight} disabled={readOnly} onChange={(weight) => onChange({ ...value, weight: typeof weight === 'number' ? weight : value.weight })} /></Form.Item>
        <Form.Item label={t('visualConfig.case.tags')}><StringListEditor value={value.tags} readOnly={readOnly} onChange={(tags) => onChange({ ...value, tags })} /></Form.Item>
        <Checkbox checked={value.enabled} disabled={readOnly} onChange={(event) => onChange({ ...value, enabled: event.target.checked })}>{t('visualConfig.case.enabled')}</Checkbox>
      </Form>
      <ExpectedToolCallEditor value={value.expected_tool_calls} readOnly={readOnly} onChange={(expected_tool_calls) => onChange({ ...value, expected_tool_calls })} />
      <EvaluationAssertionEditor testIdPrefix="vc-case-final-assertion" testId="vc-case-add-final-assertion" title={t('visualConfig.case.finalAssertions')} value={value.final_assertions} readOnly={readOnly} onChange={(final_assertions) => onChange({ ...value, final_assertions })} />
      <EvaluationAssertionEditor testIdPrefix="vc-case-policy-assertion" testId="vc-case-add-policy-assertion" title={t('visualConfig.case.policyAssertions')} value={value.policy_assertions} readOnly={readOnly} onChange={(policy_assertions) => onChange({ ...value, policy_assertions })} />
    </Space>
  );
}

function ExpectedToolCallEditor({ value, readOnly, onChange }: { value: ExpectedToolCall[]; readOnly: boolean; onChange(value: ExpectedToolCall[]): void }) {
  const { t } = useTranslation();
  const columns: ColumnsType<ExpectedToolCall> = [
    { title: 'tool_name', dataIndex: 'tool_name', key: 'tool_name' },
    { title: 'mode', dataIndex: 'argument_match_mode', key: 'mode' },
    { title: 'min', dataIndex: 'min_calls', key: 'min' },
    { title: 'max', dataIndex: 'max_calls', key: 'max' },
    { title: t('visualConfig.actions.actions'), key: 'actions', render: (_, _row, index) => <Button danger size="small" disabled={readOnly} onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>×</Button> },
  ];
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Table size="small" rowKey={(row, index) => `${row.tool_name}:${index}`} dataSource={value} columns={columns} pagination={false} />
      <Button data-testid="vc-case-add-expected-tool" disabled={readOnly} onClick={() => onChange([...value, { tool_name: 'tool.name', min_calls: 1, max_calls: 1, argument_match_mode: 'subset', expected_arguments: {} }])}>{t('visualConfig.case.addExpectedTool')}</Button>
      {value.map((item, index) => (
        <Form layout="vertical" className="vc-bordered-section" key={`${item.tool_name}:${index}`}>
          <Form.Item label="tool_name"><Input data-field-path={`expected_tool_calls.${index}.tool_name`} data-testid={`vc-case-expected-tool-name-${index}`} value={item.tool_name} disabled={readOnly} onChange={(event) => onChange(value.map((current, itemIndex) => itemIndex === index ? { ...current, tool_name: event.target.value } : current))} /></Form.Item>
          <Form.Item label="min_calls"><InputNumber data-field-path={`expected_tool_calls.${index}.min_calls`} data-testid={`vc-case-expected-tool-min-${index}`} min={0} value={item.min_calls} disabled={readOnly} onChange={(min_calls) => onChange(value.map((current, itemIndex) => itemIndex === index ? { ...current, min_calls: typeof min_calls === 'number' ? min_calls : current.min_calls } : current))} /></Form.Item>
          <Form.Item label="max_calls"><InputNumber data-field-path={`expected_tool_calls.${index}.max_calls`} data-testid={`vc-case-expected-tool-max-${index}`} min={0} value={item.max_calls} disabled={readOnly} onChange={(max_calls) => onChange(value.map((current, itemIndex) => itemIndex === index ? { ...current, max_calls: typeof max_calls === 'number' ? max_calls : current.max_calls } : current))} /></Form.Item>
          <Form.Item label="argument_match_mode"><Select value={item.argument_match_mode} disabled={readOnly} options={['exact', 'subset', 'schema_only', 'ignore'].map((mode) => ({ value: mode, label: mode }))} onChange={(argument_match_mode) => onChange(value.map((current, itemIndex) => itemIndex === index ? { ...current, argument_match_mode } : current))} /></Form.Item>
          <Form.Item label="expected_arguments"><StructuredValueEditor value={toJsonValue(item.expected_arguments)} readOnly={readOnly} onChange={(expected_arguments) => onChange(value.map((current, itemIndex) => itemIndex === index ? { ...current, expected_arguments: jsonObjectFromUnknown(expected_arguments) } : current))} /></Form.Item>
          <Form.Item label="expected_argument_schema"><JsonSchemaBuilder value={jsonObjectFromUnknown(item.expected_argument_schema ?? { type: 'object' })} readOnly={readOnly} onChange={(expected_argument_schema) => onChange(value.map((current, itemIndex) => itemIndex === index ? { ...current, expected_argument_schema } : current))} /></Form.Item>
        </Form>
      ))}
    </Space>
  );
}

function EvaluationAssertionEditor({ title, value, readOnly, testId, testIdPrefix, onChange }: { title: string; value: EvaluationAssertion[]; readOnly: boolean; testId: string; testIdPrefix: string; onChange(value: EvaluationAssertion[]): void }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <strong>{title}</strong>
      {value.map((assertion, index) => (
        <Space key={index} direction="vertical" className="vc-bordered-section" style={{ width: '100%' }}>
          <Select data-testid={`${testIdPrefix}-type-${index}`} value={assertion.type} disabled={readOnly} options={['contains', 'not_contains', 'regex', 'json_schema', 'exact', 'non_empty'].map((type) => ({ value: type, label: type }))} onChange={(type) => onChange(value.map((current, itemIndex) => itemIndex === index ? { ...current, type, value: type === 'non_empty' ? undefined : current.value ?? '' } : current))} />
          {assertion.type === 'json_schema' ? (
            <JsonSchemaBuilder value={jsonObjectFromUnknown(assertion.value ?? { type: 'object' })} readOnly={readOnly} onChange={(next) => onChange(value.map((current, itemIndex) => itemIndex === index ? { ...current, value: next } : current))} />
          ) : assertion.type !== 'non_empty' ? (
            <Input.TextArea data-testid={`${testIdPrefix}-value-${index}`} value={typeof assertion.value === 'string' ? assertion.value : ''} disabled={readOnly} autoSize onChange={(event) => onChange(value.map((current, itemIndex) => itemIndex === index ? { ...current, value: event.target.value } : current))} />
          ) : null}
          <Button danger disabled={readOnly} onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>删除断言</Button>
        </Space>
      ))}
      <Button data-testid={testId} disabled={readOnly} onClick={() => onChange([...value, { type: 'non_empty' }])}>添加断言</Button>
    </Space>
  );
}

function Budget({ label, value, readOnly, testId, onChange }: { label: string; value: number | undefined; readOnly: boolean; testId?: string; onChange(value: number | undefined): void }) {
  return (
    <Form.Item label={label}>
      <InputNumber data-field-path={label} data-testid={testId} min={0} value={value ?? null} disabled={readOnly} onChange={(next) => onChange(typeof next === 'number' ? next : undefined)} />
    </Form.Item>
  );
}
