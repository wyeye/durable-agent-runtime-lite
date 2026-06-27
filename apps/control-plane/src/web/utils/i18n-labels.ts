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

export function displayWorkflowType(type: string): string {
  switch (type) {
    case 'ConfigDrivenWorkflow':
      return '配置驱动工作流';
    case 'GenericAgentWorkflow':
      return '通用智能体工作流';
    default:
      return type;
  }
}

export function displayFlowStepType(type: string): string {
  switch (type) {
    case 'activity':
      return '活动';
    case 'tool':
      return '工具';
    case 'agent':
      return '智能体';
    case 'human_task':
      return '人工任务';
    case 'condition':
      return '条件判断';
    default:
      return type;
  }
}

export function displayRouteChannel(channel: string): string {
  switch (channel) {
    case 'web':
      return '网页';
    case 'api':
      return 'API';
    case 'chat':
      return '聊天';
    case 'control-plane':
      return '控制台';
    case 'admin-console':
      return '管理后台';
    default:
      return channel;
  }
}
