import type { JsonObject } from '../types.js';
import { Alert, Button, Checkbox, Form, Input, InputNumber, Select, Space, Tag } from 'antd';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ReadonlyJsonPreview } from './ReadonlyJsonPreview.js';
import { StringListEditor } from './StringListEditor.js';
import { StructuredValueEditor, toJsonValue } from './StructuredValueEditor.js';

const supportedKeys = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'items',
  'enum',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'additionalProperties',
]);

const schemaTypes = ['object', 'array', 'string', 'number', 'integer', 'boolean'] as const;

type SchemaType = (typeof schemaTypes)[number];

export function JsonSchemaBuilder({
  value,
  onChange,
  readOnly,
  fieldPath,
}: {
  value: JsonObject;
  onChange(value: JsonObject): void;
  readOnly: boolean;
  fieldPath?: string;
}) {
  const { t } = useTranslation();
  const schema = normalizeSchema(value);
  const advancedKeys = useMemo(() => Object.keys(schema).filter((key) => !supportedKeys.has(key)), [schema]);
  const type = typeof schema.type === 'string' && schemaTypes.includes(schema.type as SchemaType)
    ? (schema.type as SchemaType)
    : 'object';
  const extensionValues = Object.fromEntries(
    advancedKeys
      .map((key) => [key, schema[key]] as const)
      .filter((entry): entry is readonly [string, NonNullable<JsonObject[string]>] => entry[1] !== undefined),
  );

  const patch = (updates: JsonObject) => onChange({ ...schema, ...updates, ...extensionValues });

  return (
    <Space direction="vertical" style={{ width: '100%' }} data-field-path={fieldPath}>
      {advancedKeys.length ? (
        <Alert
          type="warning"
          showIcon
          message={t('visualConfig.schema.advancedTitle')}
          description={
            <Space wrap>{advancedKeys.map((key) => <Tag key={key}>{key}</Tag>)}</Space>
          }
        />
      ) : null}
      <Form layout="vertical">
        <Form.Item label={t('visualConfig.schema.type')}>
          <Select
            value={type}
            disabled={readOnly}
            options={schemaTypes.map((item) => ({ value: item, label: item }))}
            onChange={(nextType: SchemaType) => {
              const next: JsonObject = { ...schema, type: nextType };
              if (nextType === 'object') {
                next.properties ??= {};
                next.required ??= [];
              }
              if (nextType === 'array') {
                next.items ??= { type: 'string' };
              }
              patch(next);
            }}
          />
        </Form.Item>
        <Form.Item label={t('visualConfig.schema.title')}>
          <Input value={stringValue(schema.title)} disabled={readOnly} onChange={(event) => patch({ title: event.target.value })} />
        </Form.Item>
        <Form.Item label={t('visualConfig.schema.description')}>
          <Input.TextArea value={stringValue(schema.description)} disabled={readOnly} autoSize onChange={(event) => patch({ description: event.target.value })} />
        </Form.Item>
        {type === 'object' ? (
          <ObjectSchemaSection schema={schema} readOnly={readOnly} onChange={patch} />
        ) : null}
        {type === 'array' ? (
          <ArraySchemaSection schema={schema} readOnly={readOnly} onChange={patch} />
        ) : null}
        {type === 'string' ? (
          <Space wrap>
            <Form.Item label="minLength"><InputNumber min={0} value={numberValue(schema.minLength)} disabled={readOnly} onChange={(value) => patchOptionalNumber(schema, 'minLength', value, patch)} /></Form.Item>
            <Form.Item label="maxLength"><InputNumber min={0} value={numberValue(schema.maxLength)} disabled={readOnly} onChange={(value) => patchOptionalNumber(schema, 'maxLength', value, patch)} /></Form.Item>
          </Space>
        ) : null}
        {type === 'number' || type === 'integer' ? (
          <Space wrap>
            <Form.Item label="minimum"><InputNumber value={numberValue(schema.minimum)} disabled={readOnly} onChange={(value) => patchOptionalNumber(schema, 'minimum', value, patch)} /></Form.Item>
            <Form.Item label="maximum"><InputNumber value={numberValue(schema.maximum)} disabled={readOnly} onChange={(value) => patchOptionalNumber(schema, 'maximum', value, patch)} /></Form.Item>
          </Space>
        ) : null}
        <Form.Item label="enum">
          <StringListEditor value={stringArray(schema.enum)} readOnly={readOnly} onChange={(next) => patch(next.length ? { enum: next } : without(schema, 'enum'))} />
        </Form.Item>
        <Form.Item label="default">
          <StructuredValueEditor value={toJsonValue(schema.default ?? null)} readOnly={readOnly} onChange={(next) => patch({ default: next })} />
        </Form.Item>
      </Form>
      <ReadonlyJsonPreview value={schema} filename="json-schema-preview.json" maxHeight={260} />
    </Space>
  );
}

function ObjectSchemaSection({
  schema,
  readOnly,
  onChange,
}: {
  schema: JsonObject;
  readOnly: boolean;
  onChange(value: JsonObject): void;
}) {
  const { t } = useTranslation();
  const properties = normalizeProperties(schema.properties);
  const required = stringArray(schema.required);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Checkbox
        checked={schema.additionalProperties !== false}
        disabled={readOnly}
        onChange={(event) => onChange({ additionalProperties: event.target.checked })}
      >
        {t('visualConfig.schema.additionalProperties')}
      </Checkbox>
      {Object.entries(properties).map(([key, nested]) => (
        <div className="vc-schema-property" key={key}>
          <Space align="start" style={{ width: '100%' }}>
            <Input value={key} disabled={readOnly} style={{ width: 180 }} onChange={(event) => {
              const nextKey = event.target.value.trim();
              if (!nextKey || nextKey in properties) {
                return;
              }
              const current = properties[key];
              const rest = omitKey(properties, key);
              if (!current) {
                return;
              }
              onChange({
                properties: { ...rest, [nextKey]: current },
                required: required.map((item) => (item === key ? nextKey : item)),
              });
            }} />
            <Checkbox
              checked={required.includes(key)}
              disabled={readOnly}
              onChange={(event) => onChange({
                required: event.target.checked
                  ? Array.from(new Set([...required, key]))
                  : required.filter((item) => item !== key),
              })}
            >
              required
            </Checkbox>
            <Button danger disabled={readOnly} onClick={() => {
              const rest = omitKey(properties, key);
              onChange({ properties: rest, required: required.filter((item) => item !== key) });
            }}>×</Button>
          </Space>
          <JsonSchemaBuilder
            value={nested}
            readOnly={readOnly}
            onChange={(nextNested) => onChange({ properties: { ...properties, [key]: nextNested } })}
          />
        </div>
      ))}
      <Button disabled={readOnly} onClick={() => onChange({
        properties: { ...properties, [nextPropertyKey(properties)]: { type: 'string' } },
      })}>
        {t('visualConfig.actions.addProperty')}
      </Button>
    </Space>
  );
}

function ArraySchemaSection({
  schema,
  readOnly,
  onChange,
}: {
  schema: JsonObject;
  readOnly: boolean;
  onChange(value: JsonObject): void;
}) {
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Form.Item label="minItems"><InputNumber min={0} value={numberValue(schema.minItems)} disabled={readOnly} onChange={(value) => patchOptionalNumber(schema, 'minItems', value, onChange)} /></Form.Item>
        <Form.Item label="maxItems"><InputNumber min={0} value={numberValue(schema.maxItems)} disabled={readOnly} onChange={(value) => patchOptionalNumber(schema, 'maxItems', value, onChange)} /></Form.Item>
      </Space>
      <JsonSchemaBuilder
        value={normalizeSchema(schema.items)}
        readOnly={readOnly}
        onChange={(items) => onChange({ items })}
      />
    </Space>
  );
}

function normalizeSchema(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : { type: 'object' };
}

function normalizeProperties(value: unknown): Record<string, JsonObject> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeSchema(nested)]),
  );
}

function patchOptionalNumber(schema: JsonObject, key: string, value: number | null, patch: (value: JsonObject) => void) {
  if (typeof value === 'number') {
    patch({ [key]: value });
    return;
  }
  patch(without(schema, key));
}

function without(schema: JsonObject, key: string): JsonObject {
  return Object.fromEntries(
    Object.entries(omitKey(schema, key)).filter((entry): entry is [string, NonNullable<JsonObject[string]>] => entry[1] !== undefined),
  );
}

function omitKey<TValue>(record: Record<string, TValue>, key: string): Record<string, TValue> {
  return Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nextPropertyKey(properties: Record<string, JsonObject>): string {
  let index = Object.keys(properties).length + 1;
  while (`field_${index}` in properties) {
    index += 1;
  }
  return `field_${index}`;
}
