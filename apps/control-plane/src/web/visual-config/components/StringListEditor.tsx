import { Button, Input, List, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export function StringListEditor({
  value,
  onChange,
  readOnly,
  placeholder,
  fieldPath,
  testId,
}: {
  value: string[];
  onChange(value: string[]): void;
  readOnly: boolean;
  placeholder?: string;
  fieldPath?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const values = Array.from(new Set(value.filter((item) => item.trim().length > 0)));

  const addValues = (text: string) => {
    const next = text
      .split(/\r?\n|,/u)
      .map((item) => item.trim())
      .filter(Boolean);
    if (next.length) {
      onChange(Array.from(new Set([...values, ...next])));
    }
    setDraft('');
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} data-field-path={fieldPath}>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          data-testid={testId}
          value={draft}
          disabled={readOnly}
          placeholder={placeholder ?? t('visualConfig.stringList.placeholder')}
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={() => addValues(draft)}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (text.includes('\n')) {
              event.preventDefault();
              addValues(text);
            }
          }}
        />
        <Button
          disabled={readOnly || !draft.trim()}
          onClick={() => addValues(draft)}
        >
          {t('visualConfig.actions.add')}
        </Button>
      </Space.Compact>
      <Typography.Text type="secondary">{t('visualConfig.stringList.help')}</Typography.Text>
      <List
        size="small"
        bordered
        dataSource={values}
        locale={{ emptyText: t('visualConfig.stringList.empty') }}
        renderItem={(item, index) => (
          <List.Item
            actions={[
              <Button
                key="up"
                size="small"
                disabled={readOnly || index === 0}
                onClick={() => onChange(move(values, index, index - 1))}
              >
                ↑
              </Button>,
              <Button
                key="down"
                size="small"
                disabled={readOnly || index === values.length - 1}
                onClick={() => onChange(move(values, index, index + 1))}
              >
                ↓
              </Button>,
              <Button
                key="delete"
                size="small"
                danger
                disabled={readOnly}
                onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
              >
                ×
              </Button>,
            ]}
          >
            {item}
          </List.Item>
        )}
      />
    </Space>
  );
}

function move(values: string[], from: number, to: number): string[] {
  const next = [...values];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to, 0, item);
  }
  return next;
}
