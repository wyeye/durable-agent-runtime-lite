import type { ZodIssue } from 'zod';
import { ApiError } from '../api/client.js';

export function issuePath(issue: ZodIssue): string {
  return issue.path.length ? issue.path.join('.') : 'root';
}

export function issuesForPath(issues: ZodIssue[] | undefined, path: string): ZodIssue[] {
  return (issues ?? []).filter((issue) => issuePath(issue) === path);
}

export function issueMessageForPath(issues: ZodIssue[] | undefined, path: string): string | undefined {
  const messages = issuesForPath(issues, path).map((issue) => issue.message);
  return messages.length ? messages.join('；') : undefined;
}

export interface VisualFormIssue {
  path: string;
  message: string;
  code?: string;
}

export function issuesFromError(error: unknown): VisualFormIssue[] {
  if (!error) {
    return [];
  }
  if (error instanceof ApiError) {
    return issuesFromApiError(error);
  }
  if (error instanceof Error) {
    return [{ path: 'root', message: error.message }];
  }
  return [{ path: 'root', message: '未知错误' }];
}

function issuesFromApiError(error: ApiError): VisualFormIssue[] {
  const details = error.details;
  const extracted = extractIssueObjects(details);
  if (extracted.length) {
    return extracted.map((issue) => ({
      path: issue.path ?? inferPath(error),
      message: issue.message ?? error.message,
      code: issue.code ?? error.code,
    }));
  }
  return [{
    path: inferPath(error),
    message: `${error.message}${error.requestId ? `（request_id: ${error.requestId}）` : ''}`,
    code: error.code,
  }];
}

function extractIssueObjects(value: unknown): Array<{ path?: string; message?: string; code?: string }> {
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  const candidates = [
    record.issues,
    record.errors,
    record.validation_errors,
    record.field_errors,
  ];
  return candidates.flatMap((candidate) => {
    if (!Array.isArray(candidate)) {
      return [];
    }
    return candidate.flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return [];
      }
      const issue = item as Record<string, unknown>;
      const path = pathFromUnknown(issue.path ?? issue.field ?? issue.pointer);
      const message = typeof issue.message === 'string' ? issue.message : undefined;
      const code = typeof issue.code === 'string' ? issue.code : undefined;
      return [{ ...(path ? { path } : {}), ...(message ? { message } : {}), ...(code ? { code } : {}) }];
    });
  });
}

function pathFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.replace(/^\/+/u, '').replaceAll('/', '.');
  }
  if (Array.isArray(value)) {
    return value.map(String).join('.');
  }
  return undefined;
}

function inferPath(error: ApiError): string {
  if (error.status === 409) {
    return 'revision';
  }
  if (error.status === 422) {
    return 'root';
  }
  return 'root';
}
