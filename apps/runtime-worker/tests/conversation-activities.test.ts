import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusUpdates = vi.hoisted(() => [] as Array<{ taskRunId: string; input: unknown }>);
const createdHumanTasks = vi.hoisted(() => [] as Array<{ context: unknown; input: unknown }>);
const auditEvents = vi.hoisted(() => [] as Array<{ action: string; reason: string | null | undefined }>);
const conversationMessages = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('@dar/config', () => ({
  getToolGatewayUrl: () => 'http://localhost:3200',
  loadConfig: () => ({
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    TOOL_GATEWAY_URL: 'http://localhost:3200',
  }),
}));

vi.mock('@dar/db', async (importActual) => {
  const actual = await importActual<typeof import('@dar/db')>();
  return {
    ...actual,
    createDb: vi.fn(() => ({ fake: true })),
    closeDb: vi.fn(async () => undefined),
    TaskRunRepository: class {
      async updateStatus(taskRunId: string, input: unknown) {
        statusUpdates.push({ taskRunId, input });
        return { task_run_id: taskRunId, status: (input as { status?: string }).status };
      }
    },
    HumanTaskRepository: class {
      async create(input: Record<string, unknown>) {
        createdHumanTasks.push({ context: { task_run_id: input.task_run_id }, input });
        return {
          human_task_id: 'human_user_1',
          tenant_id: input.tenant_id,
          task_run_id: input.task_run_id,
          workflow_id: input.workflow_id,
          kind: input.kind,
          status: 'pending',
          candidate_groups: [],
          payload: input.payload ?? {},
          requested_schema: input.requested_schema,
          created_at: '2026-01-01T00:00:00.000Z',
        };
      }
    },
    AuditEventRepository: class {
      async append(input: { action: string; reason?: string | null }) {
        auditEvents.push({ action: input.action, reason: input.reason });
        return undefined;
      }
    },
    ConversationMessageRepository: class {
      async get(messageId: string) {
        return conversationMessages.get(messageId);
      }
    },
  };
});

describe('runtime-worker conversation activities', () => {
  beforeEach(() => {
    statusUpdates.length = 0;
    createdHumanTasks.length = 0;
    auditEvents.length = 0;
    conversationMessages.clear();
  });

  it('marks user_input human tasks as waiting_user task runs', async () => {
    const { createHumanTaskActivity } = await import('../src/activities/index.js');

    await createHumanTaskActivity(
      {
        tenant_id: 'tenant_1',
        user_id: 'user_1',
        task_run_id: 'task_user_input_1',
        workflow_id: 'workflow_user_input_1',
        request_id: 'req_user_input_1',
      },
      {
        kind: 'user_input',
        payload: { question: 'Please provide one value.' },
        requested_schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    );

    expect(statusUpdates).toContainEqual({
      taskRunId: 'task_user_input_1',
      input: { status: 'waiting_user' },
    });
    expect(createdHumanTasks).toHaveLength(1);
    expect(auditEvents).toContainEqual({
      action: 'agent.human_task.created',
      reason: 'agent_user_input_required',
    });
  });

  it('loads completed conversation history into Pi seed messages', async () => {
    const { loadConversationContextActivity } = await import('../src/activities/index.js');
    const userMessage = conversationMessage({
      message_id: 'msg_user_1',
      sequence_no: 1,
      role: 'user',
      content_text: '你好',
    });
    const assistantMessage = conversationMessage({
      message_id: 'msg_assistant_1',
      sequence_no: 2,
      role: 'assistant',
      content_text: '你好，我在。',
    });
    conversationMessages.set(userMessage.message_id, userMessage);
    conversationMessages.set(assistantMessage.message_id, assistantMessage);

    const result = await loadConversationContextActivity({
      tenant_id: 'tenant_1',
      owner_user_id: 'user_1',
      conversation_id: 'conversation_1',
      context_message_ids: [assistantMessage.message_id, userMessage.message_id],
      context_hash: hashConversationMessages([userMessage, assistantMessage]),
    });

    expect(result.seed_messages).toEqual([
      {
        role: 'user',
        content: '你好',
        timestamp: 0,
      },
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: '你好，我在。' }],
      }),
    ]);
  });

  it('rejects mismatched conversation context hashes', async () => {
    const { loadConversationContextActivity } = await import('../src/activities/index.js');
    const userMessage = conversationMessage({
      message_id: 'msg_user_2',
      sequence_no: 1,
      role: 'user',
      content_text: 'first',
    });
    const assistantMessage = conversationMessage({
      message_id: 'msg_assistant_2',
      sequence_no: 2,
      role: 'assistant',
      content_text: 'second',
    });
    conversationMessages.set(userMessage.message_id, userMessage);
    conversationMessages.set(assistantMessage.message_id, assistantMessage);

    await expect(loadConversationContextActivity({
      tenant_id: 'tenant_1',
      owner_user_id: 'user_1',
      conversation_id: 'conversation_1',
      context_message_ids: [userMessage.message_id, assistantMessage.message_id],
      context_hash: '0'.repeat(64),
    })).rejects.toMatchObject({
      message: 'CONVERSATION_CONTEXT_HASH_MISMATCH',
    });
  });
});

function conversationMessage(input: {
  message_id: string;
  sequence_no: number;
  role: 'user' | 'assistant';
  content_text: string;
}) {
  return {
    message_id: input.message_id,
    conversation_id: 'conversation_1',
    tenant_id: 'tenant_1',
    sequence_no: input.sequence_no,
    role: input.role,
    status: 'completed',
    content_text: input.content_text,
    context_message_ids: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:00.000Z',
  };
}

function hashConversationMessages(messages: Array<ReturnType<typeof conversationMessage>>): string {
  return createHash('sha256').update(
    JSON.stringify(
      messages.map((message) => ({
        message_id: message.message_id,
        sequence_no: message.sequence_no,
        role: message.role,
        content_text: message.content_text,
      })),
    ),
  ).digest('hex');
}
