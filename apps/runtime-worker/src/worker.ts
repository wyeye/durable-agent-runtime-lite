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
  | { mode: 'mock'; taskQueue: string; state: WorkerRuntimeState; shutdown(): Promise<void> }
  | {
      mode: 'temporal';
      taskQueue: string;
      worker: Worker;
      connection: NativeConnection;
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
    logger.info({ task_queue: TASK_QUEUES.runtimeWorkerMain }, 'temporal worker mock started');
    return {
      mode: 'mock',
      taskQueue: TASK_QUEUES.runtimeWorkerMain,
      state: { status: 'running', ready: true },
      shutdown: async () => undefined,
    };
  }

  const state: WorkerRuntimeState = { status: 'starting', ready: false };
  const db = createDb({ databaseUrl: config.DATABASE_URL });
  activities.configureActivityDb(db);
  const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUES.runtimeWorkerMain,
    workflowsPath: fileURLToPath(new URL('./workflows/index.js', import.meta.url)),
    activities,
  });

  const runPromise = worker.run();
  state.status = 'running';
  state.ready = true;
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

  logger.info({ task_queue: TASK_QUEUES.runtimeWorkerMain }, 'temporal worker started');
  return {
    mode: 'temporal',
    taskQueue: TASK_QUEUES.runtimeWorkerMain,
    worker,
    connection,
    state,
    shutdown: async () => {
      if (state.status === 'stopping' || state.status === 'stopped') {
        return;
      }
      state.status = 'stopping';
      state.ready = false;
      worker.shutdown();
      await runPromise.catch(() => undefined);
      await connection.close();
      await activities.shutdownActivityResources();
      state.status = 'stopped';
    },
  };
}

function isProductionRuntime(config: RuntimeConfig): boolean {
  return config.NODE_ENV === 'production' || config.APP_ENV === 'production';
}
