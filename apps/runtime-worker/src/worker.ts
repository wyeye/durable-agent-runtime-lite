import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { RuntimeConfig } from '@dar/config';
import { loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { TASK_QUEUES } from '@dar/temporal';
import { createDb } from '@dar/db';
import * as activities from './activities/index.js';

const logger = createLogger('runtime-worker');

export type TemporalWorkerHandle =
  | {
      mode: 'mock';
      taskQueue: string;
      taskQueues: string[];
      evaluationTaskQueue?: string;
      evaluationState?: WorkerRuntimeState;
      state: WorkerRuntimeState;
      shutdown(): Promise<void>;
    }
  | {
      mode: 'temporal';
      taskQueue: string;
      taskQueues: string[];
      evaluationTaskQueue?: string;
      worker: Worker;
      evaluationWorker?: Worker;
      connection: NativeConnection;
      evaluationState?: WorkerRuntimeState;
      state: WorkerRuntimeState;
      shutdown(): Promise<void>;
    };

export interface WorkerRuntimeState {
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  ready: boolean;
  error?: string;
}

export async function startTemporalWorker(config: RuntimeConfig = loadConfig()): Promise<TemporalWorkerHandle> {
  if (config.RUNTIME_WORKER_MODE !== 'temporal') {
    if (isProductionRuntime(config)) {
      throw new Error('RUNTIME_WORKER_MODE=temporal is required in production');
    }
    logger.info({
      task_queue: TASK_QUEUES.runtimeWorkerMain,
      evaluation_worker_enabled: config.EVALUATION_WORKER_ENABLED,
      evaluation_task_queue: config.EVALUATION_TASK_QUEUE,
    }, 'temporal worker mock started');
    return {
      mode: 'mock',
      taskQueue: TASK_QUEUES.runtimeWorkerMain,
      taskQueues: config.EVALUATION_WORKER_ENABLED
        ? [TASK_QUEUES.runtimeWorkerMain, config.EVALUATION_TASK_QUEUE]
        : [TASK_QUEUES.runtimeWorkerMain],
      ...(config.EVALUATION_WORKER_ENABLED ? {
        evaluationTaskQueue: config.EVALUATION_TASK_QUEUE,
        evaluationState: { status: 'running', ready: true },
      } : {}),
      state: { status: 'running', ready: true },
      shutdown: async () => undefined,
    };
  }

  const state: WorkerRuntimeState = { status: 'starting', ready: false };
  const evaluationState: WorkerRuntimeState | undefined = config.EVALUATION_WORKER_ENABLED
    ? { status: 'starting', ready: false }
    : undefined;
  const db = createDb({ databaseUrl: config.DATABASE_URL });
  activities.configureActivityDb(db);
  const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  const workflowsPath = fileURLToPath(new URL('./workflows/index.js', import.meta.url));
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUES.runtimeWorkerMain,
    workflowsPath,
    activities,
  });
  const evaluationWorker = evaluationState
    ? await Worker.create({
        connection,
        namespace: config.TEMPORAL_NAMESPACE,
        taskQueue: config.EVALUATION_TASK_QUEUE,
        workflowsPath,
        activities,
      })
    : undefined;

  const runPromise = worker.run();
  const evaluationRunPromise = evaluationWorker?.run();
  state.status = 'running';
  state.ready = true;
  if (evaluationState) {
    evaluationState.status = 'running';
    evaluationState.ready = true;
  }
  runPromise.catch((error: unknown) => {
    state.status = 'failed';
    state.ready = false;
    state.error = error instanceof Error ? error.message : 'Temporal worker stopped unexpectedly';
    logger.error({ err: error, task_queue: TASK_QUEUES.runtimeWorkerMain }, 'temporal worker stopped unexpectedly');
  }).finally(() => {
    if (state.status !== 'failed') {
      state.status = 'stopped';
      state.ready = false;
    }
  });
  evaluationRunPromise?.catch((error: unknown) => {
    if (!evaluationState) {
      return;
    }
    evaluationState.status = 'failed';
    evaluationState.ready = false;
    evaluationState.error = error instanceof Error ? error.message : 'Evaluation temporal worker stopped unexpectedly';
    logger.error({ err: error, task_queue: config.EVALUATION_TASK_QUEUE }, 'evaluation temporal worker stopped unexpectedly');
  }).finally(() => {
    if (!evaluationState) {
      return;
    }
    if (evaluationState.status !== 'failed') {
      evaluationState.status = 'stopped';
      evaluationState.ready = false;
    }
  });

  const taskQueues = evaluationWorker
    ? [TASK_QUEUES.runtimeWorkerMain, config.EVALUATION_TASK_QUEUE]
    : [TASK_QUEUES.runtimeWorkerMain];
  logger.info({
    task_queue: TASK_QUEUES.runtimeWorkerMain,
    evaluation_worker_enabled: Boolean(evaluationWorker),
    evaluation_task_queue: evaluationWorker ? config.EVALUATION_TASK_QUEUE : undefined,
  }, 'temporal worker started');

  const baseHandle = {
    mode: 'temporal',
    taskQueue: TASK_QUEUES.runtimeWorkerMain,
    taskQueues,
    worker,
    connection,
    state,
    shutdown: async () => {
      if (state.status === 'stopping' || state.status === 'stopped') {
        return;
      }
      state.status = 'stopping';
      state.ready = false;
      if (evaluationState) {
        evaluationState.status = 'stopping';
        evaluationState.ready = false;
      }
      evaluationWorker?.shutdown();
      worker.shutdown();
      await evaluationRunPromise?.catch(() => undefined);
      await runPromise.catch(() => undefined);
      await connection.close();
      await activities.shutdownActivityResources();
      state.status = 'stopped';
      if (evaluationState) {
        evaluationState.status = 'stopped';
      }
    },
  } satisfies Omit<Extract<TemporalWorkerHandle, { mode: 'temporal' }>, 'evaluationTaskQueue' | 'evaluationWorker' | 'evaluationState'>;

  if (evaluationWorker && evaluationState) {
    return {
      ...baseHandle,
      evaluationTaskQueue: config.EVALUATION_TASK_QUEUE,
      evaluationWorker,
      evaluationState,
    };
  }

  return baseHandle;
}

function isProductionRuntime(config: RuntimeConfig): boolean {
  return config.NODE_ENV === 'production' || config.APP_ENV === 'production';
}
