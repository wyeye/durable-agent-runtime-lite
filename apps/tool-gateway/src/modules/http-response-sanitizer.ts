import { adapterError } from './adapter-errors.js';

export class HttpToolResponseSanitizer {
  selectBodyPath(value: unknown, path: string | undefined): unknown {
    if (!path) {
      return value;
    }
    let cursor = value;
    for (const segment of path.split('.')) {
      if (!/^[A-Za-z0-9_-]+$/u.test(segment)) {
        throw adapterError('TOOL_HTTP_OUTPUT_SCHEMA_INVALID', 'response_body_path 仅支持简单 dot path');
      }
      if (!isRecord(cursor) || !(segment in cursor)) {
        throw adapterError('TOOL_HTTP_OUTPUT_SCHEMA_INVALID', `响应中不存在路径：${path}`);
      }
      cursor = cursor[segment];
    }
    return cursor;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
