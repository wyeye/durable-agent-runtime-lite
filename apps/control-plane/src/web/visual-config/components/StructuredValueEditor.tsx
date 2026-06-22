import type { JsonObject, JsonValue } from '../types.js';
import { Button, Checkbox, Input, InputNumber, Select, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

type JsonKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export function StructuredValueEditor({
  value,
  onChange,
  readOnly,
  fieldPath,
  depth = 0,
}: {
  value: JsonValue;
  onChange(value: JsonValue): void;
  readOnly: boolean;
  fieldPath?: string;
  depth?: number;
}) {
  const { t } = useTranslation();
  const kind = valueKind(value);
  if (depth > 6) {
    return <Typography.Text type="warning">{t('visualConfig.structured.depthLimit')}</Typography.Text>;
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }} data-field-path={fieldPath}>
      <Select
        size="small"
        value={kind}
        disabled={readOnly}
        style={{ width: 160 }}
        options={jsonKindOptions(t)}
        onChange={(nextKind: JsonKind) => onChange(defaultValueForKind(nextKind))}
      />
      {renderValueEditor({ value, kind, onChange, readOnly, depth, t })}
    </Space>
  );
}

function renderValueEditor({
  value,
  kind,
  onChange,
  readOnly,
  depth,
  t,
}: {
  value: JsonValue;
  kind: JsonKind;
  onChange(value: JsonValue): void;
  readOnly: boolean;
  depth: number;
  t(key: string): string;
}) {
  if (kind === 'string') {
    return <Input.TextArea value={String(value ?? '')} disabled={readOnly} autoSize onChange={(event) => onChange(event.target.value)} />;
  }
  if (kind === 'number') {
    return <InputNumber value={typeof value === 'number' ? value : 0} disabled={readOnly} onChange={(next) => onChange(typeof next === 'number' ? next : 0)} />;
  }
  if (kind === 'boolean') {
    return <Checkbox checked={Boolean(value)} disabled={readOnly} onChange={(event) => onChange(event.target.checked)}>{t('visualConfig.structured.booleanValue')}</Checkbox>;
  }
  if (kind === 'null') {
    return <Typography.Text type="secondary">null</Typography.Text>;
  }
  if (kind === 'array') {
    const items = Array.isArray(value) ? value : [];
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        {items.map((item, index) => (
          <div className="vc-nested-row" key={index}>
            <StructuredValueEditor
              value={toJsonValue(item)}
              readOnly={readOnly}
              depth={depth + 1}
              onChange={(nextItem) => onChange(items.map((current, itemIndex) => (itemIndex === index ? nextItem : current)))}
            />
            <Button danger disabled={readOnly} onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}>×</Button>
          </div>
        ))}
        <Button disabled={readOnly} onClick={() => onChange([...items, ''])}>{t('visualConfig.actions.addItem')}</Button>
      </Space>
    );
  }
  const objectValue = isJsonObject(value) ? value : {};
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {Object.entries(objectValue).map(([key, nested]) => (
        <div className="vc-nested-row" key={key}>
          <Input
            value={key}
            disabled={readOnly}
            {...(key.trim() ? {} : { status: 'error' as const })}
            onChange={(event) => {
              const nextKey = event.target.value.trim();
              if (!nextKey || nextKey in objectValue) {
                return;
              }
              const current = objectValue[key];
              const rest = Object.fromEntries(Object.entries(objectValue).filter(([entryKey]) => entryKey !== key));
              if (current === undefined) {
                return;
              }
              onChange({ ...rest, [nextKey]: current });
            }}
          />
          <StructuredValueEditor
            value={nested}
            readOnly={readOnly}
            depth={depth + 1}
            onChange={(nextNested) => onChange({ ...objectValue, [key]: nextNested })}
          />
          <Button danger disabled={readOnly} onClick={() => {
            const rest = Object.fromEntries(Object.entries(objectValue).filter(([entryKey]) => entryKey !== key));
            onChange(rest);
          }}>×</Button>
        </div>
      ))}
      <Button
        disabled={readOnly}
        onClick={() => onChange({ ...objectValue, [nextObjectKey(objectValue)]: '' })}
      >
        {t('visualConfig.actions.addProperty')}
      </Button>
    </Space>
  );
}

export function jsonObjectFromUnknown(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, toJsonValue(nested)]));
  }
  return null;
}

function valueKind(value: JsonValue): JsonKind {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  return 'null';
}

function defaultValueForKind(kind: JsonKind): JsonValue {
  if (kind === 'string') {
    return '';
  }
  if (kind === 'number') {
    return 0;
  }
  if (kind === 'boolean') {
    return false;
  }
  if (kind === 'array') {
    return [];
  }
  if (kind === 'object') {
    return {};
  }
  return null;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nextObjectKey(value: JsonObject): string {
  let index = Object.keys(value).length + 1;
  while (`key_${index}` in value) {
    index += 1;
  }
  return `key_${index}`;
}

function jsonKindOptions(t: (key: string) => string) {
  return [
    { value: 'string', label: t('visualConfig.structured.type.string') },
    { value: 'number', label: t('visualConfig.structured.type.number') },
    { value: 'boolean', label: t('visualConfig.structured.type.boolean') },
    { value: 'null', label: t('visualConfig.structured.type.null') },
    { value: 'object', label: t('visualConfig.structured.type.object') },
    { value: 'array', label: t('visualConfig.structured.type.array') },
  ];
}
