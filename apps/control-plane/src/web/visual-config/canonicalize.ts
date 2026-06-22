const serverManagedFields = new Set([
  'revision',
  'created_by',
  'updated_by',
  'published_by',
  'created_at',
  'updated_at',
  'published_at',
]);

export function stripServerManagedFields<T>(value: T): T {
  return stripServerManagedFieldsAtDepth(value, 0);
}

function stripServerManagedFieldsAtDepth<T>(value: T, depth: number): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripServerManagedFieldsAtDepth(item, depth + 1)) as T;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !serverManagedFields.has(key) && !isTopLevelHashField(key, depth))
      .map(([key, nested]) => [key, stripServerManagedFieldsAtDepth(nested, depth + 1)]),
  ) as T;
}

function isTopLevelHashField(key: string, depth: number): boolean {
  return depth === 0 && (key === 'sha256' || key === 'dataset_hash' || key === 'gate_policy_hash');
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2);
}
