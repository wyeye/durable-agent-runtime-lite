import type { RouteSpec } from '@dar/contracts';
import type { ApiClient } from '../../api/client.js';
import { Alert, Form, Input, InputNumber, Select, Slider, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import { displayRole } from '../../utils/i18n-labels.js';
import type { VisualEditorProps } from '../types.js';
import { ExactVersionSelect } from '../components/ExactVersionSelect.js';
import { StringListEditor } from '../components/StringListEditor.js';

const channelOptions = [
  { value: 'web', label: 'Web' },
  { value: 'api', label: 'API' },
  { value: 'chat', label: 'Chat' },
  { value: 'control-plane', label: 'Control Plane' },
  { value: 'admin-console', label: 'Admin Console' },
];

const commonRoleOptions = [
  'platform_admin',
  'capability_operator',
  'auditor',
  'operator',
  'employee',
  'finance_admin',
].map((value) => ({
  value,
  label: displayRole(value),
}));

export function RouteVisualEditor({
  value,
  readOnly,
  onChange,
  client,
}: VisualEditorProps<RouteSpec> & { client: ApiClient }) {
  const { t } = useTranslation();
  const route = value.route;
  const channelSelectOptions = uniqueOptions([
    ...channelOptions,
    ...route.supported_channels.map((value) => ({ value, label: value })),
  ]);
  const roleOptions = uniqueOptions([
    ...commonRoleOptions,
    ...route.role_constraints.map((value) => ({
      value,
      label: displayRole(value),
    })),
  ]);
  const fallbackAgentRef = parseVersionRef(route.fallback_agent_ref);
  const fallbackAgentValue = fallbackAgentRef
    ? { resource_id: fallbackAgentRef.id, version: fallbackAgentRef.version }
    : undefined;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form layout="vertical">
        <Form.Item label={t('visualConfig.route.routeId')}>
          <Input data-testid="vc-route-id" value={value.route_id ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...value, route_id: event.target.value || undefined })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.route.flowRef')}>
          <ExactVersionSelect
            client={client}
            resourceType="flow"
            testId="vc-route-flow-ref"
            readOnly={readOnly}
            value={{ resource_id: value.flow_id, version: value.version }}
            onChange={(next) => {
              if (next && typeof next.version === 'number') {
                onChange({ ...value, flow_id: next.resource_id, version: next.version });
              }
            }}
          />
        </Form.Item>
        <Form.Item label={t('visualConfig.route.priority')}>
          <Slider min={0} max={100} value={route.priority} disabled={readOnly} onChange={(priority) => onChange({ ...value, route: { ...route, priority } })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.route.confidence')}>
          <InputNumber min={0} max={1} step={0.01} value={route.confidence_threshold} disabled={readOnly} onChange={(next) => onChange({ ...value, route: { ...route, confidence_threshold: typeof next === 'number' ? next : route.confidence_threshold } })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.route.ambiguous')}>
          <InputNumber min={0} max={1} step={0.01} value={route.ambiguous_threshold} disabled={readOnly} onChange={(next) => onChange({ ...value, route: { ...route, ambiguous_threshold: typeof next === 'number' ? next : route.ambiguous_threshold } })} />
        </Form.Item>
        {route.confidence_threshold < route.ambiguous_threshold ? <Alert type="error" showIcon message={t('visualConfig.route.thresholdInvalid')} /> : null}
        <Form.Item label={t('visualConfig.route.keywords')}>
          <StringListEditor testId="vc-route-keywords-input" value={route.keywords} readOnly={readOnly} onChange={(keywords) => onChange({ ...value, route: { ...route, keywords } })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.route.examples')}>
          <StringListEditor testId="vc-route-examples-input" value={route.examples} readOnly={readOnly} onChange={(examples) => onChange({ ...value, route: { ...route, examples } })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.route.negativeExamples')}>
          <StringListEditor value={route.negative_examples} readOnly={readOnly} onChange={(negative_examples) => onChange({ ...value, route: { ...route, negative_examples } })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.route.channels')}>
          <Select
            mode="multiple"
            data-testid="vc-route-channels-input"
            value={route.supported_channels}
            disabled={readOnly}
            showSearch={false}
            options={channelSelectOptions}
            placeholder="选择适用渠道"
            onChange={(supported_channels) => onChange({ ...value, route: { ...route, supported_channels } })}
          />
        </Form.Item>
        <Form.Item label={t('visualConfig.route.roles')}>
          <Select
            mode="multiple"
            data-testid="vc-route-roles-select"
            value={route.role_constraints}
            disabled={readOnly}
            showSearch={false}
            options={roleOptions}
            placeholder="选择适用角色"
            onChange={(role_constraints) => onChange({ ...value, route: { ...route, role_constraints } })}
          />
        </Form.Item>
        <Form.Item label={t('visualConfig.route.fallbackAgentRef')}>
          <ExactVersionSelect
            client={client}
            resourceType="agent"
            status="published"
            testId="vc-route-fallback-agent-ref"
            readOnly={readOnly}
            {...(fallbackAgentValue ? { value: fallbackAgentValue } : {})}
            onChange={(next) => onChange({
              ...value,
              route: {
                ...route,
                fallback_agent_ref: next ? `${next.resource_id}@${next.version}` : undefined,
              },
            })}
          />
        </Form.Item>
        <Alert type="info" showIcon message={t('visualConfig.route.exactFallbackNotice')} />
      </Form>
    </Space>
  );
}

function parseVersionRef(value: string | undefined): { id: string; version: number } | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(.+)@([1-9]\d*)$/u.exec(value);
  return match ? { id: match[1] ?? '', version: Number(match[2]) } : undefined;
}

function uniqueOptions(options: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.value)) {
      return false;
    }
    seen.add(option.value);
    return true;
  });
}
