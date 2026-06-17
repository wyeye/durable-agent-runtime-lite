import { context, trace, type Span, type Tracer } from '@opentelemetry/api';

export const TRACE_ID_HEADER = 'x-trace-id';
export const REQUEST_ID_HEADER = 'x-request-id';

export interface TraceHeaders {
  [TRACE_ID_HEADER]?: string;
  [REQUEST_ID_HEADER]?: string;
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

export function getActiveSpan(): Span | undefined {
  return trace.getSpan(context.active());
}

export function getActiveTraceId(): string | undefined {
  return getActiveSpan()?.spanContext().traceId;
}

export function createTraceHeaders(requestId?: string): TraceHeaders {
  const headers: TraceHeaders = {};
  const traceId = getActiveTraceId();

  if (traceId) {
    headers[TRACE_ID_HEADER] = traceId;
  }

  if (requestId) {
    headers[REQUEST_ID_HEADER] = requestId;
  }

  return headers;
}
