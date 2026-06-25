import type { IamTenant } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Drawer, Form, Input, Space, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import {
  listTenants,
  createTenant,
  updateTenant,
  activateTenant,
  disableTenant,
  listMemberships,
  createMembership,
  listUsers,
} from '../../api/iam-api.js';
import { formatDateTime } from '../../utils/format.js';
import { useIdentity } from '../../auth/identity-context.js';

export function TenantsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { hasPermission } = useIdentity();
  const canWrite = hasPermission('iam:write');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTenant, setEditTenant] = useState<IamTenant | undefined>();
  const [memberTenant, setMemberTenant] = useState<IamTenant | undefined>();

  const query = useQuery({
    queryKey: ['iam-tenants', page],
    queryFn: () => listTenants(client, { page: String(page), page_size: '20' }),
  });

  const createMut = useMutation({
    mutationFn: (data: { tenant_id: string; display_name: string; description: string }) => createTenant(client, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['iam-tenants'] }); setCreateOpen(false); message.success('租户已创建'); },
  });

  const updateMut = useMutation({
    mutationFn: ({ tenantId, data }: { tenantId: string; data: Record<string, unknown> }) => updateTenant(client, tenantId, data as Parameters<typeof updateTenant>[2]),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['iam-tenants'] }); setEditTenant(undefined); message.success('租户已更新'); },
  });

  const statusMut = useMutation({
    mutationFn: ({ tenantId, action }: { tenantId: string; action: 'activate' | 'disable' }) =>
      action === 'activate' ? activateTenant(client, tenantId) : disableTenant(client, tenantId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['iam-tenants'] }); message.success('状态已更新'); },
  });

  const columns: ColumnsType<IamTenant> = [
    { title: 'tenant_id', dataIndex: 'tenant_id', key: 'tenant_id' },
    { title: '名称', dataIndex: 'display_name', key: 'display_name' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (v: string) => <Tag color={v === 'active' ? 'green' : 'red'}>{v === 'active' ? '活跃' : '已禁用'}</Tag> },
    { title: '版本', dataIndex: 'revision', key: 'revision' },
    { title: '创建时间', dataIndex: 'created_at', key: 'created_at', render: formatDateTime },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
    ...(canWrite ? [{
      title: '操作', key: 'actions', render: (_: unknown, record: IamTenant) => (
        <Space>
          <Button size="small" onClick={() => setEditTenant(record)}>编辑</Button>
          <Button size="small" onClick={() => setMemberTenant(record)}>成员</Button>
          {record.status === 'active'
            ? <Button size="small" danger onClick={() => statusMut.mutate({ tenantId: record.tenant_id, action: 'disable' })}>禁用</Button>
            : <Button size="small" onClick={() => statusMut.mutate({ tenantId: record.tenant_id, action: 'activate' })}>启用</Button>}
        </Space>
      ),
    }] : []),
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div><h1>租户管理</h1><p>管理平台租户目录。</p></div>
        {canWrite && <Button type="primary" onClick={() => setCreateOpen(true)}>创建租户</Button>}
      </div>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="tenant_id"
          loading={query.isLoading}
          columns={columns}
          dataSource={query.data?.items ?? []}
          pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: setPage }}
          locale={{ emptyText: <EmptyState description="暂无租户" /> }}
        />
      </section>
      <Drawer title="创建租户" open={createOpen} onClose={() => setCreateOpen(false)} width={480}>
        <Form layout="vertical" onFinish={(v) => createMut.mutate(v)}>
          <Form.Item name="tenant_id" label="Tenant ID" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="display_name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={3} /></Form.Item>
          <Button type="primary" htmlType="submit" loading={createMut.isPending}>创建</Button>
        </Form>
      </Drawer>
      <EditTenantDrawer tenant={editTenant} onClose={() => setEditTenant(undefined)} onSave={(data) => updateMut.mutate({ tenantId: editTenant!.tenant_id, data })} />
      <MemberDrawer tenant={memberTenant} onClose={() => setMemberTenant(undefined)} client={client} />
    </div>
  );
}

function EditTenantDrawer({ tenant, onClose, onSave }: { tenant: IamTenant | undefined; onClose: () => void; onSave: (data: Record<string, unknown>) => void }) {
  if (!tenant) return null;
  return (
    <Drawer title={`编辑 ${tenant.tenant_id}`} open={!!tenant} onClose={onClose} width={480}>
      <Form layout="vertical" initialValues={tenant} onFinish={(v) => onSave({ ...v, expected_revision: tenant.revision })}>
        <Form.Item name="display_name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="description" label="描述"><Input.TextArea rows={3} /></Form.Item>
        <Button type="primary" htmlType="submit">保存</Button>
      </Form>
    </Drawer>
  );
}

function MemberDrawer({ tenant, onClose, client }: { tenant: IamTenant | undefined; onClose: () => void; client: ReturnType<typeof useApiClient> }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const membersQuery = useQuery({
    queryKey: ['iam-memberships', tenant?.tenant_id],
    queryFn: () => listMemberships(client, { tenant_id: tenant!.tenant_id, page_size: '100' }),
    enabled: !!tenant,
  });

  const usersQuery = useQuery({
    queryKey: ['iam-users-for-member'],
    queryFn: () => listUsers(client, { page_size: '100', status: 'active' }),
    enabled: addOpen,
  });

  const addMut = useMutation({
    mutationFn: (data: { user_id: string; roles: string[] }) => createMembership(client, { tenant_id: tenant!.tenant_id, ...data }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['iam-memberships'] }); setAddOpen(false); message.success('成员已添加'); },
  });

  if (!tenant) return null;
  const members = membersQuery.data?.items ?? [];
  const users = usersQuery.data?.items ?? [];

  return (
    <Drawer title={`成员管理: ${tenant.tenant_id}`} open={!!tenant} onClose={onClose} width={600}>
      <Button type="primary" onClick={() => setAddOpen(true)} style={{ marginBottom: 16 }}>添加成员</Button>
      <Table
        rowKey={(r) => `${r.tenant_id}/${r.user_id}`}
        loading={membersQuery.isLoading}
        columns={[
          { title: '用户', dataIndex: 'user_id' },
          { title: '角色', dataIndex: 'roles', render: (v: string[]) => v.length > 0 ? v.join(', ') : '普通成员' },
          { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'active' ? 'green' : 'red'}>{v}</Tag> },
        ]}
        dataSource={members}
        pagination={false}
      />
      <Drawer title="添加成员" open={addOpen} onClose={() => setAddOpen(false)} width={400}>
        <Form layout="vertical" onFinish={(v) => addMut.mutate({ user_id: v.user_id, roles: v.roles ?? [] })}>
          <Form.Item name="user_id" label="用户" rules={[{ required: true }]}>
            <select style={{ width: '100%', height: 32 }}>
              <option value="">选择用户</option>
              {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.display_name} ({u.user_id})</option>)}
            </select>
          </Form.Item>
          <Form.Item name="roles" label="角色（留空为普通成员）">
            <Input placeholder="capability_operator, auditor" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={addMut.isPending}>添加</Button>
        </Form>
      </Drawer>
    </Drawer>
  );
}
