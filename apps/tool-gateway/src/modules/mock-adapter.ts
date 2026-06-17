import { createHash } from 'node:crypto';

export interface MockAdapterInput {
  toolName: string;
  args: Record<string, unknown>;
}

export async function invokeMockAdapter(input: MockAdapterInput): Promise<unknown> {
  if (input.toolName === 'knowledge.search') {
    const query = String(input.args.query ?? '');
    return {
      items: [
        {
          id: 'kb_001',
          title: 'Mock knowledge result',
          content: `Result for: ${query}`,
          score: 0.92,
        },
      ],
    };
  }

  if (input.toolName === 'record.write.mock') {
    const hash = createHash('sha256').update(JSON.stringify(input.args.record ?? {})).digest('hex').slice(0, 16);
    return {
      record_id: `rec_${hash}`,
      written: true,
      preview: false,
    };
  }

  throw new Error(`Unsupported mock tool: ${input.toolName}`);
}
