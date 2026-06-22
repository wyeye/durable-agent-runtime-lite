import type { ToolManifest } from '@dar/contracts';
import { Alert, Checkbox, Form, Input, InputNumber, Select, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import type { VisualEditorProps } from '../types.js';
import { JsonSchemaBuilder } from '../components/JsonSchemaBuilder.js';
import { StringListEditor } from '../components/StringListEditor.js';
import { StructuredValueEditor, jsonObjectFromUnknown, toJsonValue } from '../components/StructuredValueEditor.js';

export function ToolVisualEditor({ value, readOnly, onChange }: VisualEditorProps<ToolManifest>) {
  const { t } = useTranslation();
  const adapter = value.adapter;
  const evaluationPolicy = value.evaluation_policy ?? {
    allowed_in_evaluation: false,
    mode: 'deny',
    allowed_tenants: [],
    result_redaction_policy: 'mask_sensitive',
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {(value.risk_level === 'L3' || value.risk_level === 'L4') ? <Alert type="warning" showIcon message={t('visualConfig.tool.highRisk')} /> : null}
      {value.side_effect ? <Alert type="info" showIcon message={t('visualConfig.tool.sideEffectNotice')} /> : null}
      <Form layout="vertical">
        <Form.Item label={t('visualConfig.tool.name')}><Input data-testid="vc-tool-name" value={value.tool_name} disabled={readOnly} onChange={(event) => onChange({ ...value, tool_name: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.common.version')}><Input value={value.version} disabled={readOnly} onChange={(event) => onChange({ ...value, version: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.description')}><Input.TextArea value={value.description ?? ''} disabled={readOnly} autoSize onChange={(event) => onChange({ ...value, description: event.target.value || undefined })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.risk')}><Select data-testid="vc-tool-risk-level" value={value.risk_level} disabled={readOnly} options={['L0', 'L1', 'L2', 'L3', 'L4'].map((item) => ({ value: item, label: item }))} onChange={(risk_level) => onChange({ ...value, risk_level })} /></Form.Item>
        <Checkbox data-testid="vc-tool-side-effect" checked={Boolean(value.side_effect)} disabled={readOnly} onChange={(event) => onChange({ ...value, side_effect: event.target.checked })}>{t('visualConfig.tool.sideEffect')}</Checkbox>
        <Form.Item label={t('visualConfig.tool.permissions')}><StringListEditor value={value.required_permissions ?? []} readOnly={readOnly} onChange={(required_permissions) => onChange({ ...value, required_permissions })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.adapterType')}><Select value={adapter.type} disabled={readOnly} options={['http', 'mcp', 'mock', 'internal-api', 'db'].map((item) => ({ value: item, label: item }))} onChange={(type) => onChange({ ...value, adapter: { ...adapter, type } })} /></Form.Item>
        <Form.Item label="endpoint_ref"><Input data-testid="vc-tool-endpoint-ref" value={adapter.endpoint_ref ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...value, adapter: { ...adapter, endpoint_ref: event.target.value || undefined } })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.adapterConfig')}><StructuredValueEditor value={toJsonValue(adapter.config ?? {})} readOnly={readOnly} onChange={(config) => onChange({ ...value, adapter: { ...adapter, config: jsonObjectFromUnknown(config) } })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.inputSchema')}><JsonSchemaBuilder value={jsonObjectFromUnknown(value.input_schema ?? { type: 'object' })} readOnly={readOnly} onChange={(input_schema) => onChange({ ...value, input_schema })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.outputSchema')}><JsonSchemaBuilder value={jsonObjectFromUnknown(value.output_schema ?? { type: 'object' })} readOnly={readOnly} onChange={(output_schema) => onChange({ ...value, output_schema })} /></Form.Item>
        <Checkbox checked={Boolean(evaluationPolicy.allowed_in_evaluation)} disabled={readOnly} onChange={(event) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, allowed_in_evaluation: event.target.checked } })}>{t('visualConfig.tool.evaluationAllowed')}</Checkbox>
        <Form.Item label={t('visualConfig.tool.evaluationMode')}><Select value={evaluationPolicy.mode} disabled={readOnly} options={['deny', 'preview_only', 'sandbox_commit'].map((item) => ({ value: item, label: item }))} onChange={(mode) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, mode } })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.allowedTenants')}><StringListEditor value={evaluationPolicy.allowed_tenants ?? []} readOnly={readOnly} onChange={(allowed_tenants) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, allowed_tenants } })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.redaction')}><Select value={evaluationPolicy.result_redaction_policy} disabled={readOnly} options={['none', 'mask_sensitive', 'summary_only'].map((item) => ({ value: item, label: item }))} onChange={(result_redaction_policy) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, result_redaction_policy } })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.maxCalls')}><InputNumber min={1} value={evaluationPolicy.maximum_calls_per_case ?? null} disabled={readOnly} onChange={(maximum_calls_per_case) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, maximum_calls_per_case: typeof maximum_calls_per_case === 'number' ? maximum_calls_per_case : undefined } })} /></Form.Item>
      </Form>
    </Space>
  );
}
