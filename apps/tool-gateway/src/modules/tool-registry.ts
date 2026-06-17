import { toolManifestSchema, type ToolManifest } from '@dar/contracts';
import { ToolManifestRepository, type Database } from '@dar/db';
import type { Kysely } from 'kysely';

export interface ToolManifestRegistry {
  list(tenantId?: string): Promise<ToolManifest[]>;
  get(toolName: string, tenantId?: string): Promise<ToolManifest | undefined>;
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

  async list(_tenantId?: string): Promise<ToolManifest[]> {
    return [...this.manifests.values()].filter((manifest) => manifest.status !== 'disabled');
  }

  async get(toolName: string, _tenantId?: string): Promise<ToolManifest | undefined> {
    const manifest = this.manifests.get(toolName);
    return manifest?.status === 'disabled' ? undefined : manifest;
  }
}

export class DbToolManifestRegistry implements ToolManifestRegistry {
  private readonly repository: ToolManifestRepository;

  constructor(db: Kysely<Database>) {
    this.repository = new ToolManifestRepository(db);
  }

  async list(tenantId = 'default'): Promise<ToolManifest[]> {
    const manifests = await this.repository.listPublished({ tenantId });
    return manifests.map((manifest) => toolManifestSchema.parse(manifest));
  }

  async get(toolName: string, tenantId = 'default'): Promise<ToolManifest | undefined> {
    const manifest = await this.repository.getPublished(toolName, { tenantId });
    return manifest ? toolManifestSchema.parse(manifest) : undefined;
  }
}

export const ToolRegistry = InMemoryToolManifestRegistry;
