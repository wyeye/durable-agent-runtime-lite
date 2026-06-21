import { translate, type SafeTranslationParams } from './translator.js';
import { resolveLocale, type SupportedLocale } from './locale.js';

export interface ZodLikeIssue {
  code: string;
  path?: PropertyKey[];
  message?: string;
  input?: unknown;
  expected?: unknown;
  received?: unknown;
  minimum?: number | bigint;
  maximum?: number | bigint;
  keys?: string[];
  options?: unknown[];
  validation?: unknown;
  format?: unknown;
}

export interface LocalizedZodIssue {
  path: string;
  code: string;
  message_key: string;
  message: string;
  params?: SafeTranslationParams;
}

export function localizeZodIssues(issues: readonly ZodLikeIssue[], locale?: unknown): LocalizedZodIssue[] {
  const resolved = resolveLocale(locale);
  return issues.map((issue) => localizeZodIssue(issue, resolved));
}

function localizeZodIssue(issue: ZodLikeIssue, locale: SupportedLocale): LocalizedZodIssue {
  const messageKey = messageKeyForIssue(issue);
  const params = issueParams(issue);
  return {
    path: formatPath(issue.path),
    code: issue.code,
    message_key: messageKey,
    message: translate(messageKey, params, locale),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

function messageKeyForIssue(issue: ZodLikeIssue): string {
  if (issue.code === 'invalid_type' && (issue.received === 'undefined' || issue.input === undefined)) {
    return 'common.validation.required';
  }
  switch (issue.code) {
    case 'invalid_type':
      return 'common.validation.invalidType';
    case 'too_small':
      return 'common.validation.tooSmall';
    case 'too_big':
      return 'common.validation.tooBig';
    case 'invalid_string':
    case 'invalid_format':
      return 'common.validation.invalidString';
    case 'invalid_enum_value':
    case 'invalid_value':
      return 'common.validation.invalidEnumValue';
    case 'unrecognized_keys':
      return 'common.validation.unrecognizedKeys';
    case 'custom':
      return 'common.validation.custom';
    case 'invalid_union':
      return 'common.validation.invalidUnion';
    case 'invalid_date':
      return 'common.validation.invalidDate';
    default:
      return 'common.validation.unknown';
  }
}

function issueParams(issue: ZodLikeIssue): SafeTranslationParams {
  const params: SafeTranslationParams = {};
  if (typeof issue.minimum === 'number') {
    params.minimum = issue.minimum;
  }
  if (typeof issue.maximum === 'number') {
    params.maximum = issue.maximum;
  }
  if (Array.isArray(issue.keys) && issue.keys.length > 0) {
    params.keys = issue.keys.join(', ');
  }
  if (typeof issue.expected === 'string') {
    params.expected = issue.expected;
  }
  return params;
}

function formatPath(path: PropertyKey[] | undefined): string {
  if (!path || path.length === 0) {
    return '';
  }
  return path.map(String).join('.');
}
