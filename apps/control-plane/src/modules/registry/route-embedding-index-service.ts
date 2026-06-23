import type { ModelDefinition, RouteSpec } from '@dar/contracts';
import {
  ModelDefinitionRepository,
  ModelGatewayProfileRepository,
  RouteEmbeddingRepository,
  type Database,
  type RouteEmbeddingWriteInput,
} from '@dar/db';
import { OpenAICompatibleEmbeddingClient } from '@dar/model-client';
import { ModelCredentialCipher } from '@dar/security';
import type { Kysely } from 'kysely';

export interface RouteEmbeddingIndexServiceOptions {
  embeddingModelId: string;
  embeddingModelVersion: number;
  credentialMasterKey: string;
  timeoutMs: number;
  maxResponseBytes?: number;
  allowInsecureHttp: boolean;
}

export interface PreparedRouteEmbeddingIndex {
  routeId: string;
  flowVersion: number;
  routeConfigSha256: string;
  embeddingModelId: string;
  embeddingModelVersion: number;
  embeddingModelHash: string;
  sourceCount: number;
  rows: RouteEmbeddingWriteInput[];
}

interface IndexSource {
  sourceType: 'keyword' | 'example';
  sourceIndex: number;
  text: string;
}

export class RouteEmbeddingIndexService {
  private readonly models: ModelDefinitionRepository;
  private readonly profiles: ModelGatewayProfileRepository;
  private readonly cipher: ModelCredentialCipher;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: RouteEmbeddingIndexServiceOptions,
  ) {
    this.models = new ModelDefinitionRepository(db);
    this.profiles = new ModelGatewayProfileRepository(db);
    this.cipher = new ModelCredentialCipher(options.credentialMasterKey);
  }

  async prepare(
    route: RouteSpec,
    routeConfigSha256: string,
    tenantId = 'default',
  ): Promise<PreparedRouteEmbeddingIndex> {
    const model = await this.resolveEmbeddingModel();
    const profile = await this.profiles.getCredential(model.gateway_profile_id);
    if (!profile || profile.status !== 'published' || profile.config_hash !== model.gateway_profile_config_hash) {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: Gateway Profile must be published and hash-matched');
    }
    const sources = routeIndexSources(route);
    const routeId = route.route_id ?? `${route.flow_id}@${route.version}`;
    if (sources.length === 0) {
      return {
        routeId,
        flowVersion: route.version,
        routeConfigSha256,
        embeddingModelId: model.model_id,
        embeddingModelVersion: model.version,
        embeddingModelHash: model.model_hash,
        sourceCount: 0,
        rows: [],
      };
    }
    const apiKey = profile.auth_type === 'bearer'
      ? this.cipher.decrypt({
          profile_id: profile.profile_id,
          credential_revision: profile.credential_revision,
          ciphertext: requiredCredential(profile.credential_ciphertext, 'credential_ciphertext'),
          iv: requiredCredential(profile.credential_iv, 'credential_iv'),
          auth_tag: requiredCredential(profile.credential_auth_tag, 'credential_auth_tag'),
        })
      : undefined;
    const client = new OpenAICompatibleEmbeddingClient({
      baseUrl: profile.base_url,
      ...(apiKey ? { apiKey } : {}),
      timeoutMs: this.options.timeoutMs,
      maxRetries: 1,
      maxResponseBytes: this.options.maxResponseBytes ?? 2_000_000,
      allowInsecureHttp: this.options.allowInsecureHttp,
      userAgent: 'durable-agent-runtime-lite/control-plane-route-indexer',
      expectedDimensions: 1536,
    });
    const vectors = await client.embed(model.upstream_model_id, sources.map((source) => source.text));
    if (vectors.length !== sources.length) {
      throw new Error('MODEL_GATEWAY_INVALID_RESPONSE: embedding count mismatch');
    }
    return {
      routeId,
      flowVersion: route.version,
      routeConfigSha256,
      embeddingModelId: model.model_id,
      embeddingModelVersion: model.version,
      embeddingModelHash: model.model_hash,
      sourceCount: sources.length,
      rows: sources.map((source, index): RouteEmbeddingWriteInput => ({
        tenantId,
        routeId,
        flowId: route.flow_id,
        flowVersion: route.version,
        routeConfigSha256,
        sourceType: source.sourceType,
        sourceIndex: source.sourceIndex,
        sourceText: source.text,
        embedding: vectors[index] ?? [],
        embeddingModelId: model.model_id,
        embeddingModelVersion: model.version,
        embeddingModelHash: model.model_hash,
        embeddingDimensions: 1536,
      })),
    };
  }

  async replacePrepared(index: PreparedRouteEmbeddingIndex, tenantId = 'default', db: Kysely<Database> = this.db): Promise<void> {
    await new RouteEmbeddingRepository(db).replaceForRoute({
      tenantId,
      routeId: index.routeId,
      flowVersion: index.flowVersion,
      routeConfigSha256: index.routeConfigSha256,
      embeddingModelId: index.embeddingModelId,
      embeddingModelVersion: index.embeddingModelVersion,
      embeddingModelHash: index.embeddingModelHash,
      rows: index.rows,
    });
  }

  async hasRouteIndex(
    route: RouteSpec,
    routeConfigSha256: string,
    tenantId = 'default',
    db: Kysely<Database> = this.db,
  ): Promise<boolean> {
    const model = await this.resolveEmbeddingModel();
    return new RouteEmbeddingRepository(db).hasExactIndex({
      tenantId,
      routeId: route.route_id ?? `${route.flow_id}@${route.version}`,
      flowVersion: route.version,
      routeConfigSha256,
      embeddingModelId: model.model_id,
      embeddingModelVersion: model.version,
      embeddingModelHash: model.model_hash,
      expectedSourceCount: routeIndexSources(route).length,
    });
  }

  private async resolveEmbeddingModel(): Promise<ModelDefinition> {
    const model = await this.models.get(this.options.embeddingModelId, this.options.embeddingModelVersion);
    if (!model || model.status !== 'published') {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: ModelDefinition must exist and be published');
    }
    if (!model.capabilities.includes('embeddings')) {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: ModelDefinition must include embeddings capability');
    }
    if (model.embedding_dimensions !== 1536) {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: embedding_dimensions must be 1536');
    }
    return model;
  }
}

export function routeIndexSources(route: RouteSpec): IndexSource[] {
  const keywordSources = route.route.keywords
    .map((text, sourceIndex) => ({ sourceType: 'keyword' as const, sourceIndex, text: text.trim() }))
    .filter((source) => source.text.length > 0);
  const exampleSources = route.route.examples
    .map((text, sourceIndex) => ({ sourceType: 'example' as const, sourceIndex, text: text.trim() }))
    .filter((source) => source.text.length > 0);
  return [...keywordSources, ...exampleSources];
}

function requiredCredential(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`ROUTER_EMBEDDING_MODEL_INVALID: ${field} missing`);
  }
  return value;
}
