import type {
  ModelDefinition,
  ModelDefinitionCreateDraftRequest,
  ModelGatewayProfile,
} from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useApiClient } from '../../api/use-api-client.js';
import { StatusTag } from '../../components/StatusTag.js';

interface ListResponse<T> {
  items: T[];
}

export function ModelsPage() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<ModelDefinitionCreateDraftRequest>();
  const selectedCapabilities = Form.useWatch('capabilities', form) ?? [];
  const isEmbeddingModel = selectedCapabilities.includes('embeddings');

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: () => apiClient.request<ListResponse<ModelDefinition>>('/api/v1/models', { query: { page_size: 100 } }),
  });
  const gatewaysQuery = useQuery({
    queryKey: ['model-gateways'],
    queryFn: () => apiClient.request<ListResponse<ModelGatewayProfile>>('/api/v1/model-gateways', { query: { status: 'published', page_size: 100 } }),
  });

  const createMutation = useMutation({
    mutationFn: (body: ModelDefinitionCreateDraftRequest) => apiClient.request<ModelDefinition>('/api/v1/models', { method: 'POST', body }),
    onSuccess: async (model) => {
      await apiClient.request<ModelDefinition>(`/api/v1/models/${encodeURIComponent(model.model_id)}/versions/${model.version}/validate`, { method: 'POST', body: {} });
      await apiClient.request<ModelDefinition>(`/api/v1/models/${encodeURIComponent(model.model_id)}/versions/${model.version}/publish`, { method: 'POST', body: {} });
      message.success('模型已发布');
      setCreateOpen(false);
      form.resetFields();
      await queryClient.invalidateQueries({ queryKey: ['models'] });
    },
  });

  const columns: ColumnsType<ModelDefinition> = [
    { title: '显示名称', dataIndex: 'display_name', key: 'display_name' },
    { title: '模型 ID', dataIndex: 'model_id', key: 'model_id' },
    { title: '版本', dataIndex: 'version', key: 'version' },
    { title: '上游 Model ID', dataIndex: 'upstream_model_id', key: 'upstream_model_id' },
    { title: '模型网关', dataIndex: 'gateway_profile_id', key: 'gateway_profile_id' },
    { title: 'Provider', dataIndex: 'provider', key: 'provider' },
    { title: '能力', dataIndex: 'capabilities', key: 'capabilities', render: (values: string[]) => <Space>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> },
    { title: '向量维度', dataIndex: 'embedding_dimensions', key: 'embedding_dimensions', render: (value?: number) => value ?? '-' },
    { title: '上下文窗口', dataIndex: 'context_window', key: 'context_window' },
    { title: '最大输出', dataIndex: 'max_output_tokens', key: 'max_output_tokens' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (status) => <StatusTag status={String(status)} /> },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space>
        <Button type="primary" onClick={() => setCreateOpen(true)}>新建模型</Button>
        <Button onClick={() => modelsQuery.refetch()} loading={modelsQuery.isFetching}>刷新</Button>
      </Space>
      <Table rowKey={(row) => `${row.model_id}@${row.version}`} columns={columns} dataSource={modelsQuery.data?.items ?? []} loading={modelsQuery.isLoading} />
      <Modal
        title="新建模型"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={createMutation.isPending}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => createMutation.mutate(values)}
          initialValues={{ version: 1, capabilities: ['text', 'tools', 'usage'], context_window: 32768, max_output_tokens: 4096, input_cost_per_million: 0, output_cost_per_million: 0, currency: 'USD' }}
        >
          <Form.Item name="model_id" label="Model ID" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="version" label="版本" rules={[{ required: true }]}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="display_name" label="显示名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="gateway_profile_id" label="模型网关" rules={[{ required: true }]}>
            <Select options={(gatewaysQuery.data?.items ?? []).map((gateway) => ({ value: gateway.profile_id, label: `${gateway.display_name} (${gateway.profile_id})` }))} />
          </Form.Item>
          <Form.Item name="upstream_model_id" label="上游 Model ID" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="provider" label="Provider" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="capabilities" label="能力"><Select mode="multiple" options={['text', 'tools', 'usage', 'tool_choice', 'json_schema', 'streaming', 'embeddings'].map((value) => ({ value, label: value }))} /></Form.Item>
          <Form.Item name="context_window" label="Context Window"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="max_output_tokens" label="Max Output Tokens"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          {isEmbeddingModel ? (
            <Form.Item name="embedding_dimensions" label="Embedding Dimensions" rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
          ) : null}
          <Form.Item name="input_cost_per_million" label="输入价格/百万"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="output_cost_per_million" label="输出价格/百万"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="currency" label="Currency"><Input /></Form.Item>
          <Form.Item name="tags" label="Tags"><Select mode="tags" /></Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
