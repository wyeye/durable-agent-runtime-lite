import { agentRunResultSchema, type AgentRunRequest, type AgentRunResult } from '@dar/contracts';

export async function runPiAgent(request: AgentRunRequest): Promise<AgentRunResult> {
  if (request.allowed_tools.includes('record.write.mock')) {
    return agentRunResultSchema.parse({
      status: 'need_tool',
      final_answer: 'Mock agent generated a record write proposal.',
      proposed_tool_calls: [
        {
          tool_name: 'record.write.mock',
          tool_version: '1.0.0',
          risk_level: 'L3',
          arguments: {
            record: {
              task_run_id: request.task_run_id,
              summary: 'mock agent plan',
            },
          },
        },
      ],
      usage: { mode: 'mock' },
    });
  }

  return agentRunResultSchema.parse({
    status: 'final',
    final_answer: 'Mock agent completed.',
    usage: { mode: 'mock' },
  });
}
