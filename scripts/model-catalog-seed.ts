import type { ModelDefinition, ModelDefinitionRef } from '@dar/contracts';
import {
  createDb,
  ModelDefinitionRepository,
  ModelGatewayProfileRepository,
  hashModelGatewayProfileConfig,
} from '@dar/db';

export interface EnsureModelCatalogEntryInput {
  profileId: string;
  displayName: string;
  baseUrl: string;
  authType?: 'none' | 'bearer';
  apiKey?: string;
  modelId: string;
  modelVersion?: number;
  upstreamModelId: string;
  provider: string;
  capabilities?: ModelDefinition['capabilities'];
  contextWindow?: number;
  maxOutputTokens?: number;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  currency?: string;
  tags?: string[];
  operatorId: string;
  masterKey?: string;
}

export interface EnsureModelCatalogEntryResult {
  model: ModelDefinition;
  model_ref: ModelDefinitionRef;
}

export async function ensureModelCatalogEntry(
  db: ReturnType<typeof createDb>,
  input: EnsureModelCatalogEntryInput,
): Promise<EnsureModelCatalogEntryResult> {
  const gateways = new ModelGatewayProfileRepository(db);
  const models = new ModelDefinitionRepository(db);
  const profileBase = {
    profile_id: input.profileId,
    display_name: input.displayName,
    protocol: 'openai_chat_completions' as const,
    base_url: input.baseUrl,
    auth_type: input.authType ?? (input.apiKey ? 'bearer' : 'none'),
  };
  const configHash = hashModelGatewayProfileConfig(profileBase);
  let profile = await gateways.get(input.profileId);
  if (profile) {
    if (profile.config_hash !== configHash || profile.status !== 'published') {
      throw new Error(`Model Gateway Profile seed mismatch: ${input.profileId}`);
    }
  } else {
    if (profileBase.auth_type !== 'none') {
      throw new Error('Bearer seed profiles must be created through control-plane API');
    }
    profile = await gateways.createDraft({
      ...profileBase,
      operatorId: input.operatorId,
    });
    profile = await gateways.publish(profile.profile_id, { operatorId: input.operatorId });
  }

  const version = input.modelVersion ?? 1;
  let model = await models.get(input.modelId, version);
  if (model) {
    if (
      model.status !== 'published'
      || model.gateway_profile_id !== profile.profile_id
      || model.gateway_profile_config_hash !== profile.config_hash
      || model.upstream_model_id !== input.upstreamModelId
    ) {
      throw new Error(`ModelDefinition seed mismatch: ${input.modelId}@${version}`);
    }
  } else {
    model = await models.createDraft({
      operatorId: input.operatorId,
      model: {
        model_id: input.modelId,
        version,
        display_name: input.displayName,
        gateway_profile_id: profile.profile_id,
        upstream_model_id: input.upstreamModelId,
        provider: input.provider,
        capabilities: input.capabilities ?? ['text', 'tools', 'usage'],
        context_window: input.contextWindow ?? 32768,
        max_output_tokens: input.maxOutputTokens ?? 4096,
        input_cost_per_million: input.inputCostPerMillion ?? 0,
        output_cost_per_million: input.outputCostPerMillion ?? 0,
        currency: input.currency ?? 'USD',
        tags: input.tags ?? [],
      },
    });
    model = await models.publish(model.model_id, model.version, { operatorId: input.operatorId });
  }
  return {
    model,
    model_ref: {
      model_id: model.model_id,
      version: model.version,
      model_hash: model.model_hash,
    },
  };
}
