import type { AgentSpec } from '@dar/contracts';
import type { ApiClient } from '../../api/client.js';
import { Alert, Form, Input, InputNumber, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import type { VisualEditorProps } from '../types.js';
import { ExactVersionSelect } from '../components/ExactVersionSelect.js';
import { StringListEditor } from '../components/StringListEditor.js';

export function AgentVisualEditor({
  value,
  readOnly,
  onChange,
  client,
}: VisualEditorProps<AgentSpec> & { client: ApiClient }) {
  const { t } = useTranslation();
  const promptRef = parseVersionRef(value.prompt_ref);
  const promptValue = promptRef ? { resource_id: promptRef.id, version: promptRef.version } : undefined;
  const modelPolicyValue = value.model_policy_ref
    ? {
        resource_id: value.model_policy_ref.model_policy_id,
        version: value.model_policy_ref.model_policy_version,
        ...(value.model_policy_ref.model_policy_hash ? { sha256: value.model_policy_ref.model_policy_hash } : {}),
      }
    : undefined;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form layout="vertical">
        <Form.Item label={t('visualConfig.agent.agentId')}><Input data-testid="vc-agent-id" value={value.agent_id} disabled={readOnly} onChange={(event) => onChange({ ...value, agent_id: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.common.version')}><InputNumber min={1} value={value.version} disabled={readOnly} onChange={(next) => onChange({ ...value, version: typeof next === 'number' ? next : value.version })} /></Form.Item>
        <Form.Item label={t('visualConfig.agent.promptRef')}>
          <ExactVersionSelect
            client={client}
            resourceType="prompt"
            status="published"
            testId="vc-agent-prompt-ref"
            readOnly={readOnly}
            {...(promptValue ? { value: promptValue } : {})}
            onChange={(next) => {
              if (next) {
                onChange({ ...value, prompt_ref: `${next.resource_id}@${next.version}` });
              }
            }}
          />
        </Form.Item>
        <Form.Item label={t('visualConfig.agent.modelPolicyRef')}>
          <ExactVersionSelect
            client={client}
            resourceType="model_policy"
            status="published"
            includeHash
            testId="vc-agent-model-policy-ref"
            readOnly={readOnly}
            {...(modelPolicyValue ? { value: modelPolicyValue } : {})}
            onChange={(next) => {
              if (next && typeof next.version === 'number') {
                onChange({
                  ...value,
                  model_policy: `${next.resource_id}@${next.version}`,
                  model_policy_ref: {
                    model_policy_id: next.resource_id,
                    model_policy_version: next.version,
                    model_policy_hash: next.sha256,
                  },
                });
              }
            }}
          />
        </Form.Item>
        <Form.Item label={t('visualConfig.agent.allowedTools')}>
          <StringListEditor testId="vc-agent-allowed-tools-input" value={value.allowed_tools} readOnly={readOnly} onChange={(allowed_tools) => onChange({ ...value, allowed_tools })} placeholder="tool_name@1.0.0" />
        </Form.Item>
        <Form.Item label={t('visualConfig.agent.allowedHandoffs')}>
          <StringListEditor testId="vc-agent-allowed-handoffs-input" value={value.allowed_handoffs ?? []} readOnly={readOnly} onChange={(allowed_handoffs) => onChange({ ...value, allowed_handoffs })} placeholder="flow_id@1" />
        </Form.Item>
        <Form.Item label={t('visualConfig.agent.maxSteps')}><InputNumber min={1} value={value.max_steps} disabled={readOnly} onChange={(next) => onChange({ ...value, max_steps: typeof next === 'number' ? next : value.max_steps })} /></Form.Item>
        <Form.Item label={t('visualConfig.agent.maxTokens')}><InputNumber min={1} value={value.max_tokens} disabled={readOnly} onChange={(next) => onChange({ ...value, max_tokens: typeof next === 'number' ? next : value.max_tokens })} /></Form.Item>
        <Form.Item label={t('visualConfig.agent.outputSchema')}><Input value={value.output_schema ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...value, output_schema: event.target.value || undefined })} /></Form.Item>
      </Form>
      <Alert type="info" showIcon message={t('visualConfig.agent.exactRefNotice')} />
    </Space>
  );
}

function parseVersionRef(value: string): { id: string; version: number } | undefined {
  const match = /^(.+)@([1-9]\d*)$/u.exec(value);
  return match ? { id: match[1] ?? '', version: Number(match[2]) } : undefined;
}
