import type { RuntimeError } from '@dar/contracts';
import { ApiError } from '../api/client.js';

export interface FriendlyError {
  title: string;
  description: string;
  code?: string;
  status?: number;
  details?: unknown;
  validationIssues?: string[];
  validationModal?: {
    title: string;
    issues: string[];
    description: string;
  };
}

export function toFriendlyError(error: unknown): FriendlyError {
  if (error instanceof ApiError) {
    const validationIssues = validationIssuesFromDetails(error.details);
    return {
      title: titleForStatus(error.status),
      description: error.message,
      code: error.code,
      status: error.status,
      details: error.details,
      ...(validationIssues ? { validationIssues } : {}),
      ...(validationIssues?.length ? {
        validationModal: {
          title: '校验未通过',
          issues: validationIssues,
          description: error.message,
        },
      } : {}),
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

export function validationFeedback(result: {
  can_publish: boolean;
  errors: Array<unknown>;
  warnings: Array<unknown>;
}): {
  type: 'success' | 'warning';
  content: string;
} {
  if (result.can_publish) {
    return {
      type: 'success',
      content: result.warnings.length > 0 ? '校验通过，存在警告' : '校验通过',
    };
  }

  return {
    type: 'warning',
    content: result.errors.length > 0 ? '校验完成，但暂不可发布' : '校验完成，请关注警告',
  };
}

function validationIssuesFromDetails(details: unknown): string[] | undefined {
  const validation = isRecord(details) ? details.validation : undefined;
  const errors = isRecord(validation) && Array.isArray(validation.errors) ? validation.errors : undefined;
  if (!errors?.length) {
    return undefined;
  }
  return errors
    .map((issue) => {
      if (!isRecord(issue)) {
        return undefined;
      }
      const code = typeof issue.code === 'string' ? issue.code : 'VALIDATION_ERROR';
      const path = typeof issue.path === 'string' && issue.path.length > 0 ? ` ${issue.path}` : '';
      const message = typeof issue.message === 'string' ? issue.message : '校验错误';
      return `${code}${path}：${message}`;
    })
    .filter((item): item is string => Boolean(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
