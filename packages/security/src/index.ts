import { z } from 'zod';

export const authContextSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  roles: z.array(z.string()).default([]),
  org_id: z.string().optional(),
  session_id: z.string().optional(),
});

export type AuthContext = z.infer<typeof authContextSchema>;

const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'authorization',
  'api_key',
  'apiKey',
  'secret',
  'credential',
]);

export function parseAuthContext(headers: Record<string, string | string[] | undefined>): AuthContext {
  const value = (name: string): string | undefined => {
    const header = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(header) ? header[0] : header;
  };

  return authContextSchema.parse({
    tenant_id: value('x-tenant-id'),
    user_id: value('x-user-id'),
    roles: value('x-user-roles')?.split(',').filter(Boolean) ?? [],
    org_id: value('x-org-id'),
    session_id: value('x-session-id'),
  });
}

export function maskSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveFields(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEYS.has(key) ? '[REDACTED]' : maskSensitiveFields(entry),
      ]),
    );
  }

  return value;
}
