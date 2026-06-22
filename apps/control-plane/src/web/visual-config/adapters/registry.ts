import type {
  AgentSpec,
  FlowSpec,
  ModelPolicy,
  PromptDefinition,
  RegistryResourceType,
  RouteSpec,
  TenantRuntimePolicy,
  ToolManifest,
} from '@dar/contracts';
import {
  agentSpecSchema,
  flowSpecSchema,
  modelPolicySchema,
  promptDefinitionSchema,
  routeSpecSchema,
  tenantRuntimePolicySchema,
  toolManifestSchema,
} from '@dar/contracts';
import type { VisualEditorAdapter, VisualRegistryAdapterMap } from '../types.js';
import { resourceConfigs } from '../../pages/registry/resource-config.js';
import { stripServerManagedFields } from '../canonicalize.js';

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

export const registryVisualAdapters: VisualRegistryAdapterMap = {
  flow: adapter<FlowSpec>({
    schema: flowSpecSchema,
    createDefault: () => flowSpecSchema.parse(resourceConfigs.flow.makeDraftTemplate()),
  }),
  route: adapter<RouteSpec>({
    schema: routeSpecSchema,
    createDefault: () => routeSpecSchema.parse(resourceConfigs.route.makeDraftTemplate()),
  }),
  tool: adapter<ToolManifest>({
    schema: toolManifestSchema,
    createDefault: () => toolManifestSchema.parse(resourceConfigs.tool.makeDraftTemplate()),
  }),
  agent: adapter<AgentSpec>({
    schema: agentSpecSchema,
    createDefault: () => agentSpecSchema.parse(resourceConfigs.agent.makeDraftTemplate()),
  }),
  model_policy: adapter<ModelPolicy>({
    schema: modelPolicySchema,
    createDefault: () => modelPolicySchema.parse(resourceConfigs.model_policy.makeDraftTemplate()),
  }),
  prompt: adapter<PromptDefinition>({
    schema: promptDefinitionSchema,
    createDefault: () => promptDefinitionSchema.parse(resourceConfigs.prompt.makeDraftTemplate()),
  }),
  tenant_runtime_policy: adapter<TenantRuntimePolicy>({
    schema: tenantRuntimePolicySchema,
    createDefault: () =>
      tenantRuntimePolicySchema.parse(resourceConfigs.tenant_runtime_policy.makeDraftTemplate()),
  }),
};

export function getRegistryVisualAdapter(resourceType: RegistryResourceType) {
  return registryVisualAdapters[resourceType];
}
