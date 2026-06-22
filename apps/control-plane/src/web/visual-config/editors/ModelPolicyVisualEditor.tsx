import type { ModelDefinition, ModelPolicy } from '@dar/contracts';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Form, Input, InputNumber, Select, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApiClient } from '../../api/use-api-client.js';
import type { VisualEditorProps } from '../types.js';
import { StringListEditor } from '../components/StringListEditor.js';

type Target = ModelPolicy['targets'][number];
interface ListResponse<T> {
  items: T[];
}

export function ModelPolicyVisualEditor({ value, readOnly, onChange }: VisualEditorProps<ModelPolicy>) {
  const { t } = useTranslation();
  const apiClient = useApiClient();
  const [modelSearch, setModelSearch] = useState('');
  const modelsQuery = useQuery({
    queryKey: ['model-catalog', 'published-models'],
    queryFn: () => apiClient.request<ListResponse<ModelDefinition>>('/api/v1/models', {
      query: { status: 'published', page_size: 100 },
    }),
  });
  const selectedModelId = value.targets[0]?.model_ref.model_id;
  const searchedModelId = useMemo(() => parseModelSearchId(modelSearch), [modelSearch]);
  const selectedModelQuery = useQuery({
    queryKey: ['model-catalog', 'published-model', selectedModelId],
    enabled: Boolean(selectedModelId) && selectedModelId !== 'model-id',
    queryFn: () => apiClient.request<ListResponse<ModelDefinition>>('/api/v1/models', {
      query: { model_id: selectedModelId, status: 'published', page_size: 100 },
    }),
  });
  const searchedModelQuery = useQuery({
    queryKey: ['model-catalog', 'searched-model', searchedModelId],
    enabled: Boolean(searchedModelId),
    queryFn: () => apiClient.request<ListResponse<ModelDefinition>>('/api/v1/models', {
      query: { model_id: searchedModelId, status: 'published', page_size: 100 },
    }),
  });
  const models = mergeModels(
    modelsQuery.data?.items ?? [],
    selectedModelQuery.data?.items ?? [],
    searchedModelQuery.data?.items ?? [],
  );
  const modelOptions = models.map((model) => ({
    value: modelKey(model.model_id, model.version, model.model_hash),
    label: `${model.display_name} (${model.model_id}@${model.version})`,
    model,
  }));
  const columns: ColumnsType<Target> = [
    { title: 'target_id', dataIndex: 'target_id', key: 'target_id' },
    {
      title: 'model_ref',
      key: 'model_ref',
      render: (_, row) => `${row.model_ref.model_id}@${row.model_ref.version}`,
    },
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
        <Form.Item label={t('visualConfig.modelPolicy.protocol')}><Select value={value.protocol} disabled={readOnly} options={['openai_chat_completions'].map((item) => ({ value: item, label: item }))} onChange={(protocol) => onChange({ ...value, protocol })} /></Form.Item>
      </Form>
      <Table size="small" rowKey="target_id" dataSource={value.targets} columns={columns} pagination={false} />
      <TargetEditor
        readOnly={readOnly}
        modelOptions={modelOptions}
        value={value.targets[0] ?? defaultTarget()}
        onSearchModel={setModelSearch}
        onAdd={(target) => onChange({ ...value, targets: upsertTarget(value.targets, target) })}
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

function TargetEditor({
  value,
  readOnly,
  modelOptions,
  onSearchModel,
  onAdd,
}: {
  value: Target;
  readOnly: boolean;
  modelOptions: Array<{ value: string; label: string; model: ModelDefinition }>;
  onSearchModel(value: string): void;
  onAdd(value: Target): void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Target>(value);
  const selectedModelKey = useMemo(
    () => modelKey(draft.model_ref.model_id, draft.model_ref.version, draft.model_ref.model_hash),
    [draft.model_ref.model_hash, draft.model_ref.model_id, draft.model_ref.version],
  );

  useEffect(() => {
    setDraft(value);
  }, [value.enabled, value.model_ref.model_hash, value.model_ref.model_id, value.model_ref.version, value.priority, value.target_id]);

  return (
    <Space wrap>
      <Input data-testid="vc-model-target-id" placeholder="target_id" value={draft.target_id} disabled={readOnly} onChange={(event) => setDraft({ ...draft, target_id: event.target.value })} />
      <Select
        data-testid="vc-model-target-model-ref"
        placeholder="model_ref"
        style={{ minWidth: 280 }}
        showSearch
        filterOption={false}
        value={selectedModelKey}
        disabled={readOnly}
        options={modelOptions}
        onSearch={onSearchModel}
        onChange={(selected) => {
          const option = modelOptions.find((item) => item.value === selected);
          if (option) {
            setDraft({
              ...draft,
              model_ref: {
                model_id: option.model.model_id,
                version: option.model.version,
                model_hash: option.model.model_hash,
              },
            });
          }
        }}
      />
      <InputNumber placeholder="priority" min={0} value={draft.priority} disabled={readOnly} onChange={(value) => setDraft({ ...draft, priority: typeof value === 'number' ? value : 0 })} />
      <Button data-testid="vc-model-target-add" disabled={readOnly || !draft.target_id} onClick={() => onAdd(draft)}>{t('visualConfig.actions.add')}</Button>
    </Space>
  );
}

function defaultTarget(): Target {
  return {
    target_id: 'primary',
    model_ref: {
      model_id: 'model-id',
      version: 1,
      model_hash: '0'.repeat(64),
    },
    priority: 0,
    enabled: true,
  };
}

function modelKey(modelId: string, version: number, modelHash: string): string {
  return `${modelId}@${version}:${modelHash}`;
}

function parseModelSearchId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/:[a-f0-9]{64}$/u, '')
    .replace(/@\d+$/u, '');
}

function mergeModels(...groups: ModelDefinition[][]): ModelDefinition[] {
  const byKey = new Map<string, ModelDefinition>();
  for (const model of groups.flat()) {
    byKey.set(modelKey(model.model_id, model.version, model.model_hash), model);
  }
  return [...byKey.values()];
}

function upsertTarget(targets: Target[], target: Target): Target[] {
  const index = targets.findIndex((item) => item.target_id === target.target_id);
  if (index >= 0) {
    return targets.map((item, itemIndex) => (itemIndex === index ? target : item));
  }
  if (targets.length === 1 && isPlaceholderTarget(targets[0])) {
    return [target];
  }
  return [...targets, target];
}

function isPlaceholderTarget(target: Target | undefined): boolean {
  return target?.model_ref.model_hash === '0'.repeat(64);
}

function move<T>(values: T[], from: number, to: number): T[] {
  const next = [...values];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to, 0, item);
  }
  return next;
}
