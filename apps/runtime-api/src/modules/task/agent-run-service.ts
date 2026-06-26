import {
  agentRunQuerySchema,
  agentStepQuerySchema,
  type AgentRunRecord,
  type AgentStepRecord,
} from '@dar/contracts';
import {
  AgentRunRepository,
  AgentStepRepository,
  type ListAgentRunsOptions,
} from '@dar/db';

export interface AgentRunStore {
  get(agentRunId: string, options?: { tenantId?: string; userId?: string }): Promise<AgentRunRecord | undefined>;
  list(options?: ListAgentRunsOptions): Promise<AgentRunRecord[]>;
}

export interface AgentStepStore {
  listByRun(agentRunId: string, options?: { limit?: number; offset?: number }): Promise<AgentStepRecord[]>;
}

export class AgentRunService {
  constructor(
    private readonly runStore: AgentRunStore = new InMemoryAgentRunStore(),
    private readonly stepStore: AgentStepStore = new InMemoryAgentStepStore(),
  ) {}

  async list(input: unknown): Promise<{ agent_runs: AgentRunRecord[] }> {
    const query = agentRunQuerySchema.parse(input);
    if (!query.tenant_id) {
      throw new Error('tenant_id is required for agent_run query');
    }
    const agentRuns = await this.runStore.list({
      tenantId: query.tenant_id,
      ...(query.user_id ? { userId: query.user_id } : {}),
      ...(query.task_run_id ? { taskRunId: query.task_run_id } : {}),
      ...(query.agent_id ? { agentId: query.agent_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
    return { agent_runs: agentRuns };
  }

  async get(agentRunId: string, input: unknown): Promise<{ agent_run: AgentRunRecord } | undefined> {
    const query = agentRunQuerySchema.parse(input);
    if (!query.tenant_id) {
      throw new Error('tenant_id is required for agent_run query');
    }
    const agentRun = await this.runStore.get(agentRunId, {
      tenantId: query.tenant_id,
      ...(query.user_id ? { userId: query.user_id } : {}),
    });
    return agentRun ? { agent_run: agentRun } : undefined;
  }

  async listSteps(agentRunId: string, input: unknown): Promise<{ agent_steps: AgentStepRecord[] }> {
    const query = agentStepQuerySchema.parse({ ...(typeof input === 'object' && input ? input : {}), agent_run_id: agentRunId });
    const agentSteps = await this.stepStore.listByRun(agentRunId, {
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
    return { agent_steps: agentSteps };
  }
}

export class DbAgentRunStore implements AgentRunStore {
  constructor(private readonly repository: AgentRunRepository) {}

  get(
    agentRunId: string,
    options: { tenantId?: string; userId?: string } = {},
  ): Promise<AgentRunRecord | undefined> {
    return this.repository.get(agentRunId, options);
  }

  list(options: ListAgentRunsOptions = {}): Promise<AgentRunRecord[]> {
    return this.repository.list(options);
  }
}

export class DbAgentStepStore implements AgentStepStore {
  constructor(private readonly repository: AgentStepRepository) {}

  listByRun(agentRunId: string, options: { limit?: number; offset?: number } = {}): Promise<AgentStepRecord[]> {
    return this.repository.listByRun(agentRunId, options);
  }
}

export class InMemoryAgentRunStore implements AgentRunStore {
  async get(): Promise<AgentRunRecord | undefined> {
    return undefined;
  }

  async list(): Promise<AgentRunRecord[]> {
    return [];
  }
}

export class InMemoryAgentStepStore implements AgentStepStore {
  async listByRun(): Promise<AgentStepRecord[]> {
    return [];
  }
}
