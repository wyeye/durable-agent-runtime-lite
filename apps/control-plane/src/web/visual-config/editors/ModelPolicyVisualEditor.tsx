import type { ModelPolicy } from '@dar/contracts';
import { Alert, Button, Checkbox, Form, Input, InputNumber, Select, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import type { VisualEditorProps } from '../types.js';
import { StringListEditor } from '../components/StringListEditor.js';

type Target = ModelPolicy['targets'][number];

export function ModelPolicyVisualEditor({ value, readOnly, onChange }: VisualEditorProps<ModelPolicy>) {
  const { t } = useTranslation();
  const columns: ColumnsType<Target> = [
    { title: 'target_id', dataIndex: 'target_id', key: 'target_id' },
    { title: 'model_id', dataIndex: 'model_id', key: 'model_id' },
    { title: 'priority', dataIndex: 'priority', key: 'priority' },
    { title: 'enabled', dataIndex: 'enabled', key: 'enabled', render: String },
    {
      title: t('visualConfig.actions.actions'),
      key: 'actions',
      render: (_, row, index) => (
        <Space>
          <Button size="small" disabled={readOnly || index === 0} onClick={() => onChange({ ...value, targets: move(value.targets, index, index - 1) })}>↑</Button>
          <Button size="small" disabled={readOnly || index === value.targets.length - 1} onClick={() => onChange({ ...value, targets: move(value.targets, index, index + 1) })}>↓</Button>
          <Button size="small" danger disabled={readOnly || value.fallback_policy.ordered_target_ids.includes(row.target_id)} onClick={() => onChange({ ...value, targets: value.targets.filter((_, itemIndex) => itemIndex !== index) })}>×</Button>
        </Space>
      ),
    },
  ];
  const activeTargetIds = value.targets.map((target) => target.target_id);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form layout="vertical">
        <Form.Item label={t('visualConfig.modelPolicy.id')}><Input data-testid="vc-model-policy-id" value={value.model_policy_id} disabled={readOnly} onChange={(event) => onChange({ ...value, model_policy_id: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.common.version')}><InputNumber min={1} value={value.version} disabled={readOnly} onChange={(next) => onChange({ ...value, version: typeof next === 'number' ? next : value.version })} /></Form.Item>
        <Form.Item label={t('visualConfig.modelPolicy.protocol')}><Select value={value.protocol} disabled={readOnly} options={['dar_generate', 'openai_chat_completions'].map((item) => ({ value: item, label: item }))} onChange={(protocol) => onChange({ ...value, protocol })} /></Form.Item>
      </Form>
      <Table size="small" rowKey="target_id" dataSource={value.targets} columns={columns} pagination={false} />
      <TargetEditor
        readOnly={readOnly}
        value={value.targets[0] ?? defaultTarget()}
        onAdd={(target) => onChange({ ...value, targets: dedupeTargets([...value.targets, target]) })}
      />
      <Alert type="info" showIcon message={t('visualConfig.modelPolicy.noSecrets')} />
      <Form layout="vertical">
        <Form.Item label={t('visualConfig.modelPolicy.retryCodes')}>
          <StringListEditor
            value={value.retry_policy.retryable_status_codes.map(String)}
            readOnly={readOnly}
            onChange={(codes) => onChange({ ...value, retry_policy: { ...value.retry_policy, retryable_status_codes: codes.map(Number).filter(Number.isFinite) } })}
          />
        </Form.Item>
        <Form.Item label={t('visualConfig.modelPolicy.maxAttempts')}><InputNumber min={1} max={10} value={value.retry_policy.max_attempts_per_target} disabled={readOnly} onChange={(next) => onChange({ ...value, retry_policy: { ...value.retry_policy, max_attempts_per_target: typeof next === 'number' ? next : value.retry_policy.max_attempts_per_target } })} /></Form.Item>
        <Checkbox checked={value.fallback_policy.enabled} disabled={readOnly} onChange={(event) => onChange({ ...value, fallback_policy: { ...value.fallback_policy, enabled: event.target.checked } })}>{t('visualConfig.modelPolicy.fallbackEnabled')}</Checkbox>
        <Form.Item label={t('visualConfig.modelPolicy.fallbackTargets')}>
          <Select
            mode="multiple"
            value={value.fallback_policy.ordered_target_ids}
            disabled={readOnly}
            options={activeTargetIds.map((targetId) => ({ value: targetId, label: targetId }))}
            onChange={(ordered_target_ids) => onChange({ ...value, fallback_policy: { ...value.fallback_policy, ordered_target_ids } })}
          />
        </Form.Item>
        <Form.Item label="temperature"><InputNumber min={0} max={2} step={0.1} value={value.request_policy.temperature} disabled={readOnly} onChange={(temperature) => onChange({ ...value, request_policy: { ...value.request_policy, temperature: typeof temperature === 'number' ? temperature : value.request_policy.temperature } })} /></Form.Item>
        <Form.Item label="top_p"><InputNumber min={0} max={1} step={0.01} value={value.request_policy.top_p} disabled={readOnly} onChange={(top_p) => onChange({ ...value, request_policy: { ...value.request_policy, top_p: typeof top_p === 'number' ? top_p : value.request_policy.top_p } })} /></Form.Item>
        <Form.Item label="max_output_tokens"><InputNumber min={1} value={value.request_policy.max_output_tokens} disabled={readOnly} onChange={(max_output_tokens) => onChange({ ...value, request_policy: { ...value.request_policy, max_output_tokens: typeof max_output_tokens === 'number' ? max_output_tokens : value.request_policy.max_output_tokens } })} /></Form.Item>
      </Form>
    </Space>
  );
}

function TargetEditor({ value, readOnly, onAdd }: { value: Target; readOnly: boolean; onAdd(value: Target): void }) {
  const { t } = useTranslation();
  const next = { ...value };
  return (
    <Space wrap>
      <Input data-testid="vc-model-target-id" placeholder="target_id" defaultValue={next.target_id} disabled={readOnly} onChange={(event) => { next.target_id = event.target.value; }} />
      <Input data-testid="vc-model-target-gateway-profile" placeholder="gateway_profile" defaultValue={next.gateway_profile} disabled={readOnly} onChange={(event) => { next.gateway_profile = event.target.value; }} />
      <Input data-testid="vc-model-target-model-id" placeholder="model_id" defaultValue={next.model_id} disabled={readOnly} onChange={(event) => { next.model_id = event.target.value; }} />
      <InputNumber placeholder="priority" min={0} defaultValue={next.priority} disabled={readOnly} onChange={(value) => { next.priority = typeof value === 'number' ? value : 0; }} />
      <Button data-testid="vc-model-target-add" disabled={readOnly} onClick={() => onAdd({ ...next, capabilities: next.capabilities?.length ? next.capabilities : ['text'] })}>{t('visualConfig.actions.add')}</Button>
    </Space>
  );
}

function defaultTarget(): Target {
  return {
    target_id: 'primary',
    gateway_profile: 'openai-compatible',
    model_id: 'model-id',
    priority: 0,
    enabled: true,
    capabilities: ['text'],
  };
}

function dedupeTargets(targets: Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.target_id)) {
      return false;
    }
    seen.add(target.target_id);
    return true;
  });
}

function move<T>(values: T[], from: number, to: number): T[] {
  const next = [...values];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to, 0, item);
  }
  return next;
}
