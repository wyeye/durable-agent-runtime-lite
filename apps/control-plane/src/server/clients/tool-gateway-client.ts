import type { AuditEvent, ToolCallLog } from '@dar/contracts';
import { maskSensitiveFields } from '@dar/security';
import type { ForwardHeaders } from './http-client.js';
import { DownstreamClient } from './http-client.js';

export interface ToolGatewayOperationsClient {
  listAuditEvents(query: URLSearchParams, headers: ForwardHeaders): Promise<AuditEvent[]>;
  listToolCalls(query: URLSearchParams, headers: ForwardHeaders): Promise<ToolCallLog[]>;
  getToolCall(toolCallId: string, headers: ForwardHeaders): Promise<ToolCallLog>;
}

export class ToolGatewayClient implements ToolGatewayOperationsClient {
  private readonly client: DownstreamClient;

  constructor(baseUrl: string, timeoutMs?: number) {
    this.client = new DownstreamClient({
      baseUrl,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  async listAuditEvents(query: URLSearchParams, headers: ForwardHeaders): Promise<AuditEvent[]> {
    const events = await this.client.get<AuditEvent[]>(`/v1/audit-events?${query.toString()}`, headers);
    return events.map((event) => ({ ...event, payload: maskSensitiveFields(event.payload) as Record<string, unknown> }));
  }

  async listToolCalls(query: URLSearchParams, headers: ForwardHeaders): Promise<ToolCallLog[]> {
    const calls = await this.client.get<ToolCallLog[]>(`/v1/tool-calls?${query.toString()}`, headers);
    return calls.map(maskToolCall);
  }

  async getToolCall(toolCallId: string, headers: ForwardHeaders): Promise<ToolCallLog> {
    return maskToolCall(await this.client.get<ToolCallLog>(`/v1/tool-calls/${encodeURIComponent(toolCallId)}`, headers));
  }
}

function maskToolCall(call: ToolCallLog): ToolCallLog {
  return {
    ...call,
    preview_json: call.preview_json === undefined ? undefined : maskSensitiveFields(call.preview_json),
    result_json: call.result_json === undefined ? undefined : maskSensitiveFields(call.result_json),
  };
}
