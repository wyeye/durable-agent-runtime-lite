import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/index.js';

describe('mock server test control endpoints', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAppEnv = process.env.APP_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.APP_ENV = originalAppEnv;
  });

  it('resets and reports centralized test state outside production', async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    const server = buildServer();
    await server.inject({ method: 'POST', url: '/__test/scenario', payload: { scenario: 'final_only' } });
    const stats = await server.inject({ method: 'GET', url: '/__test/stats' });
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toMatchObject({ current_scenario: 'final_only' });
    const reset = await server.inject({ method: 'POST', url: '/__test/reset' });
    expect(reset.statusCode).toBe(200);
    const afterReset = await server.inject({ method: 'GET', url: '/__test/stats' });
    expect(afterReset.json()).toMatchObject({ current_scenario: null });
  });

  it('does not expose test control endpoints in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_ENV = 'production';
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/__test/stats' });
    expect(response.statusCode).toBe(404);
  });

  it('serves the HTTP readonly tool scenario from the centralized model mock', async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'model_gateway:readonly_tool',
        messages: [{ role: 'user', content: 'http_readonly_tool' }],
        tools: [{ type: 'function', function: { name: 'tool_company_policy_lookup_ea6052dad376' } }],
      },
    });
    expect(response.statusCode).toBe(200);
    const toolCall = response.json().choices[0].message.tool_calls[0];
    expect(toolCall.function.name).toBe('tool_company_policy_lookup_ea6052dad376');
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ query: '差旅报销政策' });

    const final = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'model_gateway:readonly_tool',
        messages: [
          { role: 'user', content: 'http_readonly_tool' },
          { role: 'tool', content: '{"items":[{"summary":"差旅费用可按制度提交报销"}]}' },
        ],
      },
    });
    expect(final.json().choices[0].message.content).toContain('差旅报销政策摘要');
  });

  it('uses a prompt-provided handoff execution plan ref', async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'model_gateway:handoff',
        messages: [{ role: 'user', content: 'handoff handoff_ref:db://flow-execution-plan/plan_test' }],
        tools: [{ type: 'function', function: { name: 'handoff_to_workflow' } }],
      },
    });
    expect(response.statusCode).toBe(200);
    const args = JSON.parse(response.json().choices[0].message.tool_calls[0].function.arguments);
    expect(args.target_execution_plan_ref).toBe('db://flow-execution-plan/plan_test');
  });

  it('extracts handoff refs from prompt text without JSON tail leakage', async () => {
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
    const server = buildServer();
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'model_gateway:handoff',
        messages: [
          { role: 'system', content: 'You are a Pi smoke agent. Scenario: handoff.' },
          {
            role: 'user',
            content: 'handoff smoke request handoff_ref:db://flow-execution-plan/plan_handoff_test',
          },
        ],
        tools: [{ type: 'function', function: { name: 'handoff_to_workflow' } }],
      },
    });
    expect(response.statusCode).toBe(200);
    const args = JSON.parse(response.json().choices[0].message.tool_calls[0].function.arguments);
    expect(args.target_execution_plan_ref).toBe('db://flow-execution-plan/plan_handoff_test');
  });
});
