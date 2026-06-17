import type { ToolManifest } from '@dar/contracts';

interface JsonSchemaLite {
  required?: unknown;
  properties?: unknown;
}

function asSchema(value: unknown): JsonSchemaLite {
  return value && typeof value === 'object' ? (value as JsonSchemaLite) : {};
}

function getTypeName(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

export function validateArguments(manifest: ToolManifest, args: Record<string, unknown>): void {
  const schema = asSchema(manifest.input_schema);
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];

  for (const key of required) {
    if (!(key in args)) {
      throw new Error(`Missing required argument: ${key}`);
    }
  }

  const properties = schema.properties && typeof schema.properties === 'object'
    ? (schema.properties as Record<string, { type?: string }>)
    : {};

  for (const [key, property] of Object.entries(properties)) {
    if (!(key in args) || !property.type) {
      continue;
    }

    const actual = getTypeName(args[key]);
    if (actual !== property.type) {
      throw new Error(`Invalid argument type for ${key}: expected ${property.type}, got ${actual}`);
    }
  }
}
