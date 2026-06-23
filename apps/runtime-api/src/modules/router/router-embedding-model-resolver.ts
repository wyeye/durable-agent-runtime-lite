import { ModelDefinitionRepository, ModelGatewayProfileRepository, type Database } from '@dar/db';
import { ModelCredentialCipher } from '@dar/security';
import { OpenAICompatibleEmbeddingClient } from '@dar/model-client';
import type { ModelDefinition, ModelDefinitionRef } from '@dar/contracts';
import type { Kysely } from 'kysely';

export interface RouterEmbeddingModelResolverOptions {
  db: Kysely<Database>;
  credentialMasterKey: string;
  modelId: string;
  modelVersion: number;
  timeoutMs: number;
  maxResponseBytes?: number;
  allowInsecureHttp: boolean;
  userAgent?: string;
}

export interface ResolvedRouterEmbeddingModel {
  model: ModelDefinition;
  modelRef: ModelDefinitionRef;
  upstreamModelId: string;
  client: OpenAICompatibleEmbeddingClient;
}

export class RouterEmbeddingModelResolver {
  private readonly models: ModelDefinitionRepository;
  private readonly profiles: ModelGatewayProfileRepository;
  private readonly cipher: ModelCredentialCipher;
  private cached?: { key: string; value: ResolvedRouterEmbeddingModel };

  constructor(private readonly options: RouterEmbeddingModelResolverOptions) {
    this.models = new ModelDefinitionRepository(options.db);
    this.profiles = new ModelGatewayProfileRepository(options.db);
    this.cipher = new ModelCredentialCipher(options.credentialMasterKey);
  }

  async resolve(): Promise<ResolvedRouterEmbeddingModel> {
    const model = await this.models.get(this.options.modelId, this.options.modelVersion);
    if (!model) {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: ModelDefinition not found');
    }
    if (model.status !== 'published') {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: ModelDefinition must be published');
    }
    if (!model.capabilities.includes('embeddings')) {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: ModelDefinition must include embeddings capability');
    }
    if (model.embedding_dimensions !== 1536) {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: embedding_dimensions must be 1536');
    }
    const profile = await this.profiles.getCredential(model.gateway_profile_id);
    if (!profile || profile.status !== 'published') {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: Gateway Profile must be published');
    }
    if (profile.config_hash !== model.gateway_profile_config_hash) {
      throw new Error('ROUTER_EMBEDDING_MODEL_INVALID: Gateway Profile config hash mismatch');
    }
    const cacheKey = [
      model.model_id,
      model.version,
      model.model_hash,
      profile.profile_id,
      profile.config_hash,
      profile.credential_revision,
    ].join(':');
    if (this.cached?.key === cacheKey) {
      return this.cached.value;
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
    const value: ResolvedRouterEmbeddingModel = {
      model,
      modelRef: {
        model_id: model.model_id,
        version: model.version,
        model_hash: model.model_hash,
      },
      upstreamModelId: model.upstream_model_id,
      client: new OpenAICompatibleEmbeddingClient({
        baseUrl: profile.base_url,
        ...(apiKey ? { apiKey } : {}),
        timeoutMs: this.options.timeoutMs,
        maxRetries: 1,
        maxResponseBytes: this.options.maxResponseBytes ?? 2_000_000,
        allowInsecureHttp: this.options.allowInsecureHttp,
        userAgent: this.options.userAgent ?? 'durable-agent-runtime-lite/runtime-api-router',
        expectedDimensions: 1536,
      }),
    };
    this.cached = { key: cacheKey, value };
    return value;
  }
}

function requiredCredential(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`ROUTER_EMBEDDING_MODEL_INVALID: ${field} missing`);
  }
  return value;
}
