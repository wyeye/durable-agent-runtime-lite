import { randomUUID } from 'node:crypto';
import type {
  Conversation,
  ConversationCreateRequest,
  ConversationListResponse,
  ConversationMessage,
  ConversationMessageListResponse,
  ConversationQuery,
  ConversationSendMessageRequest,
  ConversationSendMessageResponse,
  ConversationUpdateRequest,
  RunTaskResponse,
  TaskRun,
} from '@dar/contracts';
import {
  conversationCreateRequestSchema,
  conversationMessageQuerySchema,
  conversationQuerySchema,
  conversationSendMessageRequestSchema,
  conversationUpdateRequestSchema,
} from '@dar/contracts';
import {
  AuditEventRepository,
  AgentRunRepository,
  ConversationMessageRepository,
  ConversationRepository,
  TaskRunRepository,
  type Database,
} from '@dar/db';
import type { RuntimeConfig } from '@dar/config';
import type { Kysely } from 'kysely';
import type { AuthContext } from '@dar/security';
import type { TaskService } from '../task/task-service.js';
import {
  defaultConversationTitle,
  deriveConversationTitleFromMessage,
  selectConversationContext,
} from './conversation-context.js';
import {
  ConversationServiceError,
  mapConversationError,
} from './conversation-errors.js';

export interface ConversationServiceOptions {
  db: Kysely<Database>;
  taskService: TaskService;
  config: RuntimeConfig;
}

export class ConversationService {
  private readonly conversationRepository: ConversationRepository;
  private readonly messageRepository: ConversationMessageRepository;
  private readonly taskRunRepository: TaskRunRepository;
  private readonly agentRunRepository: AgentRunRepository;
  private readonly auditRepository: AuditEventRepository;

  constructor(private readonly options: ConversationServiceOptions) {
    this.conversationRepository = new ConversationRepository(options.db);
    this.messageRepository = new ConversationMessageRepository(options.db);
    this.taskRunRepository = new TaskRunRepository(options.db);
    this.agentRunRepository = new AgentRunRepository(options.db);
    this.auditRepository = new AuditEventRepository(options.db);
  }

  async list(auth: AuthContext, input: unknown): Promise<ConversationListResponse> {
    const query = conversationQuerySchema.parse(input);
    const result = await this.conversationRepository.listOwned({
      tenantId: auth.tenant_id,
      ownerUserId: auth.user_id,
      ...(query.status ? { status: query.status } : {}),
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
    return {
      items: result.items,
      page: query.page,
      page_size: query.page_size,
      total: result.total,
    };
  }

  async get(auth: AuthContext, conversationId: string): Promise<Conversation | undefined> {
    return this.conversationRepository.getOwned(conversationId, {
      tenantId: auth.tenant_id,
      ownerUserId: auth.user_id,
    });
  }

  async create(
    auth: AuthContext,
    input: ConversationCreateRequest,
  ): Promise<Conversation> {
    const parsed = conversationCreateRequestSchema.parse(input);
    const conversation = await this.conversationRepository.create({
      conversationId: createConversationId(),
      tenantId: auth.tenant_id,
      ownerUserId: auth.user_id,
      title: parsed.title ?? defaultConversationTitle(),
    });
    await this.appendAudit('conversation.created', auth, conversation, {
      conversation_id: conversation.conversation_id,
      status: conversation.status,
    });
    return conversation;
  }

  async update(
    auth: AuthContext,
    conversationId: string,
    input: ConversationUpdateRequest,
  ): Promise<Conversation> {
    try {
      const parsed = conversationUpdateRequestSchema.parse(input);
      const conversation = await this.conversationRepository.updateTitle({
        conversationId,
        tenantId: auth.tenant_id,
        ownerUserId: auth.user_id,
        title: parsed.title,
        expected_revision: parsed.expected_revision,
      });
      await this.appendAudit('conversation.renamed', auth, conversation, {
        conversation_id: conversation.conversation_id,
        status: conversation.status,
      });
      return conversation;
    } catch (error) {
      mapConversationError(error);
    }
  }

  async archive(auth: AuthContext, conversationId: string): Promise<Conversation> {
    try {
      const conversation = await this.conversationRepository.archive({
        conversationId,
        tenantId: auth.tenant_id,
        ownerUserId: auth.user_id,
      });
      await this.appendAudit('conversation.archived', auth, conversation, {
        conversation_id: conversation.conversation_id,
        status: conversation.status,
      });
      return conversation;
    } catch (error) {
      mapConversationError(error);
    }
  }

  async unarchive(auth: AuthContext, conversationId: string): Promise<Conversation> {
    try {
      const conversation = await this.conversationRepository.unarchive({
        conversationId,
        tenantId: auth.tenant_id,
        ownerUserId: auth.user_id,
      });
      await this.appendAudit('conversation.unarchived', auth, conversation, {
        conversation_id: conversation.conversation_id,
        status: conversation.status,
      });
      return conversation;
    } catch (error) {
      mapConversationError(error);
    }
  }

  async listMessages(
    auth: AuthContext,
    conversationId: string,
    input: unknown,
  ): Promise<ConversationMessageListResponse> {
    const query = conversationMessageQuerySchema.parse(input);
    await this.requireConversation(auth, conversationId);
    const result = await this.messageRepository.listByConversation({
      conversationId,
      tenantId: auth.tenant_id,
      ownerUserId: auth.user_id,
      order: query.order,
      limit: query.page_size,
      offset: (query.page - 1) * query.page_size,
    });
    const items = await Promise.all(
      result.items.map(async (message) => ({
        ...message,
        effective_status: await this.effectiveMessageStatus(auth, message),
      })),
    );
    return {
      items,
      page: query.page,
      page_size: query.page_size,
      total: result.total,
    };
  }

  async sendMessage(
    auth: AuthContext,
    conversationId: string,
    input: ConversationSendMessageRequest,
  ): Promise<ConversationSendMessageResponse> {
    const parsed = conversationSendMessageRequestSchema.parse(input);
    if (parsed.content.length > this.options.config.CHAT_MESSAGE_MAX_CHARS) {
      throw new ConversationServiceError('CONVERSATION_MESSAGE_TOO_LARGE', 422, {
        max_chars: this.options.config.CHAT_MESSAGE_MAX_CHARS,
      });
    }
    const conversation = await this.requireConversation(auth, conversationId);
    const priorMessages = await this.messageRepository.listCompletedContextMessages({
      conversationId,
      tenantId: auth.tenant_id,
      ownerUserId: auth.user_id,
      maxMessages: this.options.config.CHAT_CONTEXT_MAX_MESSAGES,
      maxBytes: this.options.config.CHAT_CONTEXT_MAX_BYTES,
    });
    const context = selectConversationContext(priorMessages, {
      maxMessages: this.options.config.CHAT_CONTEXT_MAX_MESSAGES,
      maxBytes: this.options.config.CHAT_CONTEXT_MAX_BYTES,
    });

    try {
      const created = await this.messageRepository.createUserAndAssistantTurn({
        conversationId,
        tenantId: auth.tenant_id,
        ownerUserId: auth.user_id,
        userMessageId: createConversationMessageId('user'),
        assistantMessageId: createConversationMessageId('assistant'),
        userClientMessageId: parsed.client_message_id,
        userContent: parsed.content,
        contextMessageIds: context.messageIds,
        contextHash: context.hash,
      }) as {
        userMessage: ConversationMessage;
        assistantMessage: ConversationMessage;
        idempotentReplay?: boolean;
      };
      const userMessage = created.userMessage;
      const assistantMessage = created.assistantMessage;
      const maybeRetitled = await this.maybeRetitleDefaultConversation(
        auth,
        conversation,
        parsed.content,
      );
      const replayedTaskRun = assistantMessage.task_run_id
        ? await this.taskRunRepository.get(assistantMessage.task_run_id, {
            tenantId: auth.tenant_id,
            userId: auth.user_id,
          })
        : (await this.taskRunRepository.list({
            tenantId: auth.tenant_id,
            userId: auth.user_id,
            conversationId,
          })).find((taskRun) => taskRun.assistant_message_id === assistantMessage.message_id);

      if (created.idempotentReplay) {
        const replayedAssistant = replayedTaskRun && !assistantMessage.task_run_id
          ? (await this.messageRepository.linkTaskRun(assistantMessage.message_id, {
              tenantId: auth.tenant_id,
              taskRunId: replayedTaskRun.task_run_id,
              userMessageId: userMessage.message_id,
            })) ?? assistantMessage
          : assistantMessage;
        return {
          conversation: maybeRetitled,
          user_message: userMessage,
          assistant_message: {
            ...replayedAssistant,
            effective_status: await this.effectiveMessageStatus(auth, replayedAssistant),
          },
          task_run_id: replayedTaskRun?.task_run_id,
          workflow_id: replayedTaskRun?.workflow_id,
        };
      }

      await this.appendAudit('conversation.message.accepted', auth, maybeRetitled, {
        conversation_id: conversationId,
        message_id: userMessage.message_id,
        status: assistantMessage.status,
        message_length: parsed.content.length,
        context_message_count: context.messageIds.length,
        context_hash: context.hash,
      });

      let taskResponse: RunTaskResponse;
      try {
        taskResponse = await this.options.taskService.create({
          tenant_id: auth.tenant_id,
          user_id: auth.user_id,
          request_id: auth.request_id,
          request_locale: 'zh-CN',
          channel: 'chat',
          roles: auth.roles,
          input: {
            text: parsed.content,
            payload: {
              text: parsed.content,
              conversation_id: conversationId,
              user_message_id: userMessage.message_id,
              assistant_message_id: assistantMessage.message_id,
            },
          },
          conversation_runtime: {
            conversation_id: conversationId,
            user_message_id: userMessage.message_id,
            assistant_message_id: assistantMessage.message_id,
            context_message_ids: context.messageIds,
            context_hash: context.hash,
          },
        });
      } catch (error) {
        try {
          await this.messageRepository.failAssistant({
            assistantMessageId: assistantMessage.message_id,
            tenantId: auth.tenant_id,
            errorCode: 'WORKFLOW_START_FAILED',
            errorMessageKey: 'errors.workflowStartFailed',
          });
        } catch {
          // Preserve the original workflow start error for the caller.
        }
        throw error;
      }

      const linkedTaskRun = await this.linkTaskRunIfNeeded(
        auth,
        taskResponse,
        conversationId,
        userMessage.message_id,
        assistantMessage.message_id,
      );

      const finalAssistant = await this.finalizeImmediateRouteDecisions(
        auth,
        assistantMessage.message_id,
        taskResponse,
      );

      await this.appendAudit(
        taskResponse.route_decision.decision === 'matched'
          ? 'conversation.turn.started'
          : taskResponse.status === 'failed'
            ? 'conversation.turn.failed'
            : 'conversation.turn.completed',
        auth,
        maybeRetitled,
        {
          conversation_id: conversationId,
          message_id: finalAssistant.message_id,
          task_run_id: linkedTaskRun?.task_run_id,
          status: finalAssistant.status,
          context_message_count: context.messageIds.length,
          context_hash: context.hash,
        },
      );

      return {
        conversation: maybeRetitled,
        user_message: userMessage,
        assistant_message: {
          ...finalAssistant,
          effective_status: await this.effectiveMessageStatus(auth, finalAssistant),
        },
        task_run_id: linkedTaskRun?.task_run_id,
        workflow_id: taskResponse.workflow_id,
      };
    } catch (error) {
      mapConversationError(error);
    }
  }

  private async requireConversation(
    auth: AuthContext,
    conversationId: string,
  ): Promise<Conversation> {
    const conversation = await this.conversationRepository.getOwned(conversationId, {
      tenantId: auth.tenant_id,
      ownerUserId: auth.user_id,
    });
    if (!conversation) {
      throw new ConversationServiceError('CONVERSATION_NOT_FOUND', 404, {
        conversation_id: conversationId,
      });
    }
    return conversation;
  }

  private async maybeRetitleDefaultConversation(
    auth: AuthContext,
    conversation: Conversation,
    firstMessageContent: string,
  ): Promise<Conversation> {
    if (conversation.title !== defaultConversationTitle()) {
      return conversation;
    }
    try {
      return await this.conversationRepository.updateTitle({
        conversationId: conversation.conversation_id,
        tenantId: auth.tenant_id,
        ownerUserId: auth.user_id,
        title: deriveConversationTitleFromMessage(firstMessageContent),
        expected_revision: conversation.revision,
      });
    } catch (error) {
      if (
        error instanceof ConversationServiceError
        || (typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'CONVERSATION_REVISION_CONFLICT')
      ) {
        return await this.requireConversation(auth, conversation.conversation_id);
      }
      throw error;
    }
  }

  private async linkTaskRunIfNeeded(
    auth: AuthContext,
    response: RunTaskResponse,
    conversationId: string,
    userMessageId: string,
    assistantMessageId: string,
  ): Promise<TaskRun | undefined> {
    const decision = response.route_decision.decision;
    if (decision !== 'matched' && decision !== 'agent_fallback') {
      return undefined;
    }
    const taskRun = await this.taskRunRepository.get(response.task_run_id);
    if (
      !taskRun
      || taskRun.tenant_id !== auth.tenant_id
      || taskRun.user_id !== auth.user_id
    ) {
      return undefined;
    }
    await this.messageRepository.linkTaskRun(assistantMessageId, {
      tenantId: auth.tenant_id,
      taskRunId: taskRun.task_run_id,
      userMessageId,
    });
    return taskRun;
  }

  private async finalizeImmediateRouteDecisions(
    auth: AuthContext,
    assistantMessageId: string,
    response: RunTaskResponse,
  ) {
    const decision = response.route_decision;
    if (decision.decision === 'need_clarify') {
      return this.messageRepository.completeAssistant({
        assistantMessageId,
        tenantId: auth.tenant_id,
        contentText: decision.question,
      });
    }
    if (decision.decision === 'reject') {
      return this.messageRepository.failAssistant({
        assistantMessageId,
        tenantId: auth.tenant_id,
        errorCode: 'TASK_REJECTED',
        errorMessageKey: 'errors.validationFailed',
      });
    }
    const linked = await this.messageRepository.get(assistantMessageId, {
      tenantId: auth.tenant_id,
      ownerUserId: auth.user_id,
    });
    if (!linked) {
      throw new ConversationServiceError('CONVERSATION_MESSAGE_NOT_FOUND', 404, {
        assistant_message_id: assistantMessageId,
      });
    }
    return linked;
  }

  private async effectiveMessageStatus(
    auth: AuthContext,
    message: {
    status: ConversationMessage['status'];
    task_run_id?: string | null | undefined;
    agent_run_id?: string | null | undefined;
  }): Promise<ConversationMessage['status']> {
    if (isTerminalConversationStatus(message.status)) {
      return message.status;
    }

    const agentRun = message.agent_run_id
      ? await this.agentRunRepository.get(message.agent_run_id, {
          tenantId: auth.tenant_id,
          userId: auth.user_id,
        })
      : undefined;
    const fromAgentRun = agentRun ? mapAgentRunStatus(agentRun.status, message.status) : undefined;
    if (fromAgentRun) {
      return fromAgentRun;
    }

    if (message.task_run_id) {
      const taskRun = await this.taskRunRepository.get(message.task_run_id);
      if (taskRun && taskRun.tenant_id === auth.tenant_id && taskRun.user_id === auth.user_id) {
        return mapTaskRunStatus(taskRun.status, message.status);
      }
    }

    return message.status;
  }

  private async appendAudit(
    action: string,
    auth: AuthContext,
    conversation: Conversation,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.auditRepository.append({
      event_key: `${action}:${conversation.conversation_id}:${Date.now()}`,
      tenant_id: auth.tenant_id,
      actor_id: auth.user_id,
      action,
      target_type: 'conversation',
      target_id: conversation.conversation_id,
      result: 'succeeded',
      trace_id: auth.request_id,
      payload,
    });
  }
}

function createConversationId(): string {
  return `conversation_${randomUUID().replaceAll('-', '')}`;
}

function createConversationMessageId(role: 'user' | 'assistant'): string {
  return `msg_${role}_${randomUUID().replaceAll('-', '')}`;
}

function isTerminalConversationStatus(status: ConversationMessage['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function mapAgentRunStatus(
  status: 'queued' | 'running' | 'waiting_tool' | 'waiting_human' | 'waiting_user' | 'handing_off' | 'completed' | 'failed' | 'cancelled' | 'budget_exceeded' | 'timed_out',
  fallback: ConversationMessage['status'],
): ConversationMessage['status'] | undefined {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
    case 'waiting_tool':
    case 'handing_off':
      return 'running';
    case 'waiting_human':
      return 'waiting_human';
    case 'waiting_user':
      return 'waiting_user';
    case 'completed':
      return fallback === 'queued' || fallback === 'running' ? 'running' : fallback;
    case 'failed':
    case 'cancelled':
    case 'budget_exceeded':
    case 'timed_out':
      return 'failed';
    default:
      return undefined;
  }
}

function mapTaskRunStatus(
  status: TaskRun['status'],
  fallback: ConversationMessage['status'],
): ConversationMessage['status'] {
  switch (status) {
    case 'created':
    case 'routing':
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'waiting_human':
      return 'waiting_human';
    case 'waiting_user':
      return 'waiting_user';
    case 'completed':
      return fallback === 'queued' || fallback === 'running' ? 'running' : fallback;
    case 'failed':
    case 'failed_to_start':
    case 'cancelled':
      return 'failed';
    default:
      return fallback;
  }
}
