import type { ColumnsType } from 'antd/es/table';
import type { FlowStep, RegistryResourceType, ToolRiskLevel } from '@dar/contracts';
import { Alert, Descriptions, Table, Tag, Typography } from 'antd';
import { RiskNotice, RiskTag } from '../../components/RiskTag.js';
import { formatList } from '../../utils/format.js';
import { isRecord, readNumber, readString, readStringArray } from '../../utils/json.js';
import type { RegistryRecord } from '../../api/registry-api.js';

export interface ResourceConfig {
  type: RegistryResourceType;
  plural: string;
  idLabel: string;
  title: string;
  description: string;
  getIdFromSpec(spec: unknown): string | undefined;
  makeDraftTemplate(): unknown;
  renderSummary(record: RegistryRecord): React.ReactNode;
  renderListExtra?(record: RegistryRecord): React.ReactNode;
}

export const resourceConfigs: Record<RegistryResourceType, ResourceConfig> = {
  flow: {
    type: 'flow',
    plural: 'flows',
    idLabel: 'flow_id',
    title: '流程注册',
    description: '管理 FlowSpec 生命周期、依赖校验和发布版本。',
    getIdFromSpec: (spec) => readStringField(spec, 'flow_id'),
    makeDraftTemplate: () => ({
      flow_id: 'flow_id_here',
      version: 1,
      name: '流程名称',
      runtime: {
        workflow_type: 'ConfigDrivenWorkflow',
        task_queue: 'config-driven',
      },
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      steps: [
        {
          id: 'start',
          type: 'activity',
          activity: 'activity.name',
          input: {},
        },
      ],
      metadata: {},
    }),
    renderSummary: renderFlowSummary,
    renderListExtra: (record) => {
      const spec = asRecord(record.spec);
      const steps = Array.isArray(spec.steps) ? spec.steps : [];
      return <Tag>{steps.length} 个步骤</Tag>;
    },
  },
  route: {
    type: 'route',
    plural: 'routes',
    idLabel: 'route_id',
    title: '路由注册',
    description: '管理 RouteSpec 匹配信号、阈值、灰度策略和发布版本。',
    getIdFromSpec: (spec) => readStringField(spec, 'route_id') ?? routeIdFromSpec(spec),
    makeDraftTemplate: () => ({
      route_id: 'route_id_here',
      flow_id: 'flow_id_here',
      version: 1,
      route: {
        priority: 50,
        keywords: ['keyword'],
        examples: ['example input'],
        negative_examples: [],
        supported_channels: ['web'],
        role_constraints: [],
        confidence_threshold: 0.7,
        ambiguous_threshold: 0.5,
      },
    }),
    renderSummary: renderRouteSummary,
  },
  tool: {
    type: 'tool',
    plural: 'tools',
    idLabel: 'tool_name',
    title: '工具注册',
    description: '管理 ToolManifest、风险等级、副作用和适配器元数据。',
    getIdFromSpec: (spec) => readStringField(spec, 'tool_name'),
    makeDraftTemplate: () => ({
      tool_name: 'tool.name',
      version: '1.0.0',
      description: '工具说明',
      risk_level: 'L1',
      side_effect: false,
      adapter: {
        type: 'mock',
        config: {},
      },
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      required_permissions: [],
    }),
    renderSummary: renderToolSummary,
    renderListExtra: (record) => {
      const spec = asRecord(record.spec);
      return <RiskTag risk={readString(spec.risk_level)} />;
    },
  },
  agent: {
    type: 'agent',
    plural: 'agents',
    idLabel: 'agent_id',
    title: '智能体注册',
    description: '管理 AgentSpec、Prompt 引用、allowed_tools 和执行边界。',
    getIdFromSpec: (spec) => readStringField(spec, 'agent_id'),
    makeDraftTemplate: () => ({
      agent_id: 'agent_id_here',
      version: 1,
      prompt_ref: 'prompt_id@1',
      model_policy: 'model_policy_id@1',
      model_policy_ref: {
        model_policy_id: 'model_policy_id',
        model_policy_version: 1,
      },
      allowed_tools: [],
      max_steps: 6,
      max_tokens: 12000,
    }),
    renderSummary: renderAgentSummary,
  },
  model_policy: {
    type: 'model_policy',
    plural: 'model-policies',
    idLabel: 'model_policy_id',
    title: '模型策略注册',
    description: '管理模型网关协议、目标模型、重试、fallback 和请求参数策略。',
    getIdFromSpec: (spec) => readStringField(spec, 'model_policy_id'),
    makeDraftTemplate: () => ({
      model_policy_id: 'model_policy_id_here',
      version: 1,
      status: 'draft',
      protocol: 'openai_chat_completions',
      targets: [
        {
          target_id: 'primary',
          model_ref: {
            model_id: 'gpt-4.1-mini',
            version: 1,
            model_hash: '0'.repeat(64),
          },
          priority: 0,
          enabled: true,
        },
      ],
      retry_policy: {
        max_attempts_per_target: 2,
        retryable_status_codes: [429, 500, 502, 503, 504],
        retry_on_timeout: true,
        retry_on_network_error: true,
        backoff_ms: 100,
        max_backoff_ms: 1000,
      },
      fallback_policy: {
        enabled: false,
        ordered_target_ids: [],
        eligible_error_classes: ['rate_limit', 'timeout', 'network', 'upstream_5xx'],
        stop_on_auth_error: true,
        stop_on_validation_error: true,
        stop_on_policy_denial: true,
      },
      request_policy: {
        temperature: 0.2,
        top_p: 1,
        max_output_tokens: 1000,
        initial_tool_choice_mode: 'auto',
        after_tool_result_tool_choice_mode: 'auto',
        response_format: 'text',
        allow_parallel_tool_calls: false,
      },
    }),
    renderSummary: renderModelPolicySummary,
    renderListExtra: (record) => {
      const spec = asRecord(record.spec);
      return <Tag>{readString(spec.protocol) ?? 'model'}</Tag>;
    },
  },
  prompt: {
    type: 'prompt',
    plural: 'prompts',
    idLabel: 'prompt_id',
    title: '提示词注册',
    description: '管理 PromptDefinition 内容、变量和发布版本。',
    getIdFromSpec: (spec) => readStringField(spec, 'prompt_id'),
    makeDraftTemplate: () => ({
      prompt_id: 'prompt_id_here',
      version: 1,
      name: '提示词名称',
      content: '在这里编写提示词内容。使用 {{variable_name}} 引用模板变量。',
      variables: ['variable_name'],
    }),
    renderSummary: renderPromptSummary,
  },
  tenant_runtime_policy: {
    type: 'tenant_runtime_policy',
    plural: 'tenant-runtime-policies',
    idLabel: 'tenant_id',
    title: '租户运行策略',
    description: '管理租户运行时 Tool、Model、Handoff、Budget 和并发上限策略。',
    getIdFromSpec: (spec) => readStringField(spec, 'tenant_id'),
    makeDraftTemplate: () => ({
      tenant_id: 'tenant_id_here',
      version: 1,
      status: 'draft',
      allowed_tools: [],
      denied_tools: [],
      allowed_models: [],
      denied_models: [],
      allowed_handoffs: [],
      denied_handoffs: [],
      budget_cap: {
        max_segments: 10,
        max_model_turns: 20,
        max_tool_calls: 10,
        max_input_tokens: 8000,
        max_output_tokens: 4000,
        max_total_tokens: 12000,
        max_duration_ms: 120000,
        max_handoffs: 1,
        max_context_bytes: 262144,
      },
      max_concurrent_agent_runs: 1,
    }),
    renderSummary: renderTenantRuntimePolicySummary,
    renderListExtra: (record) => {
      const spec = asRecord(record.spec);
      return <Tag>{readNumber(spec.max_concurrent_agent_runs) ?? 0} 并发</Tag>;
    },
  },
};

function renderFlowSummary(record: RegistryRecord) {
  const spec = asRecord(record.spec);
  const steps = Array.isArray(spec.steps) ? (spec.steps.filter(isRecord) as FlowStep[]) : [];
  const columns: ColumnsType<FlowStep> = [
    { title: '步骤 ID', dataIndex: 'id', key: 'id' },
    { title: '类型', dataIndex: 'type', key: 'type' },
    {
      title: '工具',
      dataIndex: 'tool',
      key: 'tool',
      render: (value: string | undefined) => value ?? '-',
    },
    {
      title: '智能体',
      dataIndex: 'agent_id',
      key: 'agent_id',
      render: (value: string | undefined) => value ?? '-',
    },
    {
      title: 'activity',
      dataIndex: 'activity',
      key: 'activity',
      render: (value: string | undefined) => value ?? '-',
    },
    {
      title: '模式',
      dataIndex: 'mode',
      key: 'mode',
      render: (value: string | undefined) => value ?? '-',
    },
    {
      title: '风险',
      dataIndex: 'risk_level',
      key: 'risk_level',
      render: (value: ToolRiskLevel | undefined) => (value ? <RiskTag risk={value} /> : '-'),
    },
  ];
  const hasL3PreviewCommit = steps.some(
    (step) =>
      step.type === 'tool' &&
      (step.risk_level === 'L3' || step.mode === 'preview_commit') &&
      step.mode === 'preview_commit',
  );
  return (
    <>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="flow_id">
          {readString(spec.flow_id) ?? record.resource_id}
        </Descriptions.Item>
        <Descriptions.Item label="version">{record.version}</Descriptions.Item>
        <Descriptions.Item label="workflow_type">
          {readString(asRecord(spec.runtime).workflow_type) ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="steps">{steps.length}</Descriptions.Item>
      </Descriptions>
      <Alert
        style={{ marginTop: 12 }}
        type={hasL3PreviewCommit ? 'success' : 'info'}
        showIcon
        message="L3 人工确认路径"
        description={
          hasL3PreviewCommit
            ? 'Flow 中存在 preview_commit 路径。'
            : '如 Flow 引用 L3 Tool，validate 会强制检查 preview_commit。'
        }
      />
      <Table
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={steps}
        pagination={false}
        style={{ marginTop: 12 }}
      />
    </>
  );
}

function renderRouteSummary(record: RegistryRecord) {
  const spec = asRecord(record.spec);
  const route = asRecord(spec.route);
  return (
    <Descriptions bordered size="small" column={2}>
      <Descriptions.Item label="route_id">
        {readString(spec.route_id) ?? record.resource_id}
      </Descriptions.Item>
      <Descriptions.Item label="flow_id">{readString(spec.flow_id) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="flow_version">
        {readNumber(spec.version) ?? record.version}
      </Descriptions.Item>
      <Descriptions.Item label="priority">{readNumber(route.priority) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="confidence_threshold">
        {readNumber(route.confidence_threshold) ?? '-'}
      </Descriptions.Item>
      <Descriptions.Item label="ambiguous_threshold">
        {readNumber(route.ambiguous_threshold) ?? '-'}
      </Descriptions.Item>
      <Descriptions.Item label="keywords">
        {formatList(readStringArray(route.keywords))}
      </Descriptions.Item>
      <Descriptions.Item label="examples">
        {formatList(readStringArray(route.examples))}
      </Descriptions.Item>
      <Descriptions.Item label="negative_examples">
        {formatList(readStringArray(route.negative_examples))}
      </Descriptions.Item>
      <Descriptions.Item label="channels">
        {formatList(readStringArray(route.supported_channels))}
      </Descriptions.Item>
      <Descriptions.Item label="roles">
        {formatList(readStringArray(route.role_constraints))}
      </Descriptions.Item>
      <Descriptions.Item label="gray tenant allowlist">
        {formatList(record.gray_policy.tenant_allowlist)}
      </Descriptions.Item>
    </Descriptions>
  );
}

function renderToolSummary(record: RegistryRecord) {
  const spec = asRecord(record.spec);
  const adapter = asRecord(spec.adapter);
  const risk = readString(spec.risk_level);
  return (
    <>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="tool_name">
          {readString(spec.tool_name) ?? record.resource_id}
        </Descriptions.Item>
        <Descriptions.Item label="version">
          {readString(spec.version) ?? record.version}
        </Descriptions.Item>
        <Descriptions.Item label="risk_level">
          <RiskTag risk={risk} />
        </Descriptions.Item>
        <Descriptions.Item label="side_effect">
          {String(Boolean(spec.side_effect))}
        </Descriptions.Item>
        <Descriptions.Item label="adapter.type">
          {readString(adapter.type) ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="required_permissions">
          {formatList(readStringArray(spec.required_permissions))}
        </Descriptions.Item>
      </Descriptions>
      <div style={{ marginTop: 12 }}>
        <RiskNotice risk={risk} sideEffect={Boolean(spec.side_effect)} />
      </div>
      <Typography.Title level={5}>输入 Schema</Typography.Title>
      <pre className="cp-json-pre">{JSON.stringify(spec.input_schema ?? {}, null, 2)}</pre>
      <Typography.Title level={5}>输出 Schema</Typography.Title>
      <pre className="cp-json-pre">{JSON.stringify(spec.output_schema ?? {}, null, 2)}</pre>
    </>
  );
}

function renderAgentSummary(record: RegistryRecord) {
  const spec = asRecord(record.spec);
  return (
    <Descriptions bordered size="small" column={2}>
      <Descriptions.Item label="agent_id">
        {readString(spec.agent_id) ?? record.resource_id}
      </Descriptions.Item>
      <Descriptions.Item label="prompt_ref">{readString(spec.prompt_ref) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="allowed_tools">
        {formatList(readStringArray(spec.allowed_tools))}
      </Descriptions.Item>
      <Descriptions.Item label="max_steps">{readNumber(spec.max_steps) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="max_tokens">{readNumber(spec.max_tokens) ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="model_policy">
        {readString(spec.model_policy) ?? '-'}
      </Descriptions.Item>
      <Descriptions.Item label="model_policy_ref">
        {JSON.stringify(spec.model_policy_ref ?? {})}
      </Descriptions.Item>
      <Descriptions.Item label="output_schema" span={2}>
        {readString(spec.output_schema) ?? '-'}
      </Descriptions.Item>
    </Descriptions>
  );
}

function renderModelPolicySummary(record: RegistryRecord) {
  const spec = asRecord(record.spec);
  const targets = Array.isArray(spec.targets) ? spec.targets.filter(isRecord) : [];
  const columns: ColumnsType<Record<string, unknown>> = [
    {
      title: 'target_id',
      dataIndex: 'target_id',
      key: 'target_id',
      render: (value: unknown) => readString(value) ?? '-',
    },
    {
      title: 'model_ref',
      key: 'model_ref',
      render: (_: unknown, row) => {
        const modelRef = asRecord(row.model_ref);
        const modelId = readString(modelRef.model_id);
        const version = readNumber(modelRef.version);
        return modelId && version ? `${modelId}@${version}` : '-';
      },
    },
    {
      title: 'priority',
      dataIndex: 'priority',
      key: 'priority',
      render: (value: unknown) => readNumber(value) ?? '-',
    },
    {
      title: 'enabled',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (value: unknown) => String(Boolean(value)),
    },
  ];
  const requestPolicy = asRecord(spec.request_policy);
  return (
    <>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="model_policy_id">
          {readString(spec.model_policy_id) ?? record.resource_id}
        </Descriptions.Item>
        <Descriptions.Item label="version">
          {readNumber(spec.version) ?? record.version}
        </Descriptions.Item>
        <Descriptions.Item label="protocol">{readString(spec.protocol) ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="targets">{targets.length}</Descriptions.Item>
        <Descriptions.Item label="max_output_tokens">
          {readNumber(requestPolicy.max_output_tokens) ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="initial_tool_choice_mode">
          {readString(requestPolicy.initial_tool_choice_mode) ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="after_tool_result_tool_choice_mode">
          {readString(requestPolicy.after_tool_result_tool_choice_mode) ?? '-'}
        </Descriptions.Item>
      </Descriptions>
      <Table
        size="small"
        rowKey={(row) => readString(row.target_id) ?? JSON.stringify(row)}
        columns={columns}
        dataSource={targets}
        pagination={false}
        style={{ marginTop: 12 }}
      />
    </>
  );
}

function renderPromptSummary(record: RegistryRecord) {
  const spec = asRecord(record.spec);
  const content = readString(spec.content) ?? '';
  return (
    <>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="prompt_id">
          {readString(spec.prompt_id) ?? record.resource_id}
        </Descriptions.Item>
        <Descriptions.Item label="version">
          {readNumber(spec.version) ?? record.version}
        </Descriptions.Item>
        <Descriptions.Item label="name">{readString(spec.name) ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="variables">
          {formatList(readStringArray(spec.variables))}
        </Descriptions.Item>
      </Descriptions>
      <Alert
        style={{ marginTop: 12 }}
        type="info"
        showIcon
        message="模板变量格式"
        description="变量应使用合法标识符，Prompt 内容中的疑似密钥会由 validate 检查并展示 warning/error。"
      />
      <Typography.Title level={5}>提示词内容</Typography.Title>
      <pre className="cp-json-pre">{content}</pre>
    </>
  );
}

function renderTenantRuntimePolicySummary(record: RegistryRecord) {
  const spec = asRecord(record.spec);
  const budget = asRecord(spec.budget_cap);
  const allowedTools = Array.isArray(spec.allowed_tools) ? spec.allowed_tools.length : 0;
  const deniedTools = Array.isArray(spec.denied_tools) ? spec.denied_tools.length : 0;
  const allowedModels = Array.isArray(spec.allowed_models) ? spec.allowed_models.length : 0;
  return (
    <>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="tenant_id">
          {readString(spec.tenant_id) ?? record.resource_id}
        </Descriptions.Item>
        <Descriptions.Item label="version">
          {readNumber(spec.version) ?? record.version}
        </Descriptions.Item>
        <Descriptions.Item label="max_concurrent_agent_runs">
          {readNumber(spec.max_concurrent_agent_runs) ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="allowed_tools">{allowedTools}</Descriptions.Item>
        <Descriptions.Item label="denied_tools">{deniedTools}</Descriptions.Item>
        <Descriptions.Item label="allowed_models">{allowedModels}</Descriptions.Item>
        <Descriptions.Item label="max_tool_calls">
          {readNumber(budget.max_tool_calls) ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="max_total_tokens">
          {readNumber(budget.max_total_tokens) ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="max_handoffs">
          {readNumber(budget.max_handoffs) ?? '-'}
        </Descriptions.Item>
        <Descriptions.Item label="max_context_bytes">
          {readNumber(budget.max_context_bytes) ?? '-'}
        </Descriptions.Item>
      </Descriptions>
      <Alert
        style={{ marginTop: 12 }}
        type="info"
        showIcon
        message="策略快照"
        description="Runtime 启动时会将发布策略与执行计划解析为不可变 snapshot，Tool Gateway 最终按 snapshot 校验工具调用。"
      />
    </>
  );
}

function readStringField(spec: unknown, field: string): string | undefined {
  return readString(asRecord(spec)[field]);
}

function routeIdFromSpec(spec: unknown): string | undefined {
  const record = asRecord(spec);
  const flowId = readString(record.flow_id);
  const version = readNumber(record.version);
  return flowId && version ? `${flowId}@${version}` : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
