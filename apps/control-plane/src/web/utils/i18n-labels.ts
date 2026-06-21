import {
  evaluationStatusLabel,
  registryStatusLabel,
  riskLabel,
  roleLabel,
  statusLabel,
  translate,
} from '@dar/i18n';

export function navLabel(key: string): string {
  return translate(`navigation.${key}`);
}

export function displayStatus(status: string): string {
  const registry = registryStatusLabel(status);
  if (registry !== `statuses.registry.${status}`) {
    return registry;
  }
  const evaluation = evaluationStatusLabel(status);
  if (evaluation !== `statuses.evaluation.${status}`) {
    return evaluation;
  }
  const runtime = statusLabel(status);
  return runtime === `statuses.runtime.${status}` ? status : runtime;
}

export function displayRole(role: string): string {
  const label = roleLabel(role);
  return label === `statuses.roles.${role}` ? role : label;
}

export function displayRisk(risk: string): string {
  const label = riskLabel(risk);
  return label === `statuses.risks.${risk}` ? risk : label;
}

export function displayAction(action: string): string {
  const value = translate(`common.actions.${action}`);
  return value === `common.actions.${action}` ? action : value;
}
