import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import {
  createLocalizedLogBindings,
  logErrorEvent,
  logEvent,
  type LoggerBindings,
} from './index.js';

function createRecordingLogger() {
  const entries: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString('utf8').trim().split('\n')) {
        if (line.length > 0) {
          entries.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
      callback();
    },
  });

  return {
    entries,
    logger: pino({ level: 'trace', base: null, timestamp: false }, stream),
  };
}

describe('@dar/logger localized log helpers', () => {
  it('creates stable event bindings with deployment-locale display message', () => {
    const context: LoggerBindings = {
      request_id: 'req_log_1',
      workflow_id: 'wf_1',
    };

    const bindings = createLocalizedLogBindings(
      'workflow.started',
      { workflow_type: 'ConfigDrivenWorkflow' },
      context,
    );

    expect(bindings).toMatchObject({
      request_id: 'req_log_1',
      workflow_id: 'wf_1',
      event_code: 'workflow.started',
      message_key: 'logs.workflowStarted',
      message: '工作流已启动。',
      locale: 'zh-CN',
      params: { workflow_type: 'ConfigDrivenWorkflow' },
    });
  });

  it('writes localized info and error messages without using the natural language as the event identity', () => {
    const { entries, logger } = createRecordingLogger();

    logEvent(logger, 'info', 'tool.committed', { tool_name: 'knowledge.search' }, { task_run_id: 'task_1' });
    logErrorEvent(logger, 'workflow.failed', new Error('raw failure'), {}, { workflow_id: 'wf_2' });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      level: 30,
      msg: '工具调用已提交。',
      message: '工具调用已提交。',
      event_code: 'tool.committed',
      message_key: 'logs.toolCommitted',
      locale: 'zh-CN',
      task_run_id: 'task_1',
    });
    expect(entries[1]).toMatchObject({
      level: 50,
      msg: '工作流执行失败。',
      message: '工作流执行失败。',
      event_code: 'workflow.failed',
      message_key: 'logs.workflowFailed',
      locale: 'zh-CN',
      workflow_id: 'wf_2',
      err: expect.objectContaining({ message: 'raw failure' }),
    });
  });
});
