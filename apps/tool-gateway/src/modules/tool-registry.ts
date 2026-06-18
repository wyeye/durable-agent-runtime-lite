import { toolManifestSchema, type ToolManifest } from '@dar/contracts';
import { ToolManifestRepository, type Database } from '@dar/db';
import type { Kysely } from 'kysely';

export interface ToolManifestRegistry {
  list(tenantId?: string): Promise<ToolManifest[]>;
  get(toolName: string, tenantId?: string, toolVersion?: string): Promise<ToolManifest | undefined>;
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
  private readonly manifests: ToolManifest[];

  constructor(manifests: ToolManifest[] = builtInToolManifests) {
    this.manifests = manifests;
  }

  async list(_tenantId?: string): Promise<ToolManifest[]> {
    return this.manifests.filter((manifest) => manifest.status === undefined || manifest.status === 'published' || manifest.status === 'gray');
  }

  async get(toolName: string, _tenantId?: string, toolVersion?: string): Promise<ToolManifest | undefined> {
    return this.manifests.find((manifest) => {
      const isExecutable = manifest.status === undefined || manifest.status === 'published' || manifest.status === 'gray';
      const versionMatches = toolVersion ? manifest.version === toolVersion : true;
      return manifest.tool_name === toolName && versionMatches && isExecutable;
    });
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

  async get(toolName: string, tenantId = 'default', toolVersion?: string): Promise<ToolManifest | undefined> {
    if (toolVersion) {
      const major = Number.parseInt(toolVersion.split('.')[0] ?? '', 10);
      if (!Number.isInteger(major) || major <= 0) {
        return undefined;
      }
      const selected = await this.repository.getByIdAndVersion(toolName, major, { tenantId });
      if (!selected || selected.spec.version !== toolVersion || (selected.status !== 'published' && selected.status !== 'gray')) {
        return undefined;
      }
      return toolManifestSchema.parse({ ...selected.spec, sha256: selected.sha256 });
    }

    const selected = await this.repository.selectVersionForRequest(toolName, { tenantId });
    return selected ? toolManifestSchema.parse({ ...selected.spec, sha256: selected.sha256 }) : undefined;
  }
}

export const ToolRegistry = InMemoryToolManifestRegistry;
