import { stringifyPretty } from './json.js';

export function formatDateTime(value: string | undefined): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export function formatVersion(value: number | string | undefined): string {
  return value === undefined ? '-' : String(value);
}

export function formatList(values: string[] | undefined): string {
  return values && values.length > 0 ? values.join(', ') : '-';
}

export function compactJson(value: unknown, maxLength = 180): string {
  const text = stringifyPretty(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
