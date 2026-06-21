import { describe, expect, it } from 'vitest';
import {
  localizeError,
  localizeZodIssues,
  parseAcceptLanguage,
  resolveLocale,
  translate,
} from './index.js';

describe('@dar/i18n locale contract', () => {
  it('defaults to zh-CN and maps zh variants', () => {
    expect(resolveLocale(undefined)).toBe('zh-CN');
    expect(resolveLocale('zh')).toBe('zh-CN');
    expect(resolveLocale('zh_cn')).toBe('zh-CN');
    expect(resolveLocale('ZH-cn')).toBe('zh-CN');
  });

  it('falls back to zh-CN for unsupported and unsafe Accept-Language headers', () => {
    expect(resolveLocale('en-US,en;q=0.8')).toBe('zh-CN');
    expect(resolveLocale('bad\r\nx: y')).toBe('zh-CN');
    expect(parseAcceptLanguage('zh-CN;q=0.8,en-US;q=0.9')[0]).toMatchObject({ raw: 'en-US', q: 0.9 });
  });

  it('translates errors with stable code and message key', () => {
    expect(localizeError({ code: 'EVALUATION_GATE_STALE' })).toMatchObject({
      code: 'EVALUATION_GATE_STALE',
      message_key: 'errors.evaluationGateStale',
      message: '当前评测结论已失效，请重新发起评测。',
      locale: 'zh-CN',
    });
  });

  it('maps public runtime and tool errors to explicit zh-CN messages', () => {
    expect(localizeError({ code: 'HUMAN_CONFIRMATION_REQUIRED' })).toMatchObject({
      code: 'HUMAN_CONFIRMATION_REQUIRED',
      message_key: 'errors.humanConfirmationRequired',
      message: '该操作需要人工确认。',
    });
    expect(localizeError({ code: 'EVALUATION_RUN_NOT_FOUND' })).toMatchObject({
      code: 'EVALUATION_RUN_NOT_FOUND',
      message_key: 'errors.evaluationRunNotFound',
      message: '评测任务不存在。',
    });
    expect(localizeError({ code: 'TOOL_CALL_NOT_FOUND' })).toMatchObject({
      code: 'TOOL_CALL_NOT_FOUND',
      message_key: 'errors.toolCallNotFound',
      message: '工具调用记录不存在。',
    });
  });

  it('localizes zod-like issues without echoing sensitive input', () => {
    const issues = localizeZodIssues([
      { code: 'invalid_type', path: ['input', 'name'], input: undefined },
      { code: 'too_small', path: ['items'], minimum: 1, input: 'secret-token' },
    ]);
    expect(issues[0]).toMatchObject({
      path: 'input.name',
      code: 'invalid_type',
      message_key: 'common.validation.required',
      message: '请输入必填字段。',
    });
    expect(JSON.stringify(issues)).not.toContain('secret-token');
  });

  it('uses shared zh-CN resources', () => {
    expect(translate('navigation.dashboard')).toBe('运营总览');
  });
});
