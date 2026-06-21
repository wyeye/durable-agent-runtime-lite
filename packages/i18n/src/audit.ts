import { AUDIT_MESSAGE_KEYS, type AuditEventType } from './keys.js';
import { resolveLocale, type SupportedLocale } from './locale.js';
import { translate, type SafeTranslationParams } from './translator.js';

export interface LocalizedAuditDisplay {
  message_key: string;
  message_params: SafeTranslationParams;
  display_message: string;
  locale: SupportedLocale;
}

export function messageKeyForAuditEvent(eventType: string): string {
  return AUDIT_MESSAGE_KEYS[eventType as AuditEventType] ?? 'audit.fallback';
}

export function localizeAuditEvent(
  eventType: string,
  params: SafeTranslationParams = {},
  locale: unknown = undefined,
): LocalizedAuditDisplay {
  const resolved = resolveLocale(locale);
  const messageKey = messageKeyForAuditEvent(eventType);
  return {
    message_key: messageKey,
    message_params: params,
    display_message: translate(messageKey, params, resolved),
    locale: resolved,
  };
}
