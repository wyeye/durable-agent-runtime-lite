import { describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  ConversationMessage,
  RunTaskResponse,
  TaskRun,
} from '@dar/contracts';
import type { RuntimeConfig } from '@dar/config';
import type { AuthContext } from '@dar/security';
import { ConversationService } from '../src/modules/conversation/conversation-service.js';
import { ConversationServiceError } from '../src/modules/conversation/conversation-errors.js';

const state = vi.hoisted(() => ({
  conversation: undefined as Conversation | undefined,
  updatedConversation: undefined as Conversation | undefined,
  updateTitleError: undefined as unknown,
  getOwnedCalls: 0,
  createdTurn: undefined as
    | {
        userMessage: ConversationMessage;
        assistantMessage: ConversationMessage;
        idempotentReplay?: boolean;
      }
    | undefined,
  linkedAssistant: undefined as ConversationMessage | undefined,
  taskRun: undefined as TaskRun | undefined,
  taskRunByAssistantMessageId: undefined as TaskRun | undefined,
  routeResponse: undefined as RunTaskResponse | undefined,
  createdTaskCalls: [] as unknown[],
  audits: [] as Array<{ action: string; payload: Record<string, unknown> }>,
}));

vi.mock('@dar/db', async (importActual) => {
  const actual = await importActual<typeof import('@dar/db')>();
  return {
    ...actual,
    ConversationRepository: class {
      async getOwned() {
        state.getOwnedCalls += 1;
        if (state.getOwnedCalls > 1 && state.updatedConversation) {
          return state.updatedConversation;
        }
        return state.conversation;
      }

      async updateTitle() {
        if (state.updateTitleError) {
          throw state.updateTitleError;
        }
        return state.updatedConversation ?? state.conversation;
      }
    },
    ConversationMessageRepository: class {
      async listCompletedContextMessages() {
        return [];
      }

      async createUserAndAssistantTurn() {
        if (!state.createdTurn) {
          throw new Error('missing created turn fixture');
        }
        return state.createdTurn;
      }

      async get(messageId: string) {
        if (state.linkedAssistant?.message_id === messageId) {
          return state.linkedAssistant;
        }
        if (state.createdTurn?.assistantMessage.message_id === messageId) {
          return state.createdTurn.assistantMessage;
        }
        return undefined;
      }

      async linkTaskRun() {
        return state.linkedAssistant;
      }

      async completeAssistant() {
        return state.linkedAssistant ?? state.createdTurn?.assistantMessage;
      }

      async failAssistant() {
        return state.linkedAssistant ?? state.createdTurn?.assistantMessage;
      }
    },
    TaskRunRepository: class {
      async get(taskRunId: string) {
        return state.taskRun?.task_run_id === taskRunId ? state.taskRun : undefined;
      }

      async list() {
        return state.taskRunByAssistantMessageId ? [state.taskRunByAssistantMessageId] : [];
      }
    },
    AgentRunRepository: class {
      async get() {
        return undefined;
      }
    },
    AuditEventRepository: class {
      async append(input: { action: string; payload?: Record<string, unknown> }) {
        state.audits.push({ action: input.action, payload: input.payload ?? {} });
      }
    },
  };
});

describe('ConversationService.sendMessage', () => {
  it('returns the original turn for idempotent replay without creating a new task', async () => {
    const conversation = baseConversation();
    const userMessage = baseMessage({
      message_id: 'msg_user_1',
      role: 'user',
      status: 'completed',
      content_text: '请记住项目代号是蓝鲸',
      sequence_no: 1,
      client_message_id: 'client-msg-1',
      completed_at: '2026-01-01T00:00:00.000Z',
    });
    const assistantMessage = baseMessage({
      message_id: 'msg_assistant_1',
      role: 'assistant',
      status: 'running',
      content_text: null,
      sequence_no: 2,
      reply_to_message_id: userMessage.message_id,
      task_run_id: null,
    });
    const linkedAssistant = { ...assistantMessage, task_run_id: 'task_chat_1' };
    const taskRun = baseTaskRun({
      task_run_id: 'task_chat_1',
      workflow_id: 'workflow_chat_1',
      assistant_message_id: assistantMessage.message_id,
      user_message_id: userMessage.message_id,
      conversation_id: conversation.conversation_id,
      status: 'running',
    });

    resetState({
      conversation,
      createdTurn: {
        userMessage,
        assistantMessage,
        idempotentReplay: true,
      },
      linkedAssistant,
      taskRunByAssistantMessageId: taskRun,
    });

    const service = new ConversationService({
      db: {} as never,
      taskService: {
        create: vi.fn(async (input: unknown) => {
          state.createdTaskCalls.push(input);
          return state.routeResponse ?? baseRouteResponse();
        }),
      } as never,
      config: testConfig(),
    });

    const response = await service.sendMessage(auth(), conversation.conversation_id, {
      content: '请记住项目代号是蓝鲸',
      client_message_id: 'client-msg-1',
    });

    expect(state.createdTaskCalls).toHaveLength(0);
    expect(response.task_run_id).toBe('task_chat_1');
    expect(response.workflow_id).toBe('workflow_chat_1');
    expect(response.assistant_message.task_run_id).toBe('task_chat_1');
  });

  it('surfaces idempotency conflicts when the same client_message_id is reused with different content', async () => {
    const conversation = baseConversation();
    resetState({ conversation });

    const service = new ConversationService({
      db: {} as never,
      taskService: { create: vi.fn() } as never,
      config: testConfig(),
    });

    state.createdTurn = undefined;
    const error = new ConversationServiceError(
      'CONVERSATION_MESSAGE_IDEMPOTENCY_CONFLICT',
      409,
      { conversation_id: conversation.conversation_id, client_message_id: 'client-msg-1' },
    );

    const mockedCreateTurn = vi
      .spyOn(
        (service as unknown as { messageRepository: { createUserAndAssistantTurn: (...args: unknown[]) => Promise<unknown> } }).messageRepository,
        'createUserAndAssistantTurn',
      )
      .mockRejectedValueOnce(error);

    await expect(service.sendMessage(auth(), conversation.conversation_id, {
      content: '另一个问题',
      client_message_id: 'client-msg-1',
    })).rejects.toMatchObject({
      code: 'CONVERSATION_MESSAGE_IDEMPOTENCY_CONFLICT',
      statusCode: 409,
    });

    expect(state.createdTaskCalls).toHaveLength(0);
    mockedCreateTurn.mockRestore();
  });

  it('continues sendMessage when default-title retitle loses a revision race', async () => {
    const conversation = baseConversation();
    const refreshedConversation = { ...conversation, revision: 2, title: '请记住项目代号是蓝鲸' };
    const userMessage = baseMessage({
      message_id: 'msg_user_2',
      role: 'user',
      status: 'completed',
      content_text: '请记住项目代号是蓝鲸',
      sequence_no: 1,
      client_message_id: 'client-msg-2',
      completed_at: '2026-01-01T00:00:00.000Z',
    });
    const assistantMessage = baseMessage({
      message_id: 'msg_assistant_2',
      role: 'assistant',
      status: 'queued',
      content_text: null,
      sequence_no: 2,
      reply_to_message_id: userMessage.message_id,
      task_run_id: null,
      client_message_id: null,
    });
    const taskRun = baseTaskRun({
      task_run_id: 'task_chat_2',
      workflow_id: 'workflow_chat_2',
      assistant_message_id: assistantMessage.message_id,
      user_message_id: userMessage.message_id,
      conversation_id: conversation.conversation_id,
      status: 'queued',
    });

    resetState({
      conversation,
      updatedConversation: refreshedConversation,
      createdTurn: {
        userMessage,
        assistantMessage,
      },
      linkedAssistant: { ...assistantMessage, task_run_id: taskRun.task_run_id },
      taskRun,
      routeResponse: baseRouteResponse({
        task_run_id: taskRun.task_run_id,
        workflow_id: taskRun.workflow_id ?? 'workflow_chat_2',
      }),
    });
    state.updateTitleError = new ConversationServiceError(
      'CONVERSATION_REVISION_CONFLICT',
      409,
      { conversation_id: conversation.conversation_id, expected_revision: 1, actual_revision: 2 },
    );

    const service = new ConversationService({
      db: {} as never,
      taskService: {
        create: vi.fn(async (input: unknown) => {
          state.createdTaskCalls.push(input);
          return state.routeResponse ?? baseRouteResponse();
        }),
      } as never,
      config: testConfig(),
    });

    const response = await service.sendMessage(auth(), conversation.conversation_id, {
      content: '请记住项目代号是蓝鲸',
      client_message_id: 'client-msg-2',
    });

    expect(response.conversation.revision).toBe(2);
    expect(response.conversation.title).toBe('请记住项目代号是蓝鲸');
    expect(response.task_run_id).toBe('task_chat_2');
    expect(state.createdTaskCalls).toHaveLength(1);
  });
});

function resetState(input: {
  conversation?: Conversation;
  createdTurn?: {
    userMessage: ConversationMessage;
    assistantMessage: ConversationMessage;
    idempotentReplay?: boolean;
  };
  updatedConversation?: Conversation;
  updateTitleError?: unknown;
  linkedAssistant?: ConversationMessage;
  taskRun?: TaskRun;
  taskRunByAssistantMessageId?: TaskRun;
  routeResponse?: RunTaskResponse;
}): void {
  state.conversation = input.conversation;
  state.updatedConversation = input.updatedConversation;
  state.updateTitleError = input.updateTitleError;
  state.getOwnedCalls = 0;
  state.createdTurn = input.createdTurn;
  state.linkedAssistant = input.linkedAssistant;
  state.taskRun = input.taskRun;
  state.taskRunByAssistantMessageId = input.taskRunByAssistantMessageId;
  state.routeResponse = input.routeResponse;
  state.createdTaskCalls.length = 0;
  state.audits.length = 0;
}

function auth(): AuthContext {
  return {
    user_id: 'user_1',
    tenant_id: 'tenant_1',
    roles: [],
    request_id: 'req_1',
  };
}

function testConfig(): RuntimeConfig {
  return {
    NODE_ENV: 'test',
    APP_ENV: 'test',
    APP_VERSION: '0.8.0',
    BUILD_SHA: 'test',
    BUILD_TIME: '2026-01-01T00:00:00Z',
    HOST: '0.0.0.0',
    DATABASE_URL: 'postgres://test',
    VALKEY_URL: 'redis://test',
    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
    MODEL_GATEWAY_BASE_URL: 'http://localhost:4100',
    MODEL_GATEWAY_API_KEY: 'test',
    MODEL_GATEWAY_MODEL: 'test',
    MODEL_GATEWAY_MODE: 'disabled',
    MODEL_GATEWAY_PROTOCOL: 'dar_generate',
    MODEL_GATEWAY_TIMEOUT_MS: 30_000,
    MODEL_GATEWAY_MAX_RETRIES: 1,
    MODEL_GATEWAY_MAX_RESPONSE_BYTES: 1_000_000,
    MODEL_GATEWAY_ALLOW_INSECURE_HTTP: true,
    MODEL_GATEWAY_IDEMPOTENCY_HEADER: 'Idempotency-Key',
    MODEL_GATEWAY_USER_AGENT: 'test',
    MODEL_CREDENTIAL_MASTER_KEY: '0'.repeat(64),
    MODEL_GATEWAY_CLIENT_CACHE_TTL_MS: 60_000,
    MODEL_CALL_LEDGER_MAX_RESPONSE_BYTES: 65_536,
    PI_AGENT_MODE: 'disabled',
    PI_CONTEXT_MAX_BYTES: 262_144,
    PI_SEGMENT_TIMEOUT_MS: 120_000,
    PI_MAX_SEGMENTS_BEFORE_CONTINUE_AS_NEW: 20,
    RUNTIME_API_AUTH_MODE: 'header',
    JWT_ISSUER: 'http://localhost:3000',
    JWT_AUDIENCE: 'durable-agent-runtime-lite',
    LOG_LEVEL: 'info',
    CONTROL_PLANE_PORT: 3000,
    RUNTIME_API_PORT: 3001,
    RUNTIME_WORKER_PORT: 3002,
    TOOL_GATEWAY_PORT: 3003,
    RUNTIME_WORKER_MODE: 'mock',
    RUNTIME_API_WORKFLOW_STARTER: 'mock',
    RUNTIME_API_ROUTE_SOURCE: 'memory',
    TOOL_GATEWAY_REGISTRY_SOURCE: 'memory',
    TOOL_GATEWAY_AUTH_MODE: 'disabled',
    CONTROL_PLANE_AUTH_MODE: 'header',
    CONTROL_PLANE_SWAGGER_ENABLED: true,
    CHAT_ENABLED: true,
    CHAT_CONTEXT_MAX_MESSAGES: 20,
    CHAT_CONTEXT_MAX_BYTES: 32_768,
    CHAT_MESSAGE_MAX_CHARS: 8_000,
    CHAT_TITLE_MAX_CHARS: 100,
    CHAT_POLL_INTERVAL_MS: 1_500,
  } as RuntimeConfig;
}

function baseConversation(): Conversation {
  return {
    conversation_id: 'conversation_1',
    tenant_id: 'tenant_1',
    owner_user_id: 'user_1',
    title: '新对话',
    status: 'active',
    revision: 1,
    next_sequence_no: 3,
    last_message_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function baseMessage(overrides: Partial<ConversationMessage>): ConversationMessage {
  return {
    message_id: 'msg_1',
    conversation_id: 'conversation_1',
    tenant_id: 'tenant_1',
    sequence_no: 1,
    role: 'user',
    status: 'completed',
    content_text: 'hello',
    client_message_id: 'client-msg-1',
    context_message_ids: [],
    context_hash: undefined,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function baseTaskRun(overrides: Partial<TaskRun>): TaskRun {
  return {
    task_run_id: 'task_1',
    tenant_id: 'tenant_1',
    user_id: 'user_1',
    route_type: 'matched',
    flow_id: 'sample_flow',
    flow_version: 1,
    workflow_id: 'workflow_1',
    status: 'running',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    conversation_id: 'conversation_1',
    user_message_id: 'msg_user_1',
    assistant_message_id: 'msg_assistant_1',
    ...overrides,
  };
}

function baseRouteResponse(overrides: Partial<RunTaskResponse> = {}): RunTaskResponse {
  return {
    task_run_id: 'task_1',
    workflow_id: 'workflow_1',
    status: 'queued',
    route_decision: {
      decision: 'matched',
      flow_id: 'sample_flow',
      flow_version: 1,
      reason: 'matched',
      confidence: 1,
    },
    flow_id: 'sample_flow',
    flow_version: 1,
    ...overrides,
  };
}
