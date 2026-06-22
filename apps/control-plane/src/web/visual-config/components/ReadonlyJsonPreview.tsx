import { Alert, Button, Space, Typography } from 'antd';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { canonicalJson } from '../canonicalize.js';

export function ReadonlyJsonPreview({
  value,
  filename = 'config-preview.json',
  maxHeight = 520,
}: {
  value: unknown;
  filename?: string;
  maxHeight?: number;
}) {
  const { t } = useTranslation();
  const json = useMemo(() => canonicalJson(value), [value]);
  const size = new Blob([json]).size;

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Button
          data-testid="json-preview-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(json);
          }}
        >
          {t('visualConfig.json.copy')}
        </Button>
        <Button
          data-testid="json-preview-download"
          onClick={() => downloadJson(filename, json)}
        >
          {t('visualConfig.json.download')}
        </Button>
        <Typography.Text type="secondary">
          {t('visualConfig.json.size', { size })}
        </Typography.Text>
      </Space>
      <Alert
        type="info"
        showIcon
        message={t('visualConfig.json.readonlyTitle')}
        description={t('visualConfig.json.readonlyDescription')}
      />
      <pre
        className="cp-json-pre cp-json-readonly"
        data-testid="readonly-json-preview"
        aria-readonly="true"
        style={{ maxHeight }}
      >
        {withLineNumbers(json)}
      </pre>
    </Space>
  );
}

function withLineNumbers(json: string): string {
  return json
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(4, ' ')}  ${line}`)
    .join('\n');
}

function downloadJson(filename: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
