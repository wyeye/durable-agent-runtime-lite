import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { taskRunSchema } from '@dar/contracts';
import {
  closeDb,
  ConversationMessageRepository,
  ConversationRepository,
  ConversationRepositoryError,
  createDb,
  TaskRunRepository,
  TenantMembershipRepository,
  TenantRepository,
  UserAccountRepository,
  sql,
} from '../src/index.js';

const runPostgres = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const describePostgres = runPostgres ? describe : describe.skip;

describePostgres('conversation repositories with PostgreSQL', () => {
  it('creates a user/assistant turn, replays idempotently, and rejects concurrent in-flight turns', async () => {
    const db = createDb({ databaseUrl: process.env.DATABASE_URL as string });
    const suffix = randomUUID();
    const tenantId = `chat_tenant_${suffix}`;
    const userId = `chat_user_${suffix}`;
    const conversationId = `conversation_${suffix}`;
    const firstUserMessageId = `message_user_${suffix}_1`;
    const firstAssistantMessageId = `message_assistant_${suffix}_1`;
    const secondUserMessageId = `message_user_${suffix}_2`;
    const secondAssistantMessageId = `message_assistant_${suffix}_2`;
    const operatorId = 'conversation-test';

    try {
      await seedConversationOwner(db, { tenantId, userId, operatorId });

      const conversationRepository = new ConversationRepository(db);
      const messageRepository = new ConversationMessageRepository(db);
      const taskRunRepository = new TaskRunRepository(db);

      const conversation = await conversationRepository.create({
        conversationId,
        tenantId,
        ownerUserId: userId,
        title: '新对话',
      });
      expect(conversation.status).toBe('active');
      expect(conversation.next_sequence_no).toBe(1);

      const created = await messageRepository.createUserAndAssistantTurn({
        conversationId,
        tenantId,
        ownerUserId: userId,
        userMessageId: firstUserMessageId,
        assistantMessageId: firstAssistantMessageId,
        userClientMessageId: 'client-msg-1',
        userContent: '请记住项目代号是蓝鲸',
        contextMessageIds: [],
        contextHash: 'a'.repeat(64),
      });

      expect(created.idempotentReplay).toBeUndefined();
      expect(created.userMessage.sequence_no).toBe(1);
      expect(created.userMessage.status).toBe('completed');
      expect(created.userMessage.client_message_id).toBe('client-msg-1');
      expect(created.assistantMessage.sequence_no).toBe(2);
      expect(created.assistantMessage.status).toBe('queued');
      expect(created.assistantMessage.reply_to_message_id).toBe(firstUserMessageId);
      expect(created.assistantMessage.client_message_id).toBeNull();
      expect(created.assistantMessage.context_hash).toBe('a'.repeat(64));

      const replayed = await messageRepository.createUserAndAssistantTurn({
        conversationId,
        tenantId,
        ownerUserId: userId,
        userMessageId: `message_user_${suffix}_ignored`,
        assistantMessageId: `message_assistant_${suffix}_ignored`,
        userClientMessageId: 'client-msg-1',
        userContent: '请记住项目代号是蓝鲸',
        contextMessageIds: [],
        contextHash: 'a'.repeat(64),
      });

      expect(replayed.idempotentReplay).toBe(true);
      expect(replayed.userMessage.message_id).toBe(firstUserMessageId);
      expect(replayed.assistantMessage.message_id).toBe(firstAssistantMessageId);

      await expect(
        messageRepository.createUserAndAssistantTurn({
          conversationId,
          tenantId,
          ownerUserId: userId,
          userMessageId: `message_user_${suffix}_conflict`,
          assistantMessageId: `message_assistant_${suffix}_conflict`,
          userClientMessageId: 'client-msg-1',
          userContent: '这是另一条消息',
          contextMessageIds: [],
          contextHash: 'b'.repeat(64),
        }),
      ).rejects.toMatchObject({
        code: 'CONVERSATION_MESSAGE_IDEMPOTENCY_CONFLICT',
      });

      await expect(
        messageRepository.createUserAndAssistantTurn({
          conversationId,
          tenantId,
          ownerUserId: userId,
          userMessageId: secondUserMessageId,
          assistantMessageId: secondAssistantMessageId,
          userClientMessageId: 'client-msg-2',
          userContent: '第二轮现在不能开始',
          contextMessageIds: [firstUserMessageId, firstAssistantMessageId],
          contextHash: 'c'.repeat(64),
        }),
      ).rejects.toMatchObject({
        code: 'CONVERSATION_TURN_IN_PROGRESS',
      });

      const taskRun = await taskRunRepository.create({
        taskRun: taskRunSchema.parse({
          task_run_id: `task_run_${suffix}`,
          tenant_id: tenantId,
          user_id: userId,
          route_type: 'matched',
          conversation_id: conversationId,
          user_message_id: firstUserMessageId,
          assistant_message_id: firstAssistantMessageId,
          flow_id: 'sample_flow',
          flow_version: 1,
          workflow_id: `workflow_${suffix}`,
          status: 'queued',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        input: { text: '请记住项目代号是蓝鲸' },
      });

      const linked = await messageRepository.linkTaskRun(firstAssistantMessageId, {
        tenantId,
        taskRunId: taskRun.task_run_id,
        userMessageId: firstUserMessageId,
      });
      expect(linked?.task_run_id).toBe(taskRun.task_run_id);

      const completed = await messageRepository.completeAssistant({
        assistantMessageId: firstAssistantMessageId,
        tenantId,
        contentText: '我记住了，项目代号是蓝鲸。',
        taskRunId: taskRun.task_run_id,
      });
      expect(completed.status).toBe('completed');
      expect(completed.content_text).toBe('我记住了，项目代号是蓝鲸。');
      expect(completed.task_run_id).toBe(taskRun.task_run_id);

      const secondTurn = await messageRepository.createUserAndAssistantTurn({
        conversationId,
        tenantId,
        ownerUserId: userId,
        userMessageId: secondUserMessageId,
        assistantMessageId: secondAssistantMessageId,
        userClientMessageId: 'client-msg-2',
        userContent: '那你再重复一次',
        contextMessageIds: [firstUserMessageId, firstAssistantMessageId],
        contextHash: 'd'.repeat(64),
      });
      expect(secondTurn.userMessage.sequence_no).toBe(3);
      expect(secondTurn.assistantMessage.sequence_no).toBe(4);

      const messages = await messageRepository.listByConversation({
        conversationId,
        tenantId,
        ownerUserId: userId,
        order: 'oldest',
        limit: 10,
        offset: 0,
      });
      expect(messages.total).toBe(4);
      expect(messages.items.map((message) => message.sequence_no)).toEqual([1, 2, 3, 4]);
    } finally {
      await cleanupConversationFixtures(db, tenantId, userId);
      await closeDb(db);
    }
  });

  it('maps partial unique violations to stable conversation repository errors', async () => {
    const error = new ConversationRepositoryError(
      'CONVERSATION_MESSAGE_IDEMPOTENCY_CONFLICT',
      'Conversation message idempotency conflict',
      {
        conversation_id: 'conversation_1',
        client_message_id: 'client-msg-1',
      },
    );

    expect(error.code).toBe('CONVERSATION_MESSAGE_IDEMPOTENCY_CONFLICT');
    expect(error.details).toMatchObject({
      conversation_id: 'conversation_1',
      client_message_id: 'client-msg-1',
    });
  });
});

async function seedConversationOwner(
  db: ReturnType<typeof createDb>,
  input: { tenantId: string; userId: string; operatorId: string },
): Promise<void> {
  const tenants = new TenantRepository(db);
  const users = new UserAccountRepository(db);
  const memberships = new TenantMembershipRepository(db);

  await tenants.create({
    tenant_id: input.tenantId,
    display_name: `Conversation Tenant ${input.tenantId}`,
  }, input.operatorId);
  await users.create({
    user_id: input.userId,
    display_name: `Conversation User ${input.userId}`,
    email: `${input.userId}@example.test`,
    platform_roles: [],
  }, input.operatorId);
  await memberships.create({
    tenant_id: input.tenantId,
    user_id: input.userId,
    roles: [],
  }, input.operatorId);
}

async function cleanupConversationFixtures(
  db: ReturnType<typeof createDb>,
  tenantId: string,
  userId: string,
): Promise<void> {
  await sql`
    update conversation_message
    set task_run_id = null
    where tenant_id = ${tenantId}
  `.execute(db);
  await sql`delete from task_run where tenant_id = ${tenantId}`.execute(db);
  await sql`delete from conversation_message where tenant_id = ${tenantId}`.execute(db);
  await sql`delete from conversation where tenant_id = ${tenantId}`.execute(db);
  await sql`delete from tenant_membership where tenant_id = ${tenantId} and user_id = ${userId}`.execute(db);
  await sql`delete from user_account where user_id = ${userId}`.execute(db);
  await sql`delete from tenant where tenant_id = ${tenantId}`.execute(db);
}
