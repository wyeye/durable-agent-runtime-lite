import type { PromptDefinition } from '@dar/contracts';
import { Alert, Descriptions, Form, Input, InputNumber, Space, Typography } from 'antd';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { VisualEditorProps } from '../types.js';
import { StringListEditor } from '../components/StringListEditor.js';

export function PromptVisualEditor({ value, readOnly, onChange }: VisualEditorProps<PromptDefinition>) {
  const { t } = useTranslation();
  const detected = useMemo(() => detectVariables(value.content), [value.content]);
  const declared = value.variables ?? [];
  const undeclared = detected.filter((item) => !declared.includes(item));
  const unused = declared.filter((item) => !detected.includes(item));

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Form layout="vertical">
        <Form.Item label={t('visualConfig.prompt.promptId')}>
          <Input data-testid="vc-prompt-id" value={value.prompt_id} disabled={readOnly} onChange={(event) => onChange({ ...value, prompt_id: event.target.value })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.common.version')}>
          <InputNumber data-testid="vc-prompt-version" min={1} value={value.version} disabled={readOnly} onChange={(next) => onChange({ ...value, version: typeof next === 'number' ? next : value.version })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.prompt.name')}>
          <Input value={value.name} disabled={readOnly} onChange={(event) => onChange({ ...value, name: event.target.value })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.prompt.content')}>
          <Input.TextArea
            data-testid="vc-prompt-content"
            value={value.content}
            disabled={readOnly}
            autoSize={{ minRows: 8, maxRows: 24 }}
            onChange={(event) => onChange({ ...value, content: event.target.value })}
          />
        </Form.Item>
        <Form.Item label={t('visualConfig.prompt.variables')}>
          <StringListEditor testId="vc-prompt-variables-input" value={declared} readOnly={readOnly} onChange={(variables) => onChange({ ...value, variables })} fieldPath="variables" />
        </Form.Item>
      </Form>
      <Descriptions size="small" bordered column={{ xs: 1, md: 3 }}>
        <Descriptions.Item label={t('visualConfig.prompt.detectedVariables')}>{detected.join(', ') || '-'}</Descriptions.Item>
        <Descriptions.Item label={t('visualConfig.prompt.characterCount')}>{value.content.length}</Descriptions.Item>
        <Descriptions.Item label={t('visualConfig.prompt.preview')}>{value.content.slice(0, 120) || '-'}</Descriptions.Item>
      </Descriptions>
      {undeclared.length ? <Alert type="warning" showIcon message={t('visualConfig.prompt.undeclaredVariables', { variables: undeclared.join(', ') })} /> : null}
      {unused.length ? <Alert type="info" showIcon message={t('visualConfig.prompt.unusedVariables', { variables: unused.join(', ') })} /> : null}
      <Typography.Text type="secondary">{t('visualConfig.security.noSecrets')}</Typography.Text>
    </Space>
  );
}

function detectVariables(content: string): string[] {
  return Array.from(new Set([...content.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu)].map((match) => match[1] ?? ''))).filter(Boolean);
}
