import assert from 'node:assert/strict';
import { loadConfig } from '@dar/config';
import { buildDbFlowSnapshotRef, closeDb, createDb, TaskRunRepository } from '@dar/db';
import { buildServer } from '../../../../apps/runtime-api/src/index.js';
import { createRuntimeApiTaskService } from '../../../../apps/runtime-api/src/modules/task/task-service.js';
import { seedExamples } from './seed-examples.js';

const smokeTenantId = process.env.SMOKE_TENANT_ID ?? `smoke_db_registry_${Date.now()}`;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for db-registry smoke');
  }

  await seedExamples(databaseUrl, { tenantId: smokeTenantId });

  const runtimeApi = createRuntimeApiTaskService(loadConfig({
    ...process.env,
    DATABASE_URL: databaseUrl,
    RUNTIME_API_WORKFLOW_STARTER: 'mock',
  }));
  const server = buildServer(runtimeApi.taskService);
  const db = createDb({ databaseUrl });

  try {
    const preview = await server.inject({
      method: 'POST',
      url: '/v1/router/preview',
      payload: {
        tenant_id: smokeTenantId,
        user_id: 'smoke_user',
        request_id: 'smoke_preview',
        input: { text: '请执行 mvp 示例流程' },
      },
    });
    assert.equal(preview.statusCode, 200);
    const previewBody = preview.json();
    assert.equal(previewBody.data.route_decision.decision, 'matched');
    assert.equal(previewBody.data.route_decision.flow_id, 'sample_flow');
    assert.equal(previewBody.data.route_decision.flow_version, 1);

    const createTask = await server.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        tenant_id: smokeTenantId,
        user_id: 'smoke_user',
        request_id: 'smoke_task',
        input: { text: '请执行 mvp 示例流程' },
      },
    });
    assert.equal(createTask.statusCode, 200);
    const createTaskBody = createTask.json();
    assert.equal(createTaskBody.data.workflow_start.mode, 'mock');
    assert.equal(createTaskBody.data.flow_id, 'sample_flow');
    assert.equal(createTaskBody.data.flow_version, 1);
    assert.equal(
      createTaskBody.data.workflow_start.started,
      true,
      'mock workflow starter should report started=true',
    );

    const storedTaskRun = await new TaskRunRepository(db).get(createTaskBody.data.task_run_id);
    assert.ok(storedTaskRun, 'task_run should be written to DB');
    assert.equal(storedTaskRun.flow_id, 'sample_flow');
    assert.equal(buildDbFlowSnapshotRef('sample_flow', 1), 'db://flow/sample_flow/versions/1');

    console.log('db-registry smoke succeeded');
  } finally {
    await server.close();
    await runtimeApi.close();
    await closeDb(db);
  }
}

main().catch((error: unknown) => {
  console.error('db-registry smoke failed');
  console.error(error);
  process.exit(1);
});
