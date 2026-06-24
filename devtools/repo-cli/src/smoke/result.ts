export type SmokeSuite = 'core' | 'agent' | 'governance' | 'ui' | 'real';

export interface SmokeResult {
  ok: boolean;
  scenario: string;
  duration_ms: number;
  summary: Record<string, unknown>;
  artifacts?: string[];
  skipped?: boolean;
  skip_reason?: string;
}

export interface SmokeContext {
  ci: boolean;
  json: boolean;
}

export interface SmokeScenario {
  id: string;
  suite: SmokeSuite;
  description: string;
  mode: 'ci' | 'manual' | 'real';
  timeoutMs: number;
  command: string[];
  env?: Record<string, string>;
  artifacts?: string[];
}
