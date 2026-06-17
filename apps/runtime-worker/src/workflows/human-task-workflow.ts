export const HUMAN_TASK_RESOLVE_SIGNAL = 'resolveHumanTask';

export interface HumanTaskSignalPayload {
  human_task_id: string;
  approved: boolean;
  comment?: string;
}
