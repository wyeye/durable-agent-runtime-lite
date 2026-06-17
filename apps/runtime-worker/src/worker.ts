import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { RuntimeConfig } from '@dar/config';
import { loadConfig } from '@dar/config';
import { createLogger } from '@dar/logger';
import { TASK_QUEUES } from '@dar/temporal';
import * as activities from './activities/index.js';

const logger = createLogger('runtime-worker');

export type TemporalWorkerHandle =
  | { mode: 'mock'; taskQueue: string }
  | { mode: 'temporal'; taskQueue: string; worker: Worker };

export async function startTemporalWorker(config: RuntimeConfig = loadConfig()): Promise<TemporalWorkerHandle> {
  if (config.RUNTIME_WORKER_MODE !== 'temporal') {
    logger.info({ task_queue: TASK_QUEUES.runtimeWorkerMain }, 'temporal worker mock started');
    return { mode: 'mock', taskQueue: TASK_QUEUES.runtimeWorkerMain };
  }

  const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: TASK_QUEUES.runtimeWorkerMain,
    workflowsPath: fileURLToPath(new URL('./workflows/index.js', import.meta.url)),
    activities,
  });

  worker.run().catch((error: unknown) => {
    logger.error({ err: error, task_queue: TASK_QUEUES.runtimeWorkerMain }, 'temporal worker stopped unexpectedly');
  });

  logger.info({ task_queue: TASK_QUEUES.runtimeWorkerMain }, 'temporal worker started');
  return { mode: 'temporal', taskQueue: TASK_QUEUES.runtimeWorkerMain, worker };
}
