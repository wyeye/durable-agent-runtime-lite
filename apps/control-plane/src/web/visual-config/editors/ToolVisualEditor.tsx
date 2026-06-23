import type { ToolManifest } from '@dar/contracts';
import { Alert, Checkbox, Form, Input, InputNumber, Select, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import type { VisualEditorProps } from '../types.js';
import { JsonSchemaBuilder } from '../components/JsonSchemaBuilder.js';
import { StringListEditor } from '../components/StringListEditor.js';
import { StructuredValueEditor, jsonObjectFromUnknown, toJsonValue } from '../components/StructuredValueEditor.js';

type ToolAdapter = ToolManifest['adapter'];
type HttpReadonlyAdapter = Extract<ToolAdapter, { type: 'http_readonly' }>;

const httpRetryDefaults = { max_attempts: 2, retryable_status_codes: [408, 429, 500, 502, 503, 504], backoff_ms: 100 };
const authOptions = [
  { value: 'none', label: '无认证' },
  { value: 'bearer_env', label: 'Bearer 环境变量引用' },
  { value: 'api_key_env', label: 'API Key 环境变量引用' },
] satisfies Array<{ value: 'none' | 'bearer_env' | 'api_key_env'; label: string }>;
const safeHeaderOptions = ['Authorization', 'X-API-Key', 'X-Api-Key', 'Api-Key', 'X-Auth-Token'].map((value) => ({ value, label: value }));

export function ToolVisualEditor({ value, readOnly, onChange }: VisualEditorProps<ToolManifest>) {
  const { t } = useTranslation();
  const adapter = value.adapter;
  const evaluationPolicy = value.evaluation_policy ?? {
    allowed_in_evaluation: false,
    mode: 'deny',
    allowed_tenants: [],
    result_redaction_policy: 'mask_sensitive',
  };
  const isHttpReadonly = adapter.type === 'http_readonly';

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {(value.risk_level === 'L3' || value.risk_level === 'L4') ? <Alert type="warning" showIcon message={t('visualConfig.tool.highRisk')} /> : null}
      {value.side_effect ? <Alert type="info" showIcon message={t('visualConfig.tool.sideEffectNotice')} /> : null}
      {isHttpReadonly ? <Alert type="info" showIcon message={t('visualConfig.tool.httpAllowlistNotice')} /> : null}
      <Form layout="vertical">
        <Form.Item label={t('visualConfig.tool.name')}><Input data-testid="vc-tool-name" value={value.tool_name} disabled={readOnly} onChange={(event) => onChange({ ...value, tool_name: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.common.version')}><Input value={value.version} disabled={readOnly} onChange={(event) => onChange({ ...value, version: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.description')}><Input.TextArea value={value.description ?? ''} disabled={readOnly} autoSize onChange={(event) => onChange({ ...value, description: event.target.value || undefined })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.risk')}><Select data-testid="vc-tool-risk-level" value={value.risk_level} disabled={readOnly} options={(isHttpReadonly ? ['L0', 'L1'] : ['L0', 'L1', 'L2', 'L3', 'L4']).map((item) => ({ value: item, label: item }))} onChange={(risk_level) => onChange({ ...value, risk_level })} /></Form.Item>
        <Checkbox data-testid="vc-tool-side-effect" checked={Boolean(value.side_effect)} disabled={readOnly || isHttpReadonly} onChange={(event) => onChange({ ...value, side_effect: event.target.checked })}>{t('visualConfig.tool.sideEffect')}</Checkbox>
        <Form.Item label={t('visualConfig.tool.permissions')}><StringListEditor value={value.required_permissions ?? []} readOnly={readOnly} onChange={(required_permissions) => onChange({ ...value, required_permissions })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.adapterType')}><Select value={adapter.type} disabled={readOnly} options={[{ value: 'mock', label: 'Mock' }, { value: 'http_readonly', label: '只读 HTTP' }]} onChange={(type) => onChange(withAdapterType(value, type))} /></Form.Item>
        {adapter.type === 'mock' ? <MockAdapterFields value={value} readOnly={readOnly} onChange={onChange} /> : <HttpReadonlyFields value={value} adapter={adapter} readOnly={readOnly} onChange={onChange} />}
        <Form.Item label={t('visualConfig.tool.inputSchema')}><JsonSchemaBuilder value={jsonObjectFromUnknown(value.input_schema ?? { type: 'object' })} readOnly={readOnly} onChange={(input_schema) => onChange({ ...value, input_schema })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.outputSchema')}><JsonSchemaBuilder value={jsonObjectFromUnknown(value.output_schema ?? { type: 'object' })} readOnly={readOnly} onChange={(output_schema) => onChange({ ...value, output_schema })} /></Form.Item>
        <Checkbox checked={Boolean(evaluationPolicy.allowed_in_evaluation)} disabled={readOnly} onChange={(event) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, allowed_in_evaluation: event.target.checked } })}>{t('visualConfig.tool.evaluationAllowed')}</Checkbox>
        <Form.Item label={t('visualConfig.tool.evaluationMode')}><Select value={evaluationPolicy.mode} disabled={readOnly} options={(isHttpReadonly ? ['deny', 'preview_only'] : ['deny', 'preview_only', 'sandbox_commit']).map((item) => ({ value: item, label: item }))} onChange={(mode) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, mode } })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.allowedTenants')}><StringListEditor value={evaluationPolicy.allowed_tenants ?? []} readOnly={readOnly} onChange={(allowed_tenants) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, allowed_tenants } })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.redaction')}><Select value={evaluationPolicy.result_redaction_policy} disabled={readOnly} options={['none', 'mask_sensitive', 'summary_only'].map((item) => ({ value: item, label: item }))} onChange={(result_redaction_policy) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, result_redaction_policy } })} /></Form.Item>
        <Form.Item label={t('visualConfig.tool.maxCalls')}><InputNumber min={1} value={evaluationPolicy.maximum_calls_per_case ?? null} disabled={readOnly} onChange={(maximum_calls_per_case) => onChange({ ...value, evaluation_policy: { ...evaluationPolicy, maximum_calls_per_case: typeof maximum_calls_per_case === 'number' ? maximum_calls_per_case : undefined } })} /></Form.Item>
      </Form>
    </Space>
  );
}

function MockAdapterFields({ value, readOnly, onChange }: VisualEditorProps<ToolManifest>) {
  const { t } = useTranslation();
  const adapter = value.adapter.type === 'mock' ? value.adapter : { type: 'mock' as const, config: {} };
  return (
    <>
      <Form.Item label="endpoint_ref"><Input data-testid="vc-tool-endpoint-ref" value={adapter.endpoint_ref ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...value, adapter: { ...adapter, endpoint_ref: event.target.value || undefined } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.adapterConfig')}><StructuredValueEditor value={toJsonValue(adapter.config ?? {})} readOnly={readOnly} onChange={(config) => onChange({ ...value, adapter: { ...adapter, config: jsonObjectFromUnknown(config) } })} /></Form.Item>
    </>
  );
}

function HttpReadonlyFields({ value, adapter, readOnly, onChange }: VisualEditorProps<ToolManifest> & { adapter: HttpReadonlyAdapter }) {
  const { t } = useTranslation();
  const auth = adapter.auth ?? { type: 'none' as const };
  return (
    <>
      <Form.Item label={t('visualConfig.tool.httpBaseUrl')}><Input value={adapter.base_url} disabled={readOnly} onChange={(event) => onChange({ ...value, adapter: { ...adapter, base_url: event.target.value } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.httpPath')}><Input value={adapter.path} disabled={readOnly} onChange={(event) => onChange({ ...value, adapter: { ...adapter, path: event.target.value } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.httpQueryMapping')}><StructuredValueEditor value={toJsonValue(adapter.query_mapping ?? {})} readOnly={readOnly} onChange={(query_mapping) => onChange({ ...value, adapter: { ...adapter, query_mapping: stringRecordFromUnknown(query_mapping) } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.httpStaticQuery')}><StructuredValueEditor value={toJsonValue(adapter.static_query ?? {})} readOnly={readOnly} onChange={(static_query) => onChange({ ...value, adapter: { ...adapter, static_query: jsonObjectFromUnknown(static_query) as HttpReadonlyAdapter['static_query'] } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.httpAuthType')}><Select value={auth.type} disabled={readOnly} options={authOptions} onChange={(type) => onChange({ ...value, adapter: { ...adapter, auth: authForType(type) } })} /></Form.Item>
      {auth.type !== 'none' ? <Form.Item label={t('visualConfig.tool.httpSecretRef')}><Input value={auth.secret_ref} disabled={readOnly} placeholder="env:TOOL_SECRET_POLICY_API" onChange={(event) => onChange({ ...value, adapter: { ...adapter, auth: { ...auth, secret_ref: event.target.value } } })} /></Form.Item> : null}
      {auth.type === 'api_key_env' ? <Form.Item label={t('visualConfig.tool.httpApiKeyHeader')}><Select value={auth.header_name} disabled={readOnly} options={safeHeaderOptions} onChange={(header_name) => onChange({ ...value, adapter: { ...adapter, auth: { ...auth, header_name } } })} /></Form.Item> : null}
      <Form.Item label={t('visualConfig.tool.httpTimeout')}><InputNumber min={1} max={15000} value={adapter.timeout_ms} disabled={readOnly} onChange={(timeout_ms) => onChange({ ...value, adapter: { ...adapter, timeout_ms: typeof timeout_ms === 'number' ? timeout_ms : 5000 } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.httpMaxBytes')}><InputNumber min={1} max={1048576} value={adapter.max_response_bytes} disabled={readOnly} onChange={(max_response_bytes) => onChange({ ...value, adapter: { ...adapter, max_response_bytes: typeof max_response_bytes === 'number' ? max_response_bytes : 65536 } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.httpRetryAttempts')}><InputNumber min={1} max={5} value={adapter.retry.max_attempts} disabled={readOnly} onChange={(max_attempts) => onChange({ ...value, adapter: { ...adapter, retry: { ...adapter.retry, max_attempts: typeof max_attempts === 'number' ? max_attempts : 1 } } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.httpRetryCodes')}><StringListEditor value={(adapter.retry.retryable_status_codes ?? []).map(String)} readOnly={readOnly} onChange={(items) => onChange({ ...value, adapter: { ...adapter, retry: { ...adapter.retry, retryable_status_codes: items.map(Number).filter(Number.isFinite) } } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.httpResponseBodyPath')}><Input value={adapter.response_body_path ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...value, adapter: { ...adapter, response_body_path: event.target.value || undefined } })} /></Form.Item>
      <Form.Item label={t('visualConfig.tool.httpHeaderAllowlist')}><Select mode="multiple" value={adapter.response_headers_allowlist ?? []} disabled={readOnly} options={safeHeaderOptions} onChange={(response_headers_allowlist) => onChange({ ...value, adapter: { ...adapter, response_headers_allowlist } })} /></Form.Item>
    </>
  );
}

function withAdapterType(value: ToolManifest, type: ToolAdapter['type']): ToolManifest {
  if (type === 'http_readonly') {
    return {
      ...value,
      risk_level: value.risk_level === 'L0' ? 'L0' : 'L1',
      side_effect: false,
      adapter: defaultHttpReadonlyAdapter(),
      evaluation_policy: {
        ...(value.evaluation_policy ?? { allowed_in_evaluation: false, mode: 'deny', allowed_tenants: [], result_redaction_policy: 'mask_sensitive' }),
        mode: value.evaluation_policy?.mode === 'sandbox_commit' ? 'deny' : value.evaluation_policy?.mode ?? 'deny',
      },
    };
  }
  return { ...value, adapter: { type: 'mock', config: {} } };
}

function defaultHttpReadonlyAdapter(): HttpReadonlyAdapter {
  return {
    type: 'http_readonly',
    base_url: 'https://api.example.com',
    path: '/v1/resource',
    query_mapping: {},
    auth: { type: 'none' },
    timeout_ms: 5000,
    max_response_bytes: 65536,
    retry: httpRetryDefaults,
    response_headers_allowlist: [],
  };
}

function authForType(type: 'none' | 'bearer_env' | 'api_key_env'): HttpReadonlyAdapter['auth'] {
  if (type === 'bearer_env') {
    return { type, secret_ref: 'env:TOOL_SECRET_POLICY_API' };
  }
  if (type === 'api_key_env') {
    return { type, secret_ref: 'env:TOOL_SECRET_POLICY_API', header_name: 'X-API-Key' };
  }
  return { type: 'none' };
}

function stringRecordFromUnknown(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(jsonObjectFromUnknown(value))
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
