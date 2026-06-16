import type { CandidateFlow, RouteSpec, TaskInput } from '@dar/contracts';

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

export const mockVectorRecallAdapter = new MockVectorRecallAdapter();
