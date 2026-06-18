import { request } from 'undici';
import { z } from 'zod';

export const modelGenerateRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.string(),
    }),
  ),
  response_schema: z.record(z.string(), z.unknown()).optional(),
  max_tokens: z.number().int().positive().optional(),
  request_id: z.string().optional(),
  task_run_id: z.string().optional(),
  agent_run_id: z.string().optional(),
  signal: z.instanceof(AbortSignal).optional(),
});

export const modelGenerateResponseSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export type ModelGenerateRequest = z.infer<typeof modelGenerateRequestSchema>;
export type ModelGenerateResponse = z.infer<typeof modelGenerateResponseSchema>;

export interface ModelGatewayClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxResponseBytes?: number;
}

export class ModelGatewayClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxResponseBytes: number;

  constructor(options: ModelGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  }

  async generate(payload: ModelGenerateRequest): Promise<ModelGenerateResponse> {
    const parsed = modelGenerateRequestSchema.parse(payload);
    const { signal, ...requestPayload } = parsed;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.requestGenerate(requestPayload, signal);
      } catch (error) {
        lastError = error;
        if (!isRetryableModelGatewayError(error) || attempt >= this.maxRetries || signal?.aborted) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Model Gateway request failed');
  }

  private async requestGenerate(
    payload: Omit<ModelGenerateRequest, 'signal'>,
    signal?: AbortSignal,
  ): Promise<ModelGenerateResponse> {
    const url = new URL('/v1/generate', this.baseUrl);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: requestSignal,
    });

    const text = await response.body.text();
    if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
      throw new ModelGatewayError('MODEL_GATEWAY_RESPONSE_TOO_LARGE', 'Model Gateway response exceeded size limit');
    }
    if (response.statusCode === 429) {
      throw new ModelGatewayError('MODEL_GATEWAY_RATE_LIMITED', 'Model Gateway rate limited request');
    }
    if (response.statusCode >= 500) {
      throw new ModelGatewayError('MODEL_GATEWAY_UPSTREAM_FAILED', 'Model Gateway upstream failed');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ModelGatewayError('MODEL_GATEWAY_REQUEST_FAILED', 'Model Gateway request failed');
    }
    return modelGenerateResponseSchema.parse(text ? JSON.parse(text) : {});
  }
}

export class ModelGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModelGatewayError';
  }
}

function isRetryableModelGatewayError(error: unknown): boolean {
  return error instanceof ModelGatewayError
    ? error.code === 'MODEL_GATEWAY_RATE_LIMITED' || error.code === 'MODEL_GATEWAY_UPSTREAM_FAILED'
    : true;
}
