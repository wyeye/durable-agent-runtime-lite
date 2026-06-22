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
import type { ApiClient } from '../../api/client.js';
import type { RegistrySpec } from '../../api/registry-api.js';
import type { VisualEditorProps } from '../types.js';
import { AgentVisualEditor } from './AgentVisualEditor.js';
import { FlowVisualEditor } from './FlowVisualEditor.js';
import { ModelPolicyVisualEditor } from './ModelPolicyVisualEditor.js';
import { PromptVisualEditor } from './PromptVisualEditor.js';
import { RouteVisualEditor } from './RouteVisualEditor.js';
import { TenantRuntimePolicyVisualEditor } from './TenantRuntimePolicyVisualEditor.js';
import { ToolVisualEditor } from './ToolVisualEditor.js';

export function RegistryVisualEditor({
  resourceType,
  value,
  readOnly,
  onChange,
  client,
}: VisualEditorProps<RegistrySpec> & {
  resourceType: RegistryResourceType;
  client: ApiClient;
}) {
  if (resourceType === 'prompt') {
    return <PromptVisualEditor value={value as PromptDefinition} readOnly={readOnly} onChange={(next) => onChange(next)} />;
  }
  if (resourceType === 'route') {
    return <RouteVisualEditor value={value as RouteSpec} readOnly={readOnly} onChange={(next) => onChange(next)} client={client} />;
  }
  if (resourceType === 'tool') {
    return <ToolVisualEditor value={value as ToolManifest} readOnly={readOnly} onChange={(next) => onChange(next)} />;
  }
  if (resourceType === 'agent') {
    return <AgentVisualEditor value={value as AgentSpec} readOnly={readOnly} onChange={(next) => onChange(next)} client={client} />;
  }
  if (resourceType === 'model_policy') {
    return <ModelPolicyVisualEditor value={value as ModelPolicy} readOnly={readOnly} onChange={(next) => onChange(next)} />;
  }
  if (resourceType === 'tenant_runtime_policy') {
    return <TenantRuntimePolicyVisualEditor value={value as TenantRuntimePolicy} readOnly={readOnly} onChange={(next) => onChange(next)} />;
  }
  return <FlowVisualEditor value={value as FlowSpec} readOnly={readOnly} onChange={(next) => onChange(next)} client={client} />;
}
