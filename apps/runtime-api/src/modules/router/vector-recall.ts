import type { CandidateFlow, RouteSpec, TaskInput } from '@dar/contracts';
import { ModelGatewayError } from '@dar/model-client';
import { RouteEmbeddingRepository, type RouteEmbeddingSearchResult } from '@dar/db';
import type { SemanticRecallAdapter, SemanticRecallResult } from './rule-router.js';
import type { RouterEmbeddingModelResolver } from './router-embedding-model-resolver.js';

export interface VectorRecallAdapter {
  recall(input: TaskInput, routes: RouteSpec[]): CandidateFlow[];
}

export class MockVectorRecallAdapter implements VectorRecallAdapter {
  recall(input: TaskInput, routes: RouteSpec[]): CandidateFlow[] {
    const text = input.text?.toLowerCase() ?? '';
    if (!text) {
      return [];
    }

    return routes
      .filter((route) => route.status !== 'disabled')
      .map((route) => {
        const haystack = [...route.route.keywords, ...route.route.examples].join(' ').toLowerCase();
        const score = haystack
          .split(/\s+/u)
          .filter(Boolean)
          .some((term) => text.includes(term))
          ? 0.5
          : 0;
        return {
          route_id: route.route_id ?? `${route.flow_id}@${route.version}`,
          flow_id: route.flow_id,
          version: route.version,
          score,
          reason: 'mock_vector_recall',
        } satisfies CandidateFlow;
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score);
  }
}

export interface PgVectorRecallAdapterOptions {
  repository: RouteEmbeddingRepository;
  embeddingResolver: RouterEmbeddingModelResolver;
  topK: number;
}

export class PgVectorRecallAdapter implements SemanticRecallAdapter {
  constructor(private readonly options: PgVectorRecallAdapterOptions) {}

  async recall(
    input: TaskInput,
    routes: RouteSpec[],
    context: { tenantId?: string } = {},
  ): Promise<SemanticRecallResult> {
    const text = input.text?.trim();
    if (!text || routes.length === 0) {
      return { candidates: [], top_k: this.options.topK };
    }

    try {
      const resolved = await this.options.embeddingResolver.resolve();
      const [queryEmbedding] = await resolved.client.embed(resolved.upstreamModelId, text);
      if (!queryEmbedding) {
        return { candidates: [], model_ref: resolved.modelRef, top_k: this.options.topK };
      }
      const results = await this.options.repository.searchTopK({
        ...(context.tenantId ? { tenantId: context.tenantId } : {}),
        queryEmbedding,
        embeddingModelId: resolved.model.model_id,
        embeddingModelVersion: resolved.model.version,
        embeddingModelHash: resolved.model.model_hash,
        allowedRoutes: routes.map((route) => ({
          routeId: route.route_id ?? `${route.flow_id}@${route.version}`,
          flowVersion: route.version,
        })),
        topK: this.options.topK,
      });
      return {
        candidates: results.map(toCandidate),
        model_ref: resolved.modelRef,
        top_k: this.options.topK,
      };
    } catch (error) {
      throw normalizeEmbeddingError(error);
    }
  }
}

export const mockVectorRecallAdapter = new MockVectorRecallAdapter();

function toCandidate(result: RouteEmbeddingSearchResult): CandidateFlow {
  return {
    route_id: result.route_id,
    flow_id: result.flow_id,
    version: result.flow_version,
    score: result.score,
    reason: 'semantic_match',
    matched_source_type: result.matched_source_type,
    matched_source_hash: result.matched_source_hash,
  };
}

function normalizeEmbeddingError(error: unknown): Error {
  if (error instanceof ModelGatewayError) {
    return new Error(`ROUTER_EMBEDDING_UNAVAILABLE: ${error.code}`);
  }
  if (error instanceof Error && error.message.startsWith('ROUTER_EMBEDDING_MODEL_INVALID')) {
    return error;
  }
  if (error instanceof Error && error.message.startsWith('ROUTER_EMBEDDING_MODEL_NOT_CONFIGURED')) {
    return error;
  }
  return error instanceof Error ? error : new Error('ROUTER_EMBEDDING_UNAVAILABLE');
}
