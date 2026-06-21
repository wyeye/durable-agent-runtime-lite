import i18next, { type i18n, type TOptions } from 'i18next';
import { DEFAULT_LOCALE, resolveLocale, type SupportedLocale } from './locale.js';
import { translationResources } from './resources.js';

export type SafeTranslationParam = string | number | boolean | null | undefined;
export type SafeTranslationParams = Record<string, SafeTranslationParam>;
export type Translator = (key: string, params?: SafeTranslationParams) => string;

const instances = new Map<SupportedLocale, i18n>();

export function createI18nInstance(locale: unknown = DEFAULT_LOCALE): i18n {
  const resolved = resolveLocale(locale);
  const instance = i18next.createInstance();
  void instance.init({
    resources: translationResources,
    lng: resolved,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [DEFAULT_LOCALE],
    defaultNS: 'translation',
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance;
}

export function getI18nInstance(locale: unknown = DEFAULT_LOCALE): i18n {
  const resolved = resolveLocale(locale);
  const cached = instances.get(resolved);
  if (cached) {
    return cached;
  }
  const instance = createI18nInstance(resolved);
  instances.set(resolved, instance);
  return instance;
}

export function createTranslator(locale: unknown = DEFAULT_LOCALE): Translator {
  const instance = getI18nInstance(locale);
  return (key, params) => {
    const options: TOptions = params ? { ...params } : {};
    const value = instance.t(key, options);
    return typeof value === 'string' && value !== key ? value : key;
  };
}

export function translate(key: string, params?: SafeTranslationParams, locale: unknown = DEFAULT_LOCALE): string {
  return createTranslator(locale)(key, params);
}
