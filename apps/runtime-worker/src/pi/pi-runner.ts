import { agentRunResultSchema, type AgentRunRequest, type AgentRunResult } from '@dar/contracts';

export async function runPiAgent(request: AgentRunRequest): Promise<AgentRunResult> {
  const recordWriteTool = request.allowed_tools
    .map((toolRef) => {
      const [toolName, toolVersion] = toolRef.split('@');
      return toolName && toolVersion ? { toolName, toolVersion } : undefined;
    })
    .find((tool) => tool?.toolName === 'record.write.mock');

  if (recordWriteTool) {
    return agentRunResultSchema.parse({
      status: 'need_tool',
      final_answer: 'Mock agent generated a record write proposal.',
      proposed_tool_calls: [
        {
          tool_name: recordWriteTool.toolName,
          tool_version: recordWriteTool.toolVersion,
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
