import { toolManifestSchema, type ToolManifest } from '@dar/contracts';
import type { Database } from '@dar/db';
import type { Kysely } from 'kysely';

export interface ToolManifestRegistry {
  list(): Promise<ToolManifest[]>;
  get(toolName: string): Promise<ToolManifest | undefined>;
}

export const builtInToolManifests: ToolManifest[] = [
  {
    tool_name: 'knowledge.search',
    version: '1.0.0',
    description: 'Search mock knowledge base documents.',
    risk_level: 'L1',
    side_effect: false,
    adapter: { type: 'mock', endpoint_ref: 'mock/knowledge-search' },
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
      },
    },
    output_schema: {
      type: 'object',
      required: ['items'],
    },
    required_permissions: [],
    status: 'published',
  },
  {
    tool_name: 'record.write.mock',
    version: '1.0.0',
    description: 'Write a mock record and return a deterministic record id.',
    risk_level: 'L3',
    side_effect: true,
    adapter: { type: 'mock', endpoint_ref: 'mock/record-write' },
    input_schema: {
      type: 'object',
      required: ['record'],
      properties: {
        record: { type: 'object' },
      },
    },
    output_schema: {
      type: 'object',
      required: ['record_id', 'written'],
    },
    required_permissions: [],
    status: 'published',
  },
];

export class InMemoryToolManifestRegistry implements ToolManifestRegistry {
  private readonly manifests: Map<string, ToolManifest>;

  constructor(manifests: ToolManifest[] = builtInToolManifests) {
    this.manifests = new Map(manifests.map((manifest) => [manifest.tool_name, manifest]));
  }

  async list(): Promise<ToolManifest[]> {
    return [...this.manifests.values()].filter((manifest) => manifest.status !== 'disabled');
  }

  async get(toolName: string): Promise<ToolManifest | undefined> {
    const manifest = this.manifests.get(toolName);
    return manifest?.status === 'disabled' ? undefined : manifest;
  }
}

export class DbToolManifestRegistry implements ToolManifestRegistry {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly fallback: ToolManifestRegistry = new InMemoryToolManifestRegistry(),
  ) {}

  async list(): Promise<ToolManifest[]> {
    const rows = await this.db
      .selectFrom('tool_manifest')
      .select(['spec_json'])
      .where('status', 'in', ['published', 'gray'])
      .execute();

    if (rows.length === 0) {
      return this.fallback.list();
    }

    return rows.map((row) => toolManifestSchema.parse(row.spec_json));
  }

  async get(toolName: string): Promise<ToolManifest | undefined> {
    const row = await this.db
      .selectFrom('tool_manifest')
      .select(['spec_json'])
      .where('spec_id', '=', toolName)
      .where('status', 'in', ['published', 'gray'])
      .orderBy('version', 'desc')
      .executeTakeFirst();

    if (!row) {
      return this.fallback.get(toolName);
    }

    return toolManifestSchema.parse(row.spec_json);
  }
}

export const ToolRegistry = InMemoryToolManifestRegistry;
