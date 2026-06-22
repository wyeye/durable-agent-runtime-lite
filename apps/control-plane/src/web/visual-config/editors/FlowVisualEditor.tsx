import type { FlowSpec, FlowStep } from '@dar/contracts';
import type { ApiClient } from '../../api/client.js';
import { Alert, Button, Drawer, Form, Input, InputNumber, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@xyflow/react/dist/style.css';
import type { VisualEditorProps } from '../types.js';
import { JsonSchemaBuilder } from '../components/JsonSchemaBuilder.js';
import { StructuredValueEditor, jsonObjectFromUnknown, toJsonValue } from '../components/StructuredValueEditor.js';
import { ExactVersionSelect } from '../components/ExactVersionSelect.js';

const LazyFlowSequenceGraph = lazy(async () => {
  const mod = await import('@xyflow/react');
  return {
    default: function FlowSequenceGraph({ steps }: { steps: FlowStep[] }) {
      const graphSteps = [{ id: '__start__', type: 'start', label: '开始' }, ...steps.map((step, index) => ({
        id: step.id,
        type: step.type,
        label: `${index + 1}. ${step.name ?? step.id}`,
      })), { id: '__end__', type: 'end', label: '结束' }];
      const nodes = graphSteps.map((step, index) => ({
        id: step.id,
        position: { x: index * 220, y: 40 },
        data: { label: `${step.label}\n${step.type}` },
        draggable: false,
      }));
      const edges = graphSteps.slice(0, -1).map((step, index) => ({
        id: `${step.id}->${graphSteps[index + 1]?.id ?? 'end'}`,
        source: step.id,
        target: graphSteps[index + 1]?.id ?? '__end__',
      }));
      return (
        <div className="vc-flow-reactflow" data-testid="flow-sequence-canvas">
          <mod.ReactFlow
            nodes={nodes}
            edges={edges}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
          >
            <mod.Background />
          </mod.ReactFlow>
        </div>
      );
    },
  };
});

export function FlowVisualEditor({
  value,
  readOnly,
  onChange,
  client,
}: VisualEditorProps<FlowSpec> & { client: ApiClient }) {
  const { t } = useTranslation();
  const [editingIndex, setEditingIndex] = useState<number | undefined>();
  const editingStep = editingIndex === undefined ? undefined : value.steps[editingIndex];
  const columns: ColumnsType<FlowStep> = [
    { title: '#', key: 'order', render: (_, _row, index) => index + 1, width: 60 },
    { title: t('visualConfig.flow.stepId'), dataIndex: 'id', key: 'id' },
    { title: t('visualConfig.flow.stepType'), dataIndex: 'type', key: 'type', render: (type: string) => <Tag>{type}</Tag> },
    { title: 'tool', dataIndex: 'tool', key: 'tool', render: (value?: string) => value ?? '-' },
    { title: 'agent', dataIndex: 'agent_id', key: 'agent', render: (value?: string) => value ?? '-' },
    { title: 'activity', dataIndex: 'activity', key: 'activity', render: (value?: string) => value ?? '-' },
    {
      title: t('visualConfig.actions.actions'),
      key: 'actions',
      render: (_, _row, index) => (
        <Space>
          <Button data-testid={`vc-flow-step-edit-${index}`} size="small" onClick={() => setEditingIndex(index)}>{t('visualConfig.actions.edit')}</Button>
          <Button size="small" disabled={readOnly || index === 0} onClick={() => onChange({ ...value, steps: move(value.steps, index, index - 1) })}>↑</Button>
          <Button size="small" disabled={readOnly || index === value.steps.length - 1} onClick={() => onChange({ ...value, steps: move(value.steps, index, index + 1) })}>↓</Button>
          <Button size="small" disabled={readOnly} onClick={() => onChange({ ...value, steps: insertAt(value.steps, index + 1, duplicateStep(value.steps[index])) })}>{t('visualConfig.actions.copy')}</Button>
          <Button size="small" danger disabled={readOnly || value.steps.length <= 1} onClick={() => onChange({ ...value, steps: value.steps.filter((_, itemIndex) => itemIndex !== index) })}>×</Button>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Alert type="info" showIcon message={t('visualConfig.flow.sequenceOnly')} />
      <Form layout="vertical">
        <Form.Item label="flow_id"><Input data-testid="vc-flow-id" value={value.flow_id} disabled={readOnly} onChange={(event) => onChange({ ...value, flow_id: event.target.value })} /></Form.Item>
        <Form.Item label={t('visualConfig.common.version')}><InputNumber min={1} value={value.version} disabled={readOnly} onChange={(next) => onChange({ ...value, version: typeof next === 'number' ? next : value.version })} /></Form.Item>
        <Form.Item label={t('visualConfig.flow.name')}><Input value={value.name ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...value, name: event.target.value || undefined })} /></Form.Item>
        <Form.Item label={t('visualConfig.flow.description')}><Input.TextArea value={value.description ?? ''} disabled={readOnly} autoSize onChange={(event) => onChange({ ...value, description: event.target.value || undefined })} /></Form.Item>
        <Form.Item label="workflow_type"><Select value={value.runtime.workflow_type} disabled={readOnly} options={['ConfigDrivenWorkflow', 'GenericAgentWorkflow'].map((item) => ({ value: item, label: item }))} onChange={(workflow_type) => onChange({ ...value, runtime: { ...value.runtime, workflow_type } })} /></Form.Item>
        <Form.Item label="task_queue"><Input value={value.runtime.task_queue} disabled={readOnly} onChange={(event) => onChange({ ...value, runtime: { ...value.runtime, task_queue: event.target.value } })} /></Form.Item>
        <Form.Item label={t('visualConfig.flow.inputSchema')}><JsonSchemaBuilder value={jsonObjectFromUnknown(value.input_schema ?? { type: 'object' })} readOnly={readOnly} onChange={(input_schema) => onChange({ ...value, input_schema })} /></Form.Item>
        <Form.Item label={t('visualConfig.flow.outputSchema')}><JsonSchemaBuilder value={jsonObjectFromUnknown(value.output_schema ?? { type: 'object' })} readOnly={readOnly} onChange={(output_schema) => onChange({ ...value, output_schema })} /></Form.Item>
        <Form.Item label="metadata"><StructuredValueEditor value={toJsonValue(value.metadata ?? {})} readOnly={readOnly} onChange={(metadata) => onChange({ ...value, metadata: jsonObjectFromUnknown(metadata) })} /></Form.Item>
      </Form>
      <FlowSequenceCanvas steps={value.steps} />
      <Space wrap>
        {(['activity', 'tool', 'agent', 'human_task', 'condition'] as const).map((type) => (
          <Button key={type} data-testid={`vc-flow-add-step-${type}`} disabled={readOnly} onClick={() => onChange({ ...value, steps: [...value.steps, defaultStep(type, value.steps.length + 1)] })}>
            {t('visualConfig.flow.addStep', { type })}
          </Button>
        ))}
      </Space>
      <Table rowKey="id" size="small" dataSource={value.steps} columns={columns} pagination={{ pageSize: 20 }} />
      <Drawer
        title={editingStep ? `${editingStep.id} · ${editingStep.type}` : t('visualConfig.flow.stepDrawer')}
        open={Boolean(editingStep)}
        onClose={() => setEditingIndex(undefined)}
        extra={<Button data-testid="vc-flow-step-done" onClick={() => setEditingIndex(undefined)}>{t('visualConfig.actions.done')}</Button>}
        width={760}
      >
        {editingStep && editingIndex !== undefined ? (
          <FlowStepPropertyDrawer
            step={editingStep}
            readOnly={readOnly}
            client={client}
            onChange={(nextStep) => onChange({ ...value, steps: value.steps.map((step, index) => (index === editingIndex ? nextStep : step)) })}
          />
        ) : null}
      </Drawer>
    </Space>
  );
}

function FlowSequenceCanvas({ steps }: { steps: FlowStep[] }) {
  return (
    <Suspense fallback={<FlowSequenceFallback steps={steps} />}>
      <LazyFlowSequenceGraph steps={steps} />
    </Suspense>
  );
}

function FlowSequenceFallback({ steps }: { steps: FlowStep[] }) {
  return (
    <div className="vc-flow-sequence">
      <div className="vc-flow-node">开始</div>
      {steps.map((step, index) => <div className="vc-flow-node" key={`${step.id}:${index}`}>{index + 1}. {step.name ?? step.id}</div>)}
      <div className="vc-flow-node">结束</div>
    </div>
  );
}

function FlowStepPropertyDrawer({
  step,
  readOnly,
  client,
  onChange,
}: {
  step: FlowStep;
  readOnly: boolean;
  client: ApiClient;
  onChange(step: FlowStep): void;
}) {
  const toolValue = step.tool ? { resource_id: step.tool, version: step.tool_version ?? '' } : undefined;
  const agentVersion = numberFromInput(step.input?.agent_version);
  const agentValue = step.agent_id ? { resource_id: step.agent_id, version: agentVersion ?? '' } : undefined;
  return (
    <Form layout="vertical">
      <Form.Item label="id"><Input value={step.id} disabled={readOnly} onChange={(event) => onChange({ ...step, id: event.target.value })} /></Form.Item>
      <Form.Item label="name"><Input value={step.name ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...step, name: event.target.value || undefined })} /></Form.Item>
      <Form.Item label="type"><Select value={step.type} disabled={readOnly} options={['activity', 'tool', 'agent', 'human_task', 'condition'].map((item) => ({ value: item, label: item }))} onChange={(type) => onChange({ ...step, type })} /></Form.Item>
      <Form.Item label="when"><Input value={step.when ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...step, when: event.target.value || undefined })} /></Form.Item>
      {step.type === 'activity' ? <Form.Item label="activity"><Input value={step.activity ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...step, activity: event.target.value || undefined })} /></Form.Item> : null}
      {step.type === 'tool' ? (
        <>
          <Form.Item label="tool">
            <ExactVersionSelect
              client={client}
              resourceType="tool"
              status="published"
              testId="vc-flow-step-tool-ref"
              readOnly={readOnly}
              {...(toolValue ? { value: toolValue } : {})}
              onChange={(next) => {
                if (next) {
                  onChange({ ...step, tool: next.resource_id, tool_version: String(next.version) });
                }
              }}
            />
          </Form.Item>
          <Form.Item label="mode"><Input data-testid="vc-flow-step-tool-mode" value={step.mode ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...step, mode: event.target.value || undefined })} /></Form.Item>
          <Form.Item label="risk_level"><Select allowClear value={step.risk_level} disabled={readOnly} options={['L0', 'L1', 'L2', 'L3', 'L4'].map((item) => ({ value: item, label: item }))} onChange={(risk_level) => onChange({ ...step, risk_level })} /></Form.Item>
        </>
      ) : null}
      {step.type === 'agent' ? (
        <Form.Item label="agent">
          <ExactVersionSelect
            client={client}
            resourceType="agent"
            status="published"
            testId="vc-flow-step-agent-ref"
            readOnly={readOnly}
            {...(agentValue ? { value: agentValue } : {})}
            onChange={(next) => {
              if (next && typeof next.version === 'number') {
                onChange({ ...step, agent_id: next.resource_id, input: { ...(step.input ?? {}), agent_version: next.version } });
              }
            }}
          />
        </Form.Item>
      ) : null}
      <Form.Item label="input"><StructuredValueEditor value={toJsonValue(step.input ?? {})} readOnly={readOnly} onChange={(input) => onChange({ ...step, input: jsonObjectFromUnknown(input) })} /></Form.Item>
      <Form.Item label="output_ref"><Input value={step.output_ref ?? ''} disabled={readOnly} onChange={(event) => onChange({ ...step, output_ref: event.target.value || undefined })} /></Form.Item>
      <Form.Item label="on_failure"><StructuredValueEditor value={toJsonValue(step.on_failure ?? {})} readOnly={readOnly} onChange={(on_failure) => onChange({ ...step, on_failure: jsonObjectFromUnknown(on_failure) })} /></Form.Item>
    </Form>
  );
}

function defaultStep(type: FlowStep['type'], order: number): FlowStep {
  const base: FlowStep = { id: `step_${order}`, type, input: {} };
  if (type === 'activity') {
    return { ...base, activity: 'activity.name' };
  }
  if (type === 'tool') {
    return { ...base, mode: 'preview', risk_level: 'L1' };
  }
  if (type === 'agent') {
    return { ...base, input: { agent_version: 1 } };
  }
  return base;
}

function duplicateStep(step: FlowStep | undefined): FlowStep {
  const copy = structuredClone(step ?? defaultStep('activity', 1));
  return { ...copy, id: `${copy.id}_copy` };
}

function insertAt<T>(values: T[], index: number, item: T): T[] {
  const next = [...values];
  next.splice(index, 0, item);
  return next;
}

function move<T>(values: T[], from: number, to: number): T[] {
  const next = [...values];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(to, 0, item);
  }
  return next;
}

function numberFromInput(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
