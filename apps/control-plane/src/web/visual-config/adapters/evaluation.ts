import type { EvaluationCase, EvaluationDataset, EvaluationGatePolicy } from '@dar/contracts';
import {
  evaluationCaseSchema,
  evaluationDatasetSchema,
  evaluationGatePolicySchema,
} from '@dar/contracts';
import type { VisualEditorAdapter } from '../types.js';
import { stripServerManagedFields } from '../canonicalize.js';

function nowId(prefix: string): string {
  return `${prefix}_${Date.now()}`;
}

function adapter<TSpec>(input: {
  schema: VisualEditorAdapter<TSpec>['schema'];
  createDefault(): TSpec;
}): VisualEditorAdapter<TSpec> {
  return {
    schema: input.schema,
    createDefault: input.createDefault,
    specToForm: (spec) => spec,
    formToSpec: (values) => stripServerManagedFields(values),
    getPreview: (spec) => stripServerManagedFields(spec),
  };
}

export const evaluationDatasetAdapter = adapter<EvaluationDataset>({
  schema: evaluationDatasetSchema,
  createDefault: () =>
    evaluationDatasetSchema.parse({
      dataset_id: nowId('dataset'),
      version: 1,
      name: '评测数据集',
      status: 'draft',
      domain: 'runtime',
      tags: [],
      default_weight: 1,
      revision: 1,
    }),
});

export function createDefaultEvaluationCase(datasetId: string, version: number): EvaluationCase {
  return evaluationCaseSchema.parse({
    case_id: nowId('case'),
    dataset_id: datasetId,
    dataset_version: version,
    name: '评测 Case',
    input: { text: '输入文本' },
    context_refs: [],
    expected_status: 'completed',
    expected_tool_calls: [],
    forbidden_tools: [],
    final_assertions: [{ type: 'non_empty' }],
    policy_assertions: [],
    weight: 1,
    tags: [],
    enabled: true,
  });
}

export const evaluationCaseAdapter = adapter<EvaluationCase>({
  schema: evaluationCaseSchema,
  createDefault: () => createDefaultEvaluationCase('dataset_id', 1),
});

export const evaluationGatePolicyAdapter = adapter<EvaluationGatePolicy>({
  schema: evaluationGatePolicySchema,
  createDefault: () =>
    evaluationGatePolicySchema.parse({
      gate_policy_id: nowId('gate_policy'),
      version: 1,
      status: 'draft',
      resource_types: ['prompt', 'agent', 'model_policy'],
      required_dataset_refs: [
        {
          dataset_id: 'published_dataset_id',
          version: 1,
          dataset_hash: 'a'.repeat(64),
        },
      ],
      thresholds: {},
      regression_rules: {},
      required_case_tags: [],
      allow_override: true,
      revision: 1,
    }),
});
