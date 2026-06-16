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
}

export class ModelGatewayClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;

  constructor(options: ModelGatewayClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.apiKey = options.apiKey;
  }

  async generate(payload: ModelGenerateRequest): Promise<ModelGenerateResponse> {
    const url = new URL('/v1/generate', this.baseUrl);
    const response = await request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(modelGenerateRequestSchema.parse(payload)),
    });

    const text = await response.body.text();
    return modelGenerateResponseSchema.parse(text ? JSON.parse(text) : {});
  }
}
