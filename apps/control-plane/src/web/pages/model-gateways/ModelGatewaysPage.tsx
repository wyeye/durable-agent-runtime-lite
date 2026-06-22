import type {
  ModelGatewayConnectionTestResponse,
  ModelGatewayProfile,
  ModelGatewayProfileCreateRequest,
} from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { useApiClient } from '../../api/use-api-client.js';
import { StatusTag } from '../../components/StatusTag.js';

interface GatewayCreateForm extends ModelGatewayProfileCreateRequest {
  probe_model_id?: string;
}

interface ListResponse<T> {
  items: T[];
}

export function ModelGatewaysPage() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [createOpen, setCreateOpen] = useState(false);
  const [rotateProfile, setRotateProfile] = useState<ModelGatewayProfile | undefined>();
  const [testResult, setTestResult] = useState<ModelGatewayConnectionTestResponse | undefined>();
  const [createForm] = Form.useForm<GatewayCreateForm>();
  const [rotateForm] = Form.useForm<{ api_key: string }>();

  const query = useQuery({
    queryKey: ['model-gateways'],
    queryFn: () => apiClient.request<ListResponse<ModelGatewayProfile>>('/api/v1/model-gateways'),
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['model-gateways'] });
  };

  const createMutation = useMutation({
    mutationFn: (body: GatewayCreateForm) => apiClient.request<ModelGatewayProfile>('/api/v1/model-gateways', {
      method: 'POST',
      body: {
        profile_id: body.profile_id,
        display_name: body.display_name,
        protocol: 'openai_chat_completions',
        base_url: body.base_url,
        auth_type: body.auth_type,
        ...(body.api_key ? { api_key: body.api_key } : {}),
      },
    }),
    onSuccess: async (profile, values) => {
      await apiClient.request<ModelGatewayProfile>(`/api/v1/model-gateways/${encodeURIComponent(profile.profile_id)}/publish`, { method: 'POST', body: {} });
      if (values.probe_model_id) {
        const result = await apiClient.request<ModelGatewayConnectionTestResponse>(`/api/v1/model-gateways/${encodeURIComponent(profile.profile_id)}/test-connection`, {
          method: 'POST',
          body: { probe_model_id: values.probe_model_id },
        });
        setTestResult(result);
      }
      message.success('模型网关已保存');
      setCreateOpen(false);
      createForm.resetFields();
      await refresh();
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (body: { api_key: string }) => apiClient.request<ModelGatewayProfile>(
      `/api/v1/model-gateways/${encodeURIComponent(rotateProfile!.profile_id)}/rotate-credential`,
      { method: 'POST', body },
    ),
    onSuccess: async () => {
      message.success('凭据已轮换');
      setRotateProfile(undefined);
      rotateForm.resetFields();
      await refresh();
    },
  });

  const testMutation = useMutation({
    mutationFn: (profile: ModelGatewayProfile) => apiClient.request<ModelGatewayConnectionTestResponse>(
      `/api/v1/model-gateways/${encodeURIComponent(profile.profile_id)}/test-connection`,
      { method: 'POST', body: { probe_model_id: 'dar-local-model' } },
    ),
    onSuccess: (result) => setTestResult(result),
  });

  const columns: ColumnsType<ModelGatewayProfile> = [
    { title: '名称', dataIndex: 'display_name', key: 'display_name' },
    { title: 'Profile ID', dataIndex: 'profile_id', key: 'profile_id' },
    { title: 'Base URL', dataIndex: 'base_url', key: 'base_url' },
    { title: '协议', dataIndex: 'protocol', key: 'protocol' },
    { title: '认证', dataIndex: 'auth_type', key: 'auth_type' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (status) => <StatusTag status={String(status)} /> },
    {
      title: '凭据',
      key: 'credential',
      render: (_, row) => row.auth_type === 'none'
        ? <Tag>none</Tag>
        : <Space><Tag color={row.credential_configured ? 'green' : 'red'}>{row.credential_configured ? '已配置' : '未配置'}</Tag><span>{row.credential_fingerprint ?? '-'}</span><span>v{row.credential_revision}</span></Space>,
    },
    {
      title: '操作',
      key: 'actions',
      render: (_, row) => (
        <Space>
          <Button size="small" onClick={() => testMutation.mutate(row)} loading={testMutation.isPending}>测试</Button>
          {row.auth_type === 'bearer' ? <Button size="small" onClick={() => setRotateProfile(row)}>轮换</Button> : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space>
        <Button type="primary" onClick={() => setCreateOpen(true)}>新建模型网关</Button>
        <Button onClick={() => query.refetch()} loading={query.isFetching}>刷新</Button>
      </Space>
      <Table rowKey="profile_id" columns={columns} dataSource={query.data?.items ?? []} loading={query.isLoading} />
      <Modal
        title="新建模型网关"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={createMutation.isPending}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" onFinish={(values) => createMutation.mutate(values)} initialValues={{ protocol: 'openai_chat_completions', auth_type: 'bearer' }}>
          <Form.Item name="profile_id" label="Profile ID" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="display_name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="base_url" label="Base URL" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="auth_type" label="认证方式"><Select options={[{ value: 'bearer', label: 'bearer' }, { value: 'none', label: 'none' }]} /></Form.Item>
          <Form.Item name="api_key" label="API Key"><Input.Password autoComplete="new-password" /></Form.Item>
          <Form.Item name="probe_model_id" label="Probe Model ID"><Input /></Form.Item>
        </Form>
      </Modal>
      <Modal
        title="轮换 API Key"
        open={Boolean(rotateProfile)}
        onCancel={() => setRotateProfile(undefined)}
        onOk={() => rotateForm.submit()}
        confirmLoading={rotateMutation.isPending}
        destroyOnHidden
      >
        <Form form={rotateForm} layout="vertical" onFinish={(values) => rotateMutation.mutate(values)}>
          <Form.Item name="api_key" label="新 API Key" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
        </Form>
      </Modal>
      <Modal title="连接测试结果" open={Boolean(testResult)} onCancel={() => setTestResult(undefined)} onOk={() => setTestResult(undefined)}>
        {testResult ? <pre>{JSON.stringify(testResult, null, 2)}</pre> : null}
      </Modal>
    </Space>
  );
}
