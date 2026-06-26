import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FlowSpec, RouteSpec } from '@dar/contracts';
import type { Conversation, ConversationMessage, HumanTask, StandardResponse, TaskRun } from '@dar/contracts';
import {
  AgentContextSnapshotRepository,
  AgentRunRepository,
  closeDb,
  ConversationMessageRepository,
  ConversationRepository,
  createDb,
  FlowDefinitionRepository,
  FlowExecutionPlanRepository,
  ModelPolicyRepository,
  RouteConfigRepository,
  sql,
  TenantMembershipRepository,
  TenantRepository,
  UserAccountRepository,
  hashModelPolicy,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';
import { seedExamples } from './seed-examples.js';

const runtimeApiUrl = trimTrailingSlash(process.env.RUNTIME_API_URL ?? 'http://localhost:3000');
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';
const tenantId = process.env.SMOKE_TENANT_ID ?? `chat_smoke_${Date.now()}`;
const memberUserId = process.env.SMOKE_USER_ID ?? `chat_member_${Date.now()}`;
const operatorUserId = process.env.SMOKE_OPERATOR_USER_ID ?? `chat_operator_${Date.now()}`;
const requestPrefix = `chat_smoke_${Date.now()}`;
const resultFile = process.env.SMOKE_RESULT_PATH ?? 'artifacts/chat-mvp/result.json';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 180_000);
const masterKey = process.env.MODEL_CREDENTIAL_MASTER_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

interface ConversationSendData {
  conversation: Conversation;
  user_message: ConversationMessage;
  assistant_message: ConversationMessage;
  task_run_id?: string;
  workflow_id?: string;
}

async function main(): Promise<void> {
  const db = createDb({ databaseUrl });
  let conversationId: string | undefined;
  let firstTaskRunId: string | undefined;
  let secondTaskRunId: string | undefined;

  try {
    process.env.MODEL_CREDENTIAL_MASTER_KEY = masterKey;
    await seedExamples(databaseUrl, { tenantId });
    await seedChatActors(db);
    await seedChatScenario(db);
    await setMockScenario('conversation_memory');
    await checkHealth(`${runtimeApiUrl}/healthz`, 'runtime-api');

    const createdConversation = await postJson<Conversation>(
      `${runtimeApiUrl}/v1/conversations`,
      {},
      memberHeaders(`${requestPrefix}_create`),
    );
    conversationId = createdConversation.conversation_id;
    assert.equal(createdConversation.status, 'active');

    const firstTurn = await postJson<ConversationSendData>(
      `${runtimeApiUrl}/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        content: '请记住项目代号是蓝鲸',
        client_message_id: 'client-turn-1',
      },
      memberHeaders(`${requestPrefix}_turn1`),
    );
    firstTaskRunId = firstTurn.task_run_id;
    assert.ok(firstTaskRunId, 'first chat turn should create task_run_id');
    assert.equal(firstTurn.user_message.content_text, '请记住项目代号是蓝鲸');
    assert.equal(firstTurn.assistant_message.status, 'queued');

    const firstCompleted = await waitForConversationTurn(db, {
      conversationId,
      expectedAssistantMessageId: firstTurn.assistant_message.message_id,
      taskRunId: firstTaskRunId,
    });

    assert.equal(firstCompleted.assistant.status, 'completed');
    assert.ok(firstCompleted.assistant.content_text, 'assistant reply should be persisted');
    assert.equal(firstCompleted.taskRun?.conversation_id, conversationId);
    assert.equal(firstCompleted.taskRun?.user_id, memberUserId);
    assert.equal(firstCompleted.taskRun?.assistant_message_id, firstCompleted.assistant.message_id);

    const secondTurn = await postJson<ConversationSendData>(
      `${runtimeApiUrl}/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        content: '那你再重复一次刚才记住的项目代号',
        client_message_id: 'client-turn-2',
      },
      memberHeaders(`${requestPrefix}_turn2`),
    );
    secondTaskRunId = secondTurn.task_run_id;
    assert.ok(secondTaskRunId, 'second chat turn should create task_run_id');
    assert.deepEqual(secondTurn.assistant_message.context_message_ids, [
      firstCompleted.user.message_id,
      firstCompleted.assistant.message_id,
    ]);

    const secondCompleted = await waitForConversationTurn(db, {
      conversationId,
      expectedAssistantMessageId: secondTurn.assistant_message.message_id,
      taskRunId: secondTaskRunId,
      expectedContextMessageIds: [
        firstCompleted.user.message_id,
        firstCompleted.assistant.message_id,
      ],
    });

    assert.equal(secondCompleted.assistant.status, 'completed');
    assert.ok(
      secondCompleted.assistant.content_text?.includes('蓝鲸'),
      'second assistant reply should reflect prior conversation context',
    );

    const secondAgentRun = secondCompleted.agentRun;
    assert.ok(secondAgentRun, 'second turn should create agent run');

    const snapshotMessages = await loadLatestSnapshotMessages(db, secondAgentRun.agent_run_id);
    const snapshotText = JSON.stringify(snapshotMessages);
    assert.match(snapshotText, /蓝鲸/u);
    assert.match(snapshotText, /请记住项目代号是蓝鲸/u);

    const conversationMessages = await new ConversationMessageRepository(db).listByConversation({
      conversationId,
      tenantId,
      ownerUserId: memberUserId,
      order: 'oldest',
      limit: 20,
      offset: 0,
    });
    assert.equal(conversationMessages.total, 4);

    const result = {
      ok: true,
      scenario: 'chat-mvp',
      tenant_id: tenantId,
      conversation_id: conversationId,
      multi_turn_context_verified: true,
      ownership_enforced: true,
      runs: [
        {
          name: 'chat-turn-1',
          task_run_id: firstTaskRunId,
          workflow_id: firstCompleted.taskRun?.workflow_id,
          workflow_run_id: firstCompleted.workflowRunId,
          agent_run_id: firstCompleted.agentRun?.agent_run_id,
          agent_workflow_id: firstCompleted.agentRun?.workflow_id,
          agent_workflow_run_id: firstCompleted.agentRun?.workflow_run_id,
          user_message_id: firstCompleted.user.message_id,
          assistant_message_id: firstCompleted.assistant.message_id,
        },
        {
          name: 'chat-turn-2',
          task_run_id: secondTaskRunId,
          workflow_id: secondCompleted.taskRun?.workflow_id,
          workflow_run_id: secondCompleted.workflowRunId,
          agent_run_id: secondCompleted.agentRun?.agent_run_id,
          agent_workflow_id: secondCompleted.agentRun?.workflow_id,
          agent_workflow_run_id: secondCompleted.agentRun?.workflow_run_id,
          user_message_id: secondCompleted.user.message_id,
          assistant_message_id: secondCompleted.assistant.message_id,
          context_message_ids: secondCompleted.assistant.context_message_ids,
        },
      ],
      scenarios: {
        conversation_turn_1: {
          workflow_id: firstCompleted.taskRun?.workflow_id,
          workflow_run_id: firstCompleted.workflowRunId,
          agent_workflow_id: firstCompleted.agentRun?.workflow_id,
          agent_workflow_run_id: firstCompleted.agentRun?.workflow_run_id,
        },
        conversation_turn_2: {
          workflow_id: secondCompleted.taskRun?.workflow_id,
          workflow_run_id: secondCompleted.workflowRunId,
          agent_workflow_id: secondCompleted.agentRun?.workflow_id,
          agent_workflow_run_id: secondCompleted.agentRun?.workflow_run_id,
        },
      },
      conversation_messages: conversationMessages.items.map((message) => ({
        message_id: message.message_id,
        sequence_no: message.sequence_no,
        role: message.role,
        status: message.status,
        task_run_id: message.task_run_id,
        agent_run_id: message.agent_run_id,
      })),
    };

    await mkdir(dirname(resultFile), { recursive: true });
    await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const failure = {
      ok: false,
      scenario: 'chat-mvp',
      tenant_id: tenantId,
      conversation_id: conversationId,
      task_run_ids: [firstTaskRunId, secondTaskRunId].filter(Boolean),
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    };
    await mkdir(dirname(resultFile), { recursive: true });
    await writeFile(resultFile, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
    console.error(JSON.stringify(failure, null, 2));
    process.exitCode = 1;
  } finally {
    await closeDb(db);
  }
}

async function seedChatActors(db: ReturnType<typeof createDb>): Promise<void> {
  const tenants = new TenantRepository(db);
  const users = new UserAccountRepository(db);
  const memberships = new TenantMembershipRepository(db);

  if (!(await tenants.get(tenantId))) {
    await tenants.create({
      tenant_id: tenantId,
      display_name: `Chat Smoke ${tenantId}`,
      description: 'Chat smoke tenant',
    }, 'chat-smoke');
  }

  if (!(await users.get(memberUserId))) {
    await users.create({
      user_id: memberUserId,
      display_name: `Chat Member ${memberUserId}`,
      email: `${memberUserId}@example.test`,
      platform_roles: [],
    }, 'chat-smoke');
  }

  if (!(await memberships.get(tenantId, memberUserId))) {
    await memberships.create({
      tenant_id: tenantId,
      user_id: memberUserId,
      roles: [],
    }, 'chat-smoke');
  }

  if (!(await users.get(operatorUserId))) {
    await users.create({
      user_id: operatorUserId,
      display_name: `Chat Operator ${operatorUserId}`,
      email: `${operatorUserId}@example.test`,
      platform_roles: [],
    }, 'chat-smoke');
  }

  if (!(await memberships.get(tenantId, operatorUserId))) {
    await memberships.create({
      tenant_id: tenantId,
      user_id: operatorUserId,
      roles: ['capability_operator'],
    }, 'chat-smoke');
  }
}

async function seedChatScenario(db: ReturnType<typeof createDb>): Promise<void> {
  const promptContent = [
    '你是 Durable Agent Runtime Lite 的 Chat Smoke Agent。',
    '如果用户让你记住“项目代号是蓝鲸”，回答“已记住项目代号“蓝鲸”。”。',
    '如果用户询问项目代号，只有在对话历史里已经出现“请记住项目代号是蓝鲸”时才回答“项目代号是“蓝鲸”。”。',
    '否则回答“项目代号是“海豚”。”。',
    '不要调用任何工具。',
  ].join('\n');
  const prompt = {
    prompt_id: 'chat_memory_prompt',
    version: 1,
    name: 'Chat memory smoke prompt',
    content: promptContent,
    variables: [],
    status: 'published' as const,
  };
  await upsertPromptDefinition(db, prompt, { tenantId, status: 'published', createdBy: 'chat-smoke' });

  const modelPolicies = new ModelPolicyRepository(db);
  const sampleModelPolicy = await modelPolicies.getByIdAndVersion('sample_deterministic_final_only', 1, {
    tenantId,
  });
  assert.ok(sampleModelPolicy, 'sample model policy must exist for chat smoke');

  const agent = {
    agent_id: 'chat_memory_agent',
    version: 1,
    prompt_ref: 'chat_memory_prompt@1',
    model_policy: 'deterministic:final_only',
    model_policy_ref: {
      model_policy_id: sampleModelPolicy.model_policy_id,
      model_policy_version: sampleModelPolicy.version,
      model_policy_hash: hashModelPolicy(sampleModelPolicy),
    },
    allowed_tools: [] as string[],
    allowed_handoffs: [] as string[],
    max_steps: 4,
    max_tokens: 2000,
    output_schema: 'agent_run_result_v1',
    status: 'published' as const,
  };
  await upsertAgentSpec(db, agent, { tenantId, status: 'published', createdBy: 'chat-smoke' });

  const flow: FlowSpec = {
    flow_id: 'chat_memory_flow',
    version: 1,
    status: 'published',
    runtime: { workflow_type: 'ConfigDrivenWorkflow', task_queue: 'runtime-worker-main' },
    steps: [
      { id: 'input_normalize', type: 'activity', activity: 'input.normalize' },
      {
        id: 'chat_agent',
        type: 'agent',
        agent_id: 'chat_memory_agent',
        input: {
          agent_version: 1,
          text: '${input.text}',
        },
      },
    ],
  };
  await new FlowDefinitionRepository(db).upsert(flow, {
    tenantId,
    status: 'published',
    createdBy: 'chat-smoke',
  });
  await new FlowExecutionPlanRepository(db).createForFlow({
    tenantId,
    flowId: flow.flow_id,
    flowVersion: flow.version,
    operatorId: 'chat-smoke',
  });

  const route: RouteSpec = {
    route_id: 'chat_memory_route',
    flow_id: 'chat_memory_flow',
    version: 1,
    status: 'published',
    route: {
      priority: 100,
      keywords: ['项目代号', '蓝鲸', '记住', '重复一次'],
      examples: [
        '请记住项目代号是蓝鲸',
        '项目代号是什么？',
        '那你再重复一次刚才记住的项目代号',
      ],
      negative_examples: [],
      supported_channels: ['chat', 'web', 'api'],
      role_constraints: [],
      confidence_threshold: 0.72,
      ambiguous_threshold: 0.55,
    },
  };
  await new RouteConfigRepository(db).upsert(route, {
    tenantId,
    status: 'published',
    createdBy: 'chat-smoke',
  });
}

async function waitForConversationTurn(
  db: ReturnType<typeof createDb>,
  input: {
    conversationId: string;
    expectedAssistantMessageId: string;
    taskRunId: string;
    expectedContextMessageIds?: string[];
  },
): Promise<{
  user: ConversationMessage;
  assistant: ConversationMessage;
  taskRun?: TaskRun;
  agentRun?: Awaited<ReturnType<AgentRunRepository['get']>>;
  workflowRunId?: string;
}> {
  const deadline = Date.now() + timeoutMs;
  const messageRepository = new ConversationMessageRepository(db);
  const conversationRepository = new ConversationRepository(db);
  const agentRunRepository = new AgentRunRepository(db);

  while (Date.now() < deadline) {
    await approvePendingHumanTasks(input.taskRunId);
    const conversation = await conversationRepository.getOwned(input.conversationId, {
      tenantId,
      ownerUserId: memberUserId,
    });
    assert.ok(conversation, 'conversation should remain readable by owner');

    const assistant = await messageRepository.get(input.expectedAssistantMessageId, {
      tenantId,
      ownerUserId: memberUserId,
    });
    assert.ok(assistant, 'assistant message should exist');
    if (input.expectedContextMessageIds) {
      assert.deepEqual(assistant.context_message_ids, input.expectedContextMessageIds);
    }

    const user = assistant.reply_to_message_id
      ? await messageRepository.get(assistant.reply_to_message_id, {
          tenantId,
          ownerUserId: memberUserId,
        })
      : undefined;
    assert.ok(user, 'user message should exist');

    const taskRun = await getJson<TaskRun>(
      `${runtimeApiUrl}/v1/tasks/${encodeURIComponent(input.taskRunId)}`,
      memberHeaders(`${requestPrefix}_task_${input.taskRunId}`),
    ).catch(() => undefined);

    if (assistant.status === 'completed' && taskRun?.status === 'completed') {
      const agentRun = taskRun.assistant_message_id
        ? await agentRunRepository.list({
            tenantId,
            userId: memberUserId,
            taskRunId: input.taskRunId,
            limit: 5,
            offset: 0,
          }).then((runs) => runs[0])
        : undefined;

      const workflowRunId = await loadWorkflowRunId(db, input.taskRunId);

      const result: {
        user: ConversationMessage;
        assistant: ConversationMessage;
        taskRun?: TaskRun;
        agentRun?: Awaited<ReturnType<AgentRunRepository['get']>>;
        workflowRunId?: string;
      } = {
        user,
        assistant,
        taskRun,
        agentRun,
      };
      if (workflowRunId) {
        result.workflowRunId = workflowRunId;
      }
      return result;
    }

    if (assistant.status === 'failed' || taskRun?.status === 'failed') {
      throw new Error(`chat turn failed: assistant=${assistant.status} task=${taskRun?.status ?? 'unknown'}`);
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for chat turn ${input.taskRunId}`);
}

async function approvePendingHumanTasks(taskRunId: string): Promise<void> {
  const humanTasks = await getJson<{ human_tasks: HumanTask[] }>(
    `${runtimeApiUrl}/v1/human-tasks?tenant_id=${encodeURIComponent(tenantId)}&user_id=${encodeURIComponent(operatorUserId)}&task_run_id=${encodeURIComponent(taskRunId)}&status=pending&page_size=20`,
    operatorHeaders(`${requestPrefix}_list_human_${taskRunId}`),
  );

  for (const task of humanTasks.human_tasks) {
    if (task.kind === 'user_input') {
      await postJson(
        `${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(task.human_task_id)}/respond`,
        {
          request_id: `${requestPrefix}_respond_${task.human_task_id}`,
          response_idempotency_key: `${requestPrefix}:respond:${task.human_task_id}`,
          response: { value: 'provided by chat smoke' },
        },
        memberHeaders(`${requestPrefix}_respond_${task.human_task_id}`),
      );
      continue;
    }
    await postJson(
      `${runtimeApiUrl}/v1/human-tasks/${encodeURIComponent(task.human_task_id)}/approve`,
      {
        request_id: `${requestPrefix}_approve_${task.human_task_id}`,
        decision_reason: 'Chat smoke approval',
        payload: { smoke: true, task_run_id: taskRunId },
      },
      operatorHeaders(`${requestPrefix}_approve_${task.human_task_id}`),
    );
  }
}

async function loadWorkflowRunId(
  db: ReturnType<typeof createDb>,
  taskRunId: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom('task_run')
    .select('workflow_start_json')
    .where('task_run_id', '=', taskRunId)
    .executeTakeFirst();
  const workflowStart = row?.workflow_start_json;
  if (!workflowStart || typeof workflowStart !== 'object' || Array.isArray(workflowStart)) {
    return undefined;
  }
  const runId = (workflowStart as Record<string, unknown>).run_id;
  return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
}

async function loadLatestSnapshotMessages(
  db: ReturnType<typeof createDb>,
  agentRunId: string,
): Promise<unknown[]> {
  const row = await db
    .selectFrom('agent_context_snapshot')
    .select(['snapshot_id'])
    .where('agent_run_id', '=', agentRunId)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  if (!row?.snapshot_id) {
    return [];
  }
  const snapshot = await new AgentContextSnapshotRepository(db).get(row.snapshot_id);
  return snapshot?.messages ?? [];
}

async function checkHealth(url: string, appName: string): Promise<void> {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${appName} healthz failed: ${response.status} ${await response.text()}`);
}

async function setMockScenario(scenario: string): Promise<void> {
  const mockServerUrl = trimTrailingSlash(process.env.MOCK_SERVER_URL ?? 'http://localhost:4100');
  const response = await fetch(`${mockServerUrl}/__test/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  assert.equal(response.ok, true, `mock-server scenario switch failed: ${response.status} ${await response.text()}`);
}

async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as StandardResponse<T>;
  if (!response.ok || body.success !== true) {
    throw new Error(`POST ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, { headers });
  const body = (await response.json()) as StandardResponse<T>;
  if (!response.ok || body.success !== true) {
    throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}

function memberHeaders(requestIdValue: string): Record<string, string> {
  return {
    'x-user-id': memberUserId,
    'x-tenant-id': tenantId,
    'x-roles': '',
    'x-request-id': requestIdValue,
  };
}

function operatorHeaders(requestIdValue: string): Record<string, string> {
  return {
    'x-user-id': operatorUserId,
    'x-tenant-id': tenantId,
    'x-roles': 'capability_operator',
    'x-request-id': requestIdValue,
  };
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
