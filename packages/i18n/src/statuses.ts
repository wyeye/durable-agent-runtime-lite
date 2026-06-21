import { translate } from './translator.js';

export function statusLabel(status: string, locale?: unknown): string {
  return translate(`statuses.runtime.${status}`, undefined, locale);
}

export function registryStatusLabel(status: string, locale?: unknown): string {
  return translate(`statuses.registry.${status}`, undefined, locale);
}

export function evaluationStatusLabel(status: string, locale?: unknown): string {
  return translate(`statuses.evaluation.${status}`, undefined, locale);
}

export function roleLabel(role: string, locale?: unknown): string {
  return translate(`statuses.roles.${role}`, undefined, locale);
}

export function riskLabel(riskLevel: string, locale?: unknown): string {
  return translate(`statuses.risks.${riskLevel}`, undefined, locale);
}
