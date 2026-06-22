import type { EvaluationDataset } from '@dar/contracts';
import { Form, Input, InputNumber, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import type { VisualEditorProps } from '../types.js';
import { StringListEditor } from '../components/StringListEditor.js';

export function EvaluationDatasetVisualEditor({ value, readOnly, onChange }: VisualEditorProps<EvaluationDataset>) {
  const { t } = useTranslation();
  return (
    <Form layout="vertical">
      <Form.Item label="dataset_id"><Input data-testid="vc-dataset-id" value={value.dataset_id} disabled={readOnly} onChange={(event) => onChange({ ...value, dataset_id: event.target.value })} /></Form.Item>
      <Form.Item label={t('visualConfig.common.version')}><InputNumber min={1} value={value.version} disabled={readOnly} onChange={(next) => onChange({ ...value, version: typeof next === 'number' ? next : value.version })} /></Form.Item>
      <Form.Item label={t('visualConfig.dataset.name')}><Input data-testid="vc-dataset-name" value={value.name} disabled={readOnly} onChange={(event) => onChange({ ...value, name: event.target.value })} /></Form.Item>
      <Form.Item label={t('visualConfig.dataset.description')}><Input.TextArea value={value.description ?? ''} disabled={readOnly} autoSize onChange={(event) => onChange({ ...value, description: event.target.value || undefined })} /></Form.Item>
      <Form.Item label={t('visualConfig.dataset.domain')}><Input value={value.domain ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...value, domain: event.target.value || undefined })} /></Form.Item>
      <Form.Item label={t('visualConfig.dataset.tags')}><StringListEditor value={value.tags ?? []} readOnly={readOnly} onChange={(tags) => onChange({ ...value, tags })} /></Form.Item>
      <Form.Item label={t('visualConfig.dataset.defaultWeight')}><InputNumber min={0.01} value={value.default_weight} disabled={readOnly} onChange={(next) => onChange({ ...value, default_weight: typeof next === 'number' ? next : value.default_weight })} /></Form.Item>
      <Form.Item label="status"><Select value={value.status} disabled options={['draft', 'validated', 'published', 'deprecated', 'disabled'].map((item) => ({ value: item, label: item }))} /></Form.Item>
    </Form>
  );
}
