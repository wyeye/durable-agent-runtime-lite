import { Alert, Button, Input, Space } from 'antd';
import { useMemo, useState } from 'react';
import { parseJson, stringifyPretty } from '../utils/json.js';

export function JsonEditor({
  value,
  onChange,
  minRows = 14,
  readOnly = false,
}: {
  value: string;
  onChange(value: string): void;
  minRows?: number;
  readOnly?: boolean;
}) {
  const [error, setError] = useState<string | undefined>();
  const parseState = useMemo(() => parseJson(value), [value]);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Input.TextArea
        data-testid="json-editor-textarea"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setError(undefined);
        }}
        autoSize={{ minRows, maxRows: 32 }}
        readOnly={readOnly}
        spellCheck={false}
      />
      {error || !parseState.ok ? (
        <Alert type="error" showIcon message="JSON 格式错误" description={error ?? parseState.error} />
      ) : null}
      {!readOnly ? (
        <Button
          onClick={() => {
            const parsed = parseJson(value);
            if (!parsed.ok) {
              setError(parsed.error ?? 'JSON parse failed');
              return;
            }
            onChange(stringifyPretty(parsed.value));
          }}
        >
          格式化 JSON
        </Button>
      ) : null}
    </Space>
  );
}
