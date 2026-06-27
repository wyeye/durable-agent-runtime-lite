import type {
  AgentSpec,
  FlowSpec,
  FlowStep,
  RegistryDependencyEdge,
  RegistryDependencyNode,
  RegistryValidationIssue,
  RegistryValidationResult,
  RegistryResourceType,
  RouteSpec,
  ToolManifest,
} from '@dar/contracts';
import {
  agentSpecSchema,
  flowSpecSchema,
  promptDefinitionSchema,
  routeSpecSchema,
  toolManifestSchema,
} from '@dar/contracts';
import type {
  AgentSpecRepository,
  FlowDefinitionRepository,
  PromptDefinitionRepository,
  RouteConfigRepository,
  ToolManifestRepository,
} from '@dar/db';

export interface RegistryValidationRepositories {
  flows: FlowDefinitionRepository;
  routes: RouteConfigRepository;
  tools: ToolManifestRepository;
  agents: AgentSpecRepository;
  prompts: PromptDefinitionRepository;
}

export interface RegistryValidationOptions {
  tenantId?: string;
  allowPendingFlowDependency?: {
    flowId: string;
    flowVersion: number;
  };
}

interface ValidationContext {
  tenantId?: string;
  errors: RegistryValidationIssue[];
  warnings: RegistryValidationIssue[];
  nodes: RegistryDependencyNode[];
  edges: RegistryDependencyEdge[];
}

export class RegistryValidationService {
  constructor(private readonly repositories: RegistryValidationRepositories) {}

  async validateFlow(flowSpec: unknown, options: RegistryValidationOptions = {}): Promise<RegistryValidationResult> {
    const context = createContext(options);
    const parsed = parseWithIssues(flowSpecSchema, flowSpec, context, 'flow');
    if (!parsed) {
      return buildResult(context);
    }

    addNode(context, { resource_type: 'flow', resource_id: parsed.flow_id, version: parsed.version, status: parsed.status });
    validateFlowSteps(parsed, context);

    for (const step of parsed.steps) {
      if (step.type === 'tool' && step.tool) {
        const toolVersion = parseToolVersion(step.tool_version);
        if (!toolVersion) {
          addError(context, 'FLOW_TOOL_VERSION_REQUIRED', `Tool step must pin exact tool_version: ${step.tool}`, `steps.${step.id}.tool_version`);
          continue;
        }
        const tool = await this.repositories.tools.getByIdAndVersion(step.tool, toolVersion.registryVersion, tenantOptions(options));
        addDependency(context, 'flow', parsed.flow_id, parsed.version, 'tool', step.tool, tool?.version, tool?.status, 'uses_tool');
        if (!tool) {
          addError(context, 'FLOW_TOOL_NOT_FOUND', `ToolManifest not found: ${step.tool}@${step.tool_version}`, `steps.${step.id}.tool`);
          continue;
        }
        if (tool.spec.version !== step.tool_version) {
          addError(context, 'FLOW_TOOL_VERSION_MISMATCH', `ToolManifest exact version not found: ${step.tool}@${step.tool_version}`, `steps.${step.id}.tool_version`);
          continue;
        }
        if (!isDependencyPublishable(tool.status)) {
          addError(context, 'FLOW_TOOL_NOT_PUBLISHABLE', `ToolManifest is not published or gray: ${step.tool}@${step.tool_version}`, `steps.${step.id}.tool`);
        }
        if (tool.spec.risk_level === 'L3' && step.mode !== 'preview_commit') {
          addError(context, 'FLOW_L3_TOOL_NEEDS_CONFIRMATION', `L3 tool must use preview_commit mode: ${step.tool}`, `steps.${step.id}.mode`);
        }
        if (tool.spec.risk_level === 'L4') {
          addError(context, 'FLOW_L4_TOOL_AUTO_EXECUTION_DENIED', `L4 tool cannot be auto-executed: ${step.tool}`, `steps.${step.id}.tool`);
        }
      }

      if (step.type === 'agent' && step.agent_id) {
        const agentVersion = typeof step.input?.agent_version === 'number' && Number.isInteger(step.input.agent_version)
          ? step.input.agent_version
          : undefined;
        if (!agentVersion) {
          addError(context, 'FLOW_AGENT_VERSION_REQUIRED', `Agent step must pin exact input.agent_version: ${step.agent_id}`, `steps.${step.id}.input.agent_version`);
          continue;
        }
        const agent = await this.repositories.agents.getByIdAndVersion(step.agent_id, agentVersion, tenantOptions(options));
        addDependency(context, 'flow', parsed.flow_id, parsed.version, 'agent', step.agent_id, agent?.version, agent?.status, 'uses_agent');
        if (!agent) {
          addError(context, 'FLOW_AGENT_NOT_FOUND', `AgentSpec not found: ${step.agent_id}@${agentVersion}`, `steps.${step.id}.agent_id`);
          continue;
        }
        if (!isDependencyPublishable(agent.status)) {
          addError(context, 'FLOW_AGENT_NOT_PUBLISHABLE', `AgentSpec is not published or gray: ${step.agent_id}`, `steps.${step.id}.agent_id`);
        }
        await this.validateAgentDependencies(agent.spec, context, parsed.flow_id, parsed.version, options);
      }

      validateInputMapping(step, context);
    }

    return buildResult(context);
  }

  async validateRoute(routeSpec: unknown, options: RegistryValidationOptions = {}): Promise<RegistryValidationResult> {
    const context = createContext(options);
    const parsed = parseWithIssues(routeSpecSchema, routeSpec, context, 'route');
    if (!parsed) {
      return buildResult(context);
    }

    const routeId = parsed.route_id ?? `${parsed.flow_id}@${parsed.version}`;
    addNode(context, { resource_type: 'route', resource_id: routeId, version: parsed.version, status: parsed.status });

    const flow = await this.repositories.flows.getByIdAndVersion(parsed.flow_id, parsed.version, tenantOptions(options));
    addDependency(context, 'route', routeId, parsed.version, 'flow', parsed.flow_id, parsed.version, flow?.status, 'routes_to_flow');
    if (!flow) {
      addError(context, 'ROUTE_FLOW_NOT_FOUND', `FlowSpec not found: ${parsed.flow_id}@${parsed.version}`, 'flow_id');
    } else if (!isDependencyPublishable(flow.status) && !isAllowedPendingFlowDependency(parsed, options)) {
      addError(context, 'ROUTE_FLOW_NOT_PUBLISHABLE', `FlowSpec is not published or gray: ${parsed.flow_id}@${parsed.version}`, 'flow_id');
    }

    if (parsed.route.confidence_threshold < parsed.route.ambiguous_threshold) {
      addError(context, 'ROUTE_THRESHOLD_ORDER_INVALID', 'confidence_threshold must be >= ambiguous_threshold', 'route.confidence_threshold');
    }
    if (parsed.route.keywords.length === 0 && parsed.route.examples.length === 0) {
      addError(context, 'ROUTE_EMPTY_MATCH_SIGNALS', 'keywords and examples cannot both be empty', 'route.keywords');
    }
    validateSafeStringArray(parsed.route.supported_channels, context, 'ROUTE_CHANNEL_INVALID', 'route.supported_channels');
    validateSafeStringArray(parsed.route.role_constraints, context, 'ROUTE_ROLE_INVALID', 'route.role_constraints');
    if (parsed.route.fallback_agent_ref) {
      const fallbackRef = parseVersionRef(parsed.route.fallback_agent_ref);
      if (!fallbackRef) {
        addError(context, 'ROUTE_FALLBACK_AGENT_REF_INVALID', 'fallback_agent_ref must use agent_id@version', 'route.fallback_agent_ref');
      } else {
        const agent = await this.repositories.agents.getByIdAndVersion(fallbackRef.id, fallbackRef.version, tenantOptions(options));
        addDependency(context, 'route', routeId, parsed.version, 'agent', fallbackRef.id, fallbackRef.version, agent?.status, 'fallbacks_to_agent');
        if (!agent) {
          addError(context, 'ROUTE_FALLBACK_AGENT_NOT_FOUND', `AgentSpec not found: ${parsed.route.fallback_agent_ref}`, 'route.fallback_agent_ref');
        } else if (!isDependencyPublishable(agent.status)) {
          addError(context, 'ROUTE_FALLBACK_AGENT_NOT_PUBLISHABLE', `AgentSpec is not published or gray: ${parsed.route.fallback_agent_ref}`, 'route.fallback_agent_ref');
        } else {
          await this.validateAgentDependencies(agent.spec, context, parsed.flow_id, parsed.version, options);
        }
      }
    }

    const publishedRoutes = await this.repositories.routes.list({ ...tenantOptions(options), status: ['published', 'gray'] });
    for (const existing of publishedRoutes) {
      const existingRouteId = existing.spec.route_id ?? `${existing.spec.flow_id}@${existing.spec.version}`;
      if (existingRouteId === routeId) {
        continue;
      }
      const sharedKeywords = existing.spec.route.keywords.filter((keyword) => parsed.route.keywords.includes(keyword));
      if (sharedKeywords.length > 0) {
        addWarning(context, 'ROUTE_PUBLISHED_CONFLICT_WARNING', `Route shares keywords with ${existingRouteId}: ${sharedKeywords.join(', ')}`, 'route.keywords');
      }
    }

    return buildResult(context);
  }

  async validateTool(toolManifest: unknown, options: RegistryValidationOptions = {}): Promise<RegistryValidationResult> {
    const context = createContext(options);
    const parsed = parseWithIssues(toolManifestSchema, toolManifest, context, 'tool');
    if (!parsed) {
      return buildResult(context);
    }

    addNode(context, { resource_type: 'tool', resource_id: parsed.tool_name, version: parsed.version, status: parsed.status });
    validateJsonSchema(parsed.input_schema, context, 'TOOL_INPUT_SCHEMA_INVALID', 'input_schema');
  validateJsonSchema(parsed.output_schema, context, 'TOOL_OUTPUT_SCHEMA_INVALID', 'output_schema');
    if (parsed.side_effect && (parsed.risk_level === 'L0' || parsed.risk_level === 'L1')) {
      addError(context, 'TOOL_SIDE_EFFECT_RISK_TOO_LOW', 'Side-effect tools must not use L0/L1 risk', 'risk_level');
    }
    if (parsed.risk_level === 'L3' && !parsed.side_effect) {
      addError(context, 'TOOL_L3_REQUIRES_SIDE_EFFECT', 'L3 tool must be marked side_effect=true', 'side_effect');
    }
    if (parsed.risk_level === 'L4') {
      addWarning(context, 'TOOL_L4_DEFAULT_DENY', 'L4 tools are denied by default at runtime', 'risk_level');
    }
    if (!parsed.adapter.type) {
      addError(context, 'TOOL_ADAPTER_TYPE_REQUIRED', 'adapter.type is required', 'adapter.type');
    }
    validateHttpReadonlyTool(parsed, context);
    detectSecrets(parsed, context, 'TOOL_MANIFEST_CONTAINS_SECRET', 'manifest');

    return buildResult(context);
  }

  async validateAgent(agentSpec: unknown, options: RegistryValidationOptions = {}): Promise<RegistryValidationResult> {
    const context = createContext(options);
    const parsed = parseWithIssues(agentSpecSchema, agentSpec, context, 'agent');
    if (!parsed) {
      return buildResult(context);
    }

    addNode(context, { resource_type: 'agent', resource_id: parsed.agent_id, version: parsed.version, status: parsed.status });
    await this.validateAgentDependencies(parsed, context, parsed.agent_id, parsed.version, options);
    if (parsed.max_steps <= 0) {
      addError(context, 'AGENT_MAX_STEPS_INVALID', 'max_steps must be > 0', 'max_steps');
    }
    if (parsed.max_tokens <= 0) {
      addError(context, 'AGENT_MAX_TOKENS_INVALID', 'max_tokens must be > 0', 'max_tokens');
    }
    validateJsonSchemaString(parsed.output_schema, context, 'AGENT_OUTPUT_SCHEMA_INVALID', 'output_schema');
    detectBusinessUrls(parsed, context, 'AGENT_DIRECT_BUSINESS_URL_FORBIDDEN', 'agent');
    detectSecrets(parsed, context, 'AGENT_CONTAINS_SECRET', 'agent');

    return buildResult(context);
  }

  async validatePrompt(promptDefinition: unknown, _options: RegistryValidationOptions = {}): Promise<RegistryValidationResult> {
    const context = createContext(_options);
    const parsed = parseWithIssues(promptDefinitionSchema, promptDefinition, context, 'prompt');
    if (!parsed) {
      return buildResult(context);
    }

    addNode(context, { resource_type: 'prompt', resource_id: parsed.prompt_id, version: parsed.version, status: parsed.status });
    if (!parsed.content.trim()) {
      addError(context, 'PROMPT_CONTENT_EMPTY', 'Prompt content cannot be empty', 'content');
    }
    for (const variable of parsed.variables) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
        addError(context, 'PROMPT_VARIABLE_INVALID', `Invalid prompt variable: ${variable}`, 'variables');
      }
    }
    detectSecrets(parsed, context, 'PROMPT_CONTAINS_SECRET', 'prompt');

    return buildResult(context);
  }

  private async validateAgentDependencies(
    agentSpec: AgentSpec,
    context: ValidationContext,
    ownerId: string,
    ownerVersion: number,
    options: RegistryValidationOptions,
  ): Promise<void> {
    const promptRef = parseVersionRef(agentSpec.prompt_ref);
    if (!promptRef) {
      addError(context, 'AGENT_PROMPT_REF_INVALID', 'prompt_ref must use prompt_id@version', 'prompt_ref');
    } else {
      const prompt = await this.repositories.prompts.getByIdAndVersion(promptRef.id, promptRef.version, tenantOptions(options));
      addDependency(context, 'agent', ownerId, ownerVersion, 'prompt', promptRef.id, promptRef.version, prompt?.status, 'uses_prompt');
      if (!prompt) {
        addError(context, 'AGENT_PROMPT_NOT_FOUND', `PromptDefinition not found: ${agentSpec.prompt_ref}`, 'prompt_ref');
      } else if (!isDependencyPublishable(prompt.status)) {
        addError(context, 'AGENT_PROMPT_NOT_PUBLISHABLE', `PromptDefinition is not published or gray: ${agentSpec.prompt_ref}`, 'prompt_ref');
      }
    }

    for (const toolName of agentSpec.allowed_tools) {
      const toolRef = parseToolRef(toolName);
      if (!toolRef) {
        addError(context, 'AGENT_TOOL_REF_INVALID', `allowed_tools must use tool_name@tool_version: ${toolName}`, 'allowed_tools');
        continue;
      }
      const tool = await this.repositories.tools.getByIdAndVersion(toolRef.name, toolRef.registryVersion, tenantOptions(options));
      addDependency(context, 'agent', ownerId, ownerVersion, 'tool', toolRef.name, tool?.version, tool?.status, 'allows_tool');
      if (!tool) {
        addError(context, 'AGENT_TOOL_NOT_FOUND', `Allowed tool not found: ${toolName}`, 'allowed_tools');
      } else if (tool.spec.version !== toolRef.version) {
        addError(context, 'AGENT_TOOL_VERSION_MISMATCH', `Allowed tool exact version not found: ${toolName}`, 'allowed_tools');
      } else if (!isDependencyPublishable(tool.status)) {
        addError(context, 'AGENT_TOOL_NOT_PUBLISHABLE', `Allowed tool is not published or gray: ${toolName}`, 'allowed_tools');
      }
    }
  }
}

function validateFlowSteps(flowSpec: FlowSpec, context: ValidationContext): void {
  const seen = new Set<string>();
  for (const step of flowSpec.steps) {
    if (seen.has(step.id)) {
      addError(context, 'FLOW_STEP_ID_DUPLICATED', `Duplicated step id: ${step.id}`, `steps.${step.id}`);
    }
    seen.add(step.id);
    if (step.type === 'condition' && step.when) {
      const targets = extractConditionTargets(step.when);
      for (const target of targets) {
        if (!flowSpec.steps.some((candidate) => candidate.id === target)) {
          addError(context, 'FLOW_CONDITION_TARGET_NOT_FOUND', `Condition target not found: ${target}`, `steps.${step.id}.when`);
        }
      }
    }
  }

  if (flowSpec.steps.length > 0) {
    const reachable = new Set([flowSpec.steps[0]?.id]);
    for (const step of flowSpec.steps) {
      if (step.on_failure && typeof step.on_failure.target === 'string') {
        reachable.add(step.on_failure.target);
      }
      if (step.when) {
        for (const target of extractConditionTargets(step.when)) {
          reachable.add(target);
        }
      }
    }
    for (const step of flowSpec.steps) {
      if (!reachable.has(step.id) && step !== flowSpec.steps[0]) {
        addWarning(context, 'FLOW_STEP_UNREACHABLE_WARNING', `Step may be unreachable: ${step.id}`, `steps.${step.id}`);
      }
    }
  }

  const conditionEdges = flowSpec.steps.flatMap((step) =>
    extractConditionTargets(step.when).map((target) => [step.id, target] as const),
  );
  if (hasCycle(conditionEdges)) {
    addError(context, 'FLOW_ILLEGAL_LOOP', 'Condition graph contains an illegal cycle', 'steps');
  }
}

function validateInputMapping(step: FlowStep, context: ValidationContext): void {
  if (!step.input) {
    return;
  }
  for (const [key, value] of Object.entries(step.input)) {
    if (typeof value === 'string' && value.includes('${') && !/^\$\{[A-Za-z0-9_.[\]-]+\}$/u.test(value)) {
      addError(context, 'FLOW_INPUT_MAPPING_INVALID', `Invalid input mapping expression for ${key}`, `steps.${step.id}.input.${key}`);
    }
  }
}

function validateJsonSchema(schema: unknown, context: ValidationContext, code: string, path: string): void {
  if (schema === undefined) {
    return;
  }
  if (!isRecord(schema) || typeof schema.type !== 'string') {
    addError(context, code, 'JSON schema must be an object with a type field', path);
  }
}

function validateJsonSchemaString(value: string | undefined, context: ValidationContext, code: string, path: string): void {
  if (!value || /^[A-Za-z0-9_.:-]+$/u.test(value)) {
    return;
  }
  try {
    validateJsonSchema(JSON.parse(value), context, code, path);
  } catch {
    addError(context, code, 'output_schema must be a schema ref or JSON schema string', path);
  }
}

function validateSafeStringArray(values: string[], context: ValidationContext, code: string, path: string): void {
  for (const value of values) {
    if (!/^[A-Za-z0-9_.:-]+$/u.test(value)) {
      addError(context, code, `Invalid value: ${value}`, path);
    }
  }
}

function validateHttpReadonlyTool(tool: ToolManifest, context: ValidationContext): void {
  if (tool.adapter.type !== 'http_readonly') {
    return;
  }
  if (tool.side_effect) {
    addError(context, 'TOOL_HTTP_READONLY_SIDE_EFFECT_FORBIDDEN', '只读 HTTP 工具必须 side_effect=false', 'side_effect');
  }
  if (tool.risk_level !== 'L0' && tool.risk_level !== 'L1') {
    addError(context, 'TOOL_HTTP_READONLY_RISK_INVALID', '只读 HTTP 工具仅允许 L0/L1 风险等级', 'risk_level');
  }
  if (!tool.output_schema) {
    addError(context, 'TOOL_HTTP_READONLY_OUTPUT_SCHEMA_REQUIRED', '只读 HTTP 工具必须配置 output_schema', 'output_schema');
  }
  const url = parseUrl(tool.adapter.base_url);
  if (!url || (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== 'mock-server')) {
    addError(context, 'TOOL_HTTP_URL_INVALID', '只读 HTTP 工具 base_url 必须是 HTTPS，测试环境仅允许 localhost/mock-server', 'adapter.base_url');
  }
  if (url && (url.username || url.password || url.hash)) {
    addError(context, 'TOOL_HTTP_URL_INVALID', '只读 HTTP 工具 URL 不能包含用户名、密码或 fragment', 'adapter.base_url');
  }
  if (!tool.adapter.path.startsWith('/')) {
    addError(context, 'TOOL_HTTP_PATH_INVALID', '只读 HTTP 工具 path 必须以 / 开头', 'adapter.path');
  }
  const inputProperties = isRecord(tool.input_schema?.properties)
    ? Object.keys(tool.input_schema.properties)
    : [];
  for (const argumentName of Object.values(tool.adapter.query_mapping ?? {})) {
    if (!inputProperties.includes(argumentName)) {
      addError(context, 'TOOL_HTTP_QUERY_MAPPING_INVALID', `Query mapping 引用的入参不存在：${argumentName}`, 'adapter.query_mapping');
    }
  }
  const auth = tool.adapter.auth ?? { type: 'none' as const };
  if (auth.type !== 'none' && !/^env:TOOL_SECRET_[A-Z0-9_]+$/u.test(auth.secret_ref)) {
    addError(context, 'TOOL_HTTP_SECRET_REF_INVALID', 'secret_ref 必须形如 env:TOOL_SECRET_NAME', 'adapter.auth.secret_ref');
  }
  if (auth.type === 'api_key_env' && !['Authorization', 'X-API-Key', 'X-Api-Key', 'Api-Key', 'X-Auth-Token'].includes(auth.header_name)) {
    addError(context, 'TOOL_HTTP_HEADER_NAME_INVALID', 'API Key Header 名不在安全白名单内', 'adapter.auth.header_name');
  }
  if (tool.adapter.timeout_ms <= 0 || tool.adapter.timeout_ms > 15_000) {
    addError(context, 'TOOL_HTTP_TIMEOUT_INVALID', 'timeout_ms 必须在 1 到 15000 之间', 'adapter.timeout_ms');
  }
  if (tool.adapter.max_response_bytes <= 0 || tool.adapter.max_response_bytes > 1_048_576) {
    addError(context, 'TOOL_HTTP_RESPONSE_LIMIT_INVALID', 'max_response_bytes 必须在 1 到 1048576 之间', 'adapter.max_response_bytes');
  }
  if (tool.adapter.retry.max_attempts <= 0 || tool.adapter.retry.max_attempts > 5) {
    addError(context, 'TOOL_HTTP_RETRY_INVALID', 'retry.max_attempts 必须在 1 到 5 之间', 'adapter.retry.max_attempts');
  }
  if (tool.evaluation_policy?.mode === 'sandbox_commit') {
    addError(context, 'TOOL_HTTP_EVALUATION_SANDBOX_FORBIDDEN', '只读 HTTP 工具不支持 evaluation sandbox_commit', 'evaluation_policy.mode');
  }
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function parseToolVersion(version: string | undefined): { version: string; registryVersion: number } | undefined {
  if (!version) {
    return undefined;
  }
  const [major] = version.split('.');
  const registryVersion = Number(major);
  return Number.isInteger(registryVersion) && registryVersion > 0
    ? { version, registryVersion }
    : undefined;
}

function parseToolRef(value: string): { name: string; version: string; registryVersion: number } | undefined {
  const match = /^(.+)@([^@]+)$/u.exec(value);
  if (!match) {
    return undefined;
  }
  const parsed = parseToolVersion(match[2]);
  return parsed ? { name: match[1] ?? '', version: parsed.version, registryVersion: parsed.registryVersion } : undefined;
}

function parseWithIssues<T>(
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } },
  input: unknown,
  context: ValidationContext,
  pathPrefix: string,
): T | undefined {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  for (const issue of result.error.issues) {
    addError(context, 'REGISTRY_SCHEMA_INVALID', issue.message, [pathPrefix, ...issue.path].join('.'));
  }
  return undefined;
}

function createContext(options: RegistryValidationOptions): ValidationContext {
  void options;
  return { errors: [], warnings: [], nodes: [], edges: [] };
}

function buildResult(context: ValidationContext): RegistryValidationResult {
  return {
    valid: context.errors.length === 0,
    can_publish: context.errors.length === 0,
    errors: context.errors,
    warnings: context.warnings,
    dependency_graph: {
      nodes: dedupeNodes(context.nodes),
      edges: context.edges,
    },
  };
}

function addNode(context: ValidationContext, node: RegistryDependencyNode): void {
  context.nodes.push(node);
}

function addDependency(
  context: ValidationContext,
  fromType: RegistryResourceType,
  fromId: string,
  fromVersion: number,
  toType: RegistryDependencyNode['resource_type'],
  toId: string,
  toVersion: number | string | undefined,
  toStatus: RegistryDependencyNode['status'] | undefined,
  relation: string,
): void {
  const from: RegistryDependencyNode = { resource_type: fromType, resource_id: fromId, version: fromVersion };
  const to: RegistryDependencyNode = { resource_type: toType, resource_id: toId };
  if (toVersion !== undefined) {
    to.version = toVersion;
  }
  if (toStatus) {
    to.status = toStatus;
  }
  context.nodes.push(from, to);
  context.edges.push({ from, to, relation });
}

function addError(context: ValidationContext, code: string, message: string, path?: string): void {
  context.errors.push({ code, message, path, severity: 'error' });
}

function addWarning(context: ValidationContext, code: string, message: string, path?: string): void {
  context.warnings.push({ code, message, path, severity: 'warning' });
}

function isDependencyPublishable(status: string | undefined): boolean {
  return status === 'published' || status === 'gray';
}

function isAllowedPendingFlowDependency(route: RouteSpec, options: RegistryValidationOptions): boolean {
  const pending = options.allowPendingFlowDependency;
  return pending?.flowId === route.flow_id && pending.flowVersion === route.version;
}

function tenantOptions(options: RegistryValidationOptions): { tenantId?: string } {
  return options.tenantId ? { tenantId: options.tenantId } : {};
}

function parseVersionRef(value: string): { id: string; version: number } | undefined {
  const match = /^(.+)@([1-9]\d*)$/u.exec(value);
  if (!match) {
    return undefined;
  }
  return { id: match[1] ?? '', version: Number(match[2]) };
}

function extractConditionTargets(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return [...value.matchAll(/(?:goto|target|then|else):([A-Za-z0-9_.:-]+)/gu)].map((match) => match[1] ?? '');
}

function hasCycle(edges: Array<readonly [string, string]>): boolean {
  const graph = new Map<string, string[]>();
  for (const [from, to] of edges) {
    graph.set(from, [...(graph.get(from) ?? []), to]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }
    visiting.add(node);
    for (const next of graph.get(node) ?? []) {
      if (visit(next)) {
        return true;
      }
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...graph.keys()].some(visit);
}

function detectSecrets(value: unknown, context: ValidationContext, code: string, path: string): void {
  const serialized = JSON.stringify(value).toLowerCase();
  if (/(api[_-]?key|secret|token|password|private[_-]?key)["']?\s*[:=]\s*["'][^"']{8,}/u.test(serialized)) {
    addError(context, code, 'Potential plaintext secret found', path);
  }
}

function detectBusinessUrls(value: unknown, context: ValidationContext, code: string, path: string): void {
  const serialized = JSON.stringify(value);
  if (/https?:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^\s"']+/u.test(serialized)) {
    addError(context, code, 'Direct business system URL is not allowed in AgentSpec', path);
  }
}

function dedupeNodes(nodes: RegistryDependencyNode[]): RegistryDependencyNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = `${node.resource_type}:${node.resource_id}:${String(node.version ?? '')}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
