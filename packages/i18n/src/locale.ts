export type SupportedLocale = 'zh-CN';

export const SUPPORTED_LOCALES = ['zh-CN'] as const;
export const DEFAULT_LOCALE: SupportedLocale = 'zh-CN';
export const FALLBACK_LOCALE: SupportedLocale = 'zh-CN';

const MAX_ACCEPT_LANGUAGE_LENGTH = 256;

export interface AcceptLanguageCandidate {
  raw: string;
  locale?: SupportedLocale;
  q: number;
}

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return value === 'zh-CN';
}

export function normalizeLocale(value: unknown): SupportedLocale | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/u.test(trimmed)) {
    return undefined;
  }
  const normalized = trimmed.replace(/_/gu, '-').toLowerCase();
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-hans' || normalized === 'zh-hans-cn') {
    return 'zh-CN';
  }
  return undefined;
}

export function parseAcceptLanguage(header: unknown): AcceptLanguageCandidate[] {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !value || value.length > MAX_ACCEPT_LANGUAGE_LENGTH || /[\r\n]/u.test(value)) {
    return [];
  }
  const candidates: AcceptLanguageCandidate[] = [];
  for (const part of value.split(',').slice(0, 20)) {
    const [rawLocale, ...params] = part.trim().split(';');
    if (!rawLocale) {
      continue;
    }
    const qParam = params.find((param) => param.trim().toLowerCase().startsWith('q='));
    const q = parseQ(qParam);
    if (q <= 0) {
      continue;
    }
    const locale = normalizeLocale(rawLocale);
    candidates.push({
      raw: rawLocale.trim(),
      ...(locale ? { locale } : {}),
      q,
    });
  }
  return candidates.sort((left, right) => right.q - left.q);
}

export function resolveLocale(input: unknown): SupportedLocale {
  const direct = normalizeLocale(input);
  if (direct) {
    return direct;
  }
  const candidate = parseAcceptLanguage(input).find((item) => item.locale);
  return candidate?.locale ?? FALLBACK_LOCALE;
}

function parseQ(value: string | undefined): number {
  if (!value) {
    return 1;
  }
  const raw = value.split('=')[1]?.trim();
  if (!raw || !/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.test(raw)) {
    return 1;
  }
  return Number(raw);
}
