import { request } from 'undici';
import type {
  ModelDefinition,
  ModelDefinitionQuery,
  ModelDefinitionUpdateDraftRequest,
  ModelGatewayConnectionTestResponse,
  ModelGatewayProfileQuery,
  ModelGatewayProfile,
  ModelGatewayProfileCreateRequest,
  ModelGatewayProfileUpdateDraftRequest,
} from '@dar/contracts';
import {
  modelDefinitionCreateDraftRequestSchema,
  modelDefinitionUpdateDraftRequestSchema,
  modelGatewayConnectionTestResponseSchema,
  modelGatewayProfileCreateRequestSchema,
  modelGatewayProfileUpdateDraftRequestSchema,
} from '@dar/contracts';
import {
  AuditEventRepository,
  hashModelDefinition,
  ModelDefinitionRepository,
  ModelGatewayProfileRepository,
  type Database,
} from '@dar/db';
import { ModelCredentialCipher } from '@dar/security';
import type { Kysely } from 'kysely';

export interface ModelCatalogActor {
  tenantId: string;
  operatorId: string;
  requestId?: string;
}

export interface ModelCatalogApi {
  listGateways(query?: Partial<ModelGatewayProfileQuery>): Promise<ModelGatewayProfile[]>;
  getGateway(profileId: string): Promise<ModelGatewayProfile>;
  createGateway(input: unknown, actor: ModelCatalogActor): Promise<ModelGatewayProfile>;
  updateGateway(profileId: string, input: unknown, actor: ModelCatalogActor): Promise<ModelGatewayProfile>;
  publishGateway(profileId: string, expectedRevision: number | undefined, actor: ModelCatalogActor): Promise<ModelGatewayProfile>;
  disableGateway(profileId: string, actor: ModelCatalogActor): Promise<ModelGatewayProfile>;
  rotateGatewayCredential(profileId: string, apiKey: string, expectedCredentialRevision: number | undefined, actor: ModelCatalogActor): Promise<ModelGatewayProfile>;
  testGateway(profileId: string, probeModelId: string, actor: ModelCatalogActor): Promise<ModelGatewayConnectionTestResponse>;
  listModels(query?: Partial<ModelDefinitionQuery>): Promise<ModelDefinition[]>;
  listModelVersions(modelId: string): Promise<ModelDefinition[]>;
  getModel(modelId: string, version: number): Promise<ModelDefinition>;
  createModel(input: unknown, actor: ModelCatalogActor): Promise<ModelDefinition>;
  updateModel(modelId: string, version: number, input: unknown, actor: ModelCatalogActor): Promise<ModelDefinition>;
  validateModel(modelId: string, version: number): Promise<{ valid: boolean; can_publish: boolean; errors: unknown[]; warnings: unknown[] }>;
  publishModel(modelId: string, version: number, expectedRevision: number | undefined, actor: ModelCatalogActor): Promise<ModelDefinition>;
  disableModel(modelId: string, version: number, actor: ModelCatalogActor): Promise<ModelDefinition>;
  cloneModel(modelId: string, version: number, nextVersion: number | undefined, actor: ModelCatalogActor): Promise<ModelDefinition>;
}

export class ModelCatalogService implements ModelCatalogApi {
  private readonly gateways: ModelGatewayProfileRepository;
  private readonly models: ModelDefinitionRepository;
  private readonly audit: AuditEventRepository;
  private readonly cipher: ModelCredentialCipher;

  constructor(
    private readonly db: Kysely<Database>,
    masterKey: string,
  ) {
    this.gateways = new ModelGatewayProfileRepository(db);
    this.models = new ModelDefinitionRepository(db);
    this.audit = new AuditEventRepository(db);
    this.cipher = new ModelCredentialCipher(masterKey);
  }

  listGateways(query: Partial<ModelGatewayProfileQuery> = {}): Promise<ModelGatewayProfile[]> {
    return this.gateways.list({
      ...(query.status ? { status: query.status } : {}),
      limit: query.page_size ?? 100,
      offset: ((query.page ?? 1) - 1) * (query.page_size ?? 100),
    });
  }

  async getGateway(profileId: string): Promise<ModelGatewayProfile> {
    const profile = await this.gateways.get(profileId);
    if (!profile) {
      throw new Error(`MODEL_GATEWAY_PROFILE_NOT_FOUND: ${profileId}`);
    }
    return profile;
  }

  async createGateway(input: unknown, actor: ModelCatalogActor): Promise<ModelGatewayProfile> {
    const body = modelGatewayProfileCreateRequestSchema.parse(input);
    const credential = credentialForCreate(this.cipher, body);
    const profile = await this.gateways.createDraft({
      ...body,
      operatorId: actor.operatorId,
      ...(credential ? { credential } : {}),
    });
    await this.auditGateway('model_gateway.created', profile.profile_id, 'succeeded', actor, {
      credential_fingerprint: profile.credential_fingerprint,
      credential_revision: profile.credential_revision,
    });
    return profile;
  }

  async updateGateway(profileId: string, input: unknown, actor: ModelCatalogActor): Promise<ModelGatewayProfile> {
    const body = modelGatewayProfileUpdateDraftRequestSchema.parse(input);
    const credential = body.api_key
      ? this.cipher.encrypt({
          profile_id: profileId,
          api_key: body.api_key,
          credential_revision: 1,
        })
      : undefined;
    const { api_key: _apiKey, expected_revision, ...patchBody } = body;
    void _apiKey;
    return this.gateways.updateDraft(profileId, {
      operatorId: actor.operatorId,
      expectedRevision: expected_revision,
      patch: gatewayProfilePatch(patchBody),
      ...(credential ? { credential } : {}),
    });
  }

  async publishGateway(profileId: string, expectedRevision: number | undefined, actor: ModelCatalogActor): Promise<ModelGatewayProfile> {
    const profile = await this.gateways.publish(profileId, {
      operatorId: actor.operatorId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
    await this.auditGateway('model_gateway.published', profile.profile_id, 'succeeded', actor, {});
    return profile;
  }

  async disableGateway(profileId: string, actor: ModelCatalogActor): Promise<ModelGatewayProfile> {
    const profile = await this.gateways.disable(profileId, { operatorId: actor.operatorId });
    await this.auditGateway('model_gateway.disabled', profile.profile_id, 'succeeded', actor, {});
    return profile;
  }

  async rotateGatewayCredential(profileId: string, apiKey: string, expectedCredentialRevision: number | undefined, actor: ModelCatalogActor): Promise<ModelGatewayProfile> {
    const current = await this.gateways.get(profileId);
    if (!current) {
      throw new Error(`MODEL_GATEWAY_PROFILE_NOT_FOUND: ${profileId}`);
    }
    const nextRevision = current.credential_revision + 1;
    const profile = await this.gateways.rotateCredential(profileId, {
      operatorId: actor.operatorId,
      ...(expectedCredentialRevision !== undefined ? { expectedCredentialRevision } : {}),
      credential: this.cipher.encrypt({
        profile_id: profileId,
        api_key: apiKey,
        credential_revision: nextRevision,
      }),
    });
    await this.auditGateway('model_gateway.credential_rotated', profile.profile_id, 'succeeded', actor, {
      credential_fingerprint: profile.credential_fingerprint,
      credential_revision: profile.credential_revision,
    });
    return profile;
  }

  async testGateway(profileId: string, probeModelId: string, actor: ModelCatalogActor): Promise<ModelGatewayConnectionTestResponse> {
    const row = await this.gateways.getCredential(profileId);
    if (!row) {
      throw new Error(`MODEL_GATEWAY_PROFILE_NOT_FOUND: ${profileId}`);
    }
    const started = Date.now();
    let reachable = false;
    let responseModel: string | undefined;
    let safeErrorCode: string | undefined;
    try {
      const apiKey = row.auth_type === 'bearer'
        ? this.cipher.decrypt({
            profile_id: row.profile_id,
            credential_revision: row.credential_revision,
            ciphertext: required(row.credential_ciphertext, 'credential_ciphertext'),
            iv: required(row.credential_iv, 'credential_iv'),
            auth_tag: required(row.credential_auth_tag, 'credential_auth_tag'),
          })
        : undefined;
      const response = await request(chatCompletionsUrl(row.base_url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: probeModelId,
          messages: [
            { role: 'system', content: '你是连接测试助手。' },
            { role: 'user', content: '仅回答 OK。' },
          ],
          temperature: 0,
          max_tokens: 8,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.body.text();
      reachable = response.statusCode >= 200 && response.statusCode < 300;
      if (!reachable) {
        safeErrorCode = `HTTP_${response.statusCode}`;
      } else {
        const parsed = JSON.parse(text || '{}') as { model?: unknown };
        responseModel = typeof parsed.model === 'string' ? parsed.model : undefined;
      }
    } catch (error) {
      safeErrorCode = error instanceof Error && error.name === 'AbortError'
        ? 'TIMEOUT'
        : 'CONNECTION_FAILED';
    }
    const result = modelGatewayConnectionTestResponseSchema.parse({
      reachable,
      latency_ms: Date.now() - started,
      protocol: row.protocol,
      upstream_model_id: probeModelId,
      response_model: responseModel,
      supports_text: reachable,
      safe_error_code: safeErrorCode,
    });
    await this.auditGateway('model_gateway.connection_tested', row.profile_id, reachable ? 'succeeded' : 'failed', actor, {
      upstream_model_id: probeModelId,
      safe_error_code: result.safe_error_code,
      latency_ms: result.latency_ms,
    });
    return result;
  }

  listModels(query: Partial<ModelDefinitionQuery> = {}): Promise<ModelDefinition[]> {
    return this.models.list({
      ...(query.model_id ? { modelId: query.model_id } : {}),
      ...(query.gateway_profile_id ? { gatewayProfileId: query.gateway_profile_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      limit: query.page_size ?? 100,
      offset: ((query.page ?? 1) - 1) * (query.page_size ?? 100),
    });
  }

  listModelVersions(modelId: string): Promise<ModelDefinition[]> {
    return this.models.listVersions(modelId);
  }

  async getModel(modelId: string, version: number): Promise<ModelDefinition> {
    const model = await this.models.get(modelId, version);
    if (!model) {
      throw new Error(`MODEL_DEFINITION_NOT_FOUND: ${modelId}@${version}`);
    }
    return model;
  }

  async createModel(input: unknown, actor: ModelCatalogActor): Promise<ModelDefinition> {
    const body = modelDefinitionCreateDraftRequestSchema.parse(input);
    const model = await this.models.createDraft({
      operatorId: actor.operatorId,
      model: body,
    });
    await this.auditGateway('model.created', `${model.model_id}@${model.version}`, 'succeeded', actor, {
      model_hash: model.model_hash,
      gateway_profile_id: model.gateway_profile_id,
    });
    return model;
  }

  async updateModel(modelId: string, version: number, input: unknown, actor: ModelCatalogActor): Promise<ModelDefinition> {
    const body = modelDefinitionUpdateDraftRequestSchema.parse(input);
    const { expected_revision, ...model } = body;
    return this.models.updateDraft(modelId, version, {
      operatorId: actor.operatorId,
      expectedRevision: expected_revision,
      model: modelDefinitionPatch(model),
    });
  }

  async validateModel(modelId: string, version: number): Promise<{ valid: boolean; can_publish: boolean; errors: unknown[]; warnings: unknown[] }> {
    const model = await this.getModel(modelId, version);
    const errors = [];
    const profile = await this.gateways.get(model.gateway_profile_id);
    if (!profile || profile.status !== 'published') {
      errors.push({ code: 'MODEL_GATEWAY_PROFILE_NOT_PUBLISHED', message: 'Model Gateway Profile must be published', severity: 'error' });
    } else if (profile.config_hash !== model.gateway_profile_config_hash) {
      errors.push({ code: 'MODEL_GATEWAY_PROFILE_HASH_MISMATCH', message: 'Gateway Profile config hash mismatch', severity: 'error' });
    }
    if (hashModelDefinition(model) !== model.model_hash) {
      errors.push({ code: 'MODEL_HASH_MISMATCH', message: 'ModelDefinition hash mismatch', severity: 'error' });
    }
    return { valid: errors.length === 0, can_publish: errors.length === 0, errors, warnings: [] };
  }

  async publishModel(modelId: string, version: number, expectedRevision: number | undefined, actor: ModelCatalogActor): Promise<ModelDefinition> {
    const model = await this.models.publish(modelId, version, {
      operatorId: actor.operatorId,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    });
    await this.auditGateway('model.published', `${model.model_id}@${model.version}`, 'succeeded', actor, {
      model_hash: model.model_hash,
      gateway_profile_id: model.gateway_profile_id,
    });
    return model;
  }

  async disableModel(modelId: string, version: number, actor: ModelCatalogActor): Promise<ModelDefinition> {
    const model = await this.models.disable(modelId, version, { operatorId: actor.operatorId });
    await this.auditGateway('model.disabled', `${model.model_id}@${model.version}`, 'succeeded', actor, {});
    return model;
  }

  async cloneModel(modelId: string, version: number, nextVersion: number | undefined, actor: ModelCatalogActor): Promise<ModelDefinition> {
    return this.models.cloneVersion(modelId, version, {
      operatorId: actor.operatorId,
      ...(nextVersion !== undefined ? { version: nextVersion } : {}),
    });
  }

  private async auditGateway(action: string, targetId: string, result: 'succeeded' | 'failed', actor: ModelCatalogActor, payload: Record<string, unknown>): Promise<void> {
    await this.audit.append({
      event_key: `${action}:${targetId}:${Date.now()}`,
      tenant_id: actor.tenantId,
      actor_id: actor.operatorId,
      action,
      target_type: action.startsWith('model_gateway.') ? 'model_gateway_profile' : 'model_definition',
      target_id: targetId,
      result,
      ...(actor.requestId ? { trace_id: actor.requestId } : {}),
      payload,
    });
  }
}

function chatCompletionsUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/u, '');
  url.pathname = normalizedPath.endsWith('/v1')
    ? `${normalizedPath}/chat/completions`
    : `${normalizedPath}/v1/chat/completions`;
  return url;
}

function credentialForCreate(
  cipher: ModelCredentialCipher,
  body: ModelGatewayProfileCreateRequest,
): Parameters<ModelGatewayProfileRepository['createDraft']>[0]['credential'] {
  if (body.auth_type === 'none') {
    return undefined;
  }
  if (!body.api_key) {
    throw new Error('MODEL_GATEWAY_CREDENTIAL_REQUIRED');
  }
  return cipher.encrypt({
    profile_id: body.profile_id,
    api_key: body.api_key,
    credential_revision: 1,
  });
}

function required(value: string | null, field: string): string {
  if (!value) {
    throw new Error(`MODEL_GATEWAY_CREDENTIAL_FIELD_MISSING: ${field}`);
  }
  return value;
}

function gatewayProfilePatch(
  body: Omit<ModelGatewayProfileUpdateDraftRequest, 'api_key' | 'expected_revision'>,
): Parameters<ModelGatewayProfileRepository['updateDraft']>[1]['patch'] {
  const patch: Parameters<ModelGatewayProfileRepository['updateDraft']>[1]['patch'] = {};
  if (body.display_name !== undefined) {
    patch.display_name = body.display_name;
  }
  if (body.protocol !== undefined) {
    patch.protocol = body.protocol;
  }
  if (body.base_url !== undefined) {
    patch.base_url = body.base_url;
  }
  if (body.auth_type !== undefined) {
    patch.auth_type = body.auth_type;
  }
  return patch;
}

function modelDefinitionPatch(
  body: Omit<ModelDefinitionUpdateDraftRequest, 'expected_revision'>,
): Parameters<ModelDefinitionRepository['updateDraft']>[2]['model'] {
  const patch: Parameters<ModelDefinitionRepository['updateDraft']>[2]['model'] = {};
  if (body.display_name !== undefined) {
    patch.display_name = body.display_name;
  }
  if (body.gateway_profile_id !== undefined) {
    patch.gateway_profile_id = body.gateway_profile_id;
  }
  if (body.upstream_model_id !== undefined) {
    patch.upstream_model_id = body.upstream_model_id;
  }
  if (body.provider !== undefined) {
    patch.provider = body.provider;
  }
  if (body.capabilities !== undefined) {
    patch.capabilities = body.capabilities;
  }
  if (body.context_window !== undefined) {
    patch.context_window = body.context_window;
  }
  if (body.max_output_tokens !== undefined) {
    patch.max_output_tokens = body.max_output_tokens;
  }
  if (body.input_cost_per_million !== undefined) {
    patch.input_cost_per_million = body.input_cost_per_million;
  }
  if (body.output_cost_per_million !== undefined) {
    patch.output_cost_per_million = body.output_cost_per_million;
  }
  if (body.currency !== undefined) {
    patch.currency = body.currency;
  }
  if (body.tags !== undefined) {
    patch.tags = body.tags;
  }
  return patch;
}
