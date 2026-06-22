import type { ZodIssue, ZodType } from 'zod';
import type {
  AgentSpec,
  EvaluationCase,
  EvaluationDataset,
  EvaluationGatePolicy,
  FlowSpec,
  ModelPolicy,
  PromptDefinition,
  RegistryResourceType,
  RouteSpec,
  TenantRuntimePolicy,
  ToolManifest,
} from '@dar/contracts';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface VisualEditorAdapter<TSpec, TFormValues = TSpec> {
  schema: ZodType<TSpec>;
  createDefault(): TSpec;
  specToForm(spec: TSpec): TFormValues;
  formToSpec(values: TFormValues): TSpec;
  getPreview(spec: TSpec): unknown;
}

export interface VisualEditorProps<TSpec> {
  value: TSpec;
  readOnly: boolean;
  onChange(value: TSpec): void;
  validationIssues?: ZodIssue[];
}

export type RegistryVisualSpec =
  | FlowSpec
  | RouteSpec
  | ToolManifest
  | AgentSpec
  | ModelPolicy
  | PromptDefinition
  | TenantRuntimePolicy;

export type EvaluationVisualSpec = EvaluationDataset | EvaluationCase | EvaluationGatePolicy;

export type VisualRegistryAdapterMap = Record<
  RegistryResourceType,
  VisualEditorAdapter<RegistryVisualSpec, RegistryVisualSpec>
>;
