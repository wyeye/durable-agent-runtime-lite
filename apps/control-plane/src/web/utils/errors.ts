import type { RuntimeError } from '@dar/contracts';
import { ApiError } from '../api/client.js';

export interface FriendlyError {
  title: string;
  description: string;
  code?: string;
  status?: number;
  details?: unknown;
}

export function toFriendlyError(error: unknown): FriendlyError {
  if (error instanceof ApiError) {
    return {
      title: titleForStatus(error.status),
      description: error.message,
      code: error.code,
      status: error.status,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return {
      title: '操作失败',
      description: error.message,
    };
  }
  return {
    title: '操作失败',
    description: '未知错误',
  };
}

export function errorFromRuntime(error: RuntimeError): FriendlyError {
  return {
    title: '接口返回错误',
    description: error.message,
    code: error.code,
    details: error.details,
  };
}

function titleForStatus(status: number): string {
  if (status === 400) {
    return '请求格式错误';
  }
  if (status === 401) {
    return '缺少身份';
  }
  if (status === 403) {
    return '权限不足';
  }
  if (status === 404) {
    return '资源不存在';
  }
  if (status === 409) {
    return '版本冲突';
  }
  if (status === 422) {
    return '校验未通过';
  }
  if (status === 503) {
    return '下游服务不可用';
  }
  return '服务端错误';
}
