import type { IamUserAccount } from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Drawer, Form, Input, Modal, Space, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import {
  listUsers,
  createUser,
  updateUser,
  activateUser,
  disableUser,
  listMemberships,
} from '../../api/iam-api.js';
import { formatDateTime } from '../../utils/format.js';
import { useIdentity } from '../../auth/identity-context.js';

export function UsersPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { hasPermission } = useIdentity();
  const canWrite = hasPermission('iam:write');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser] = useState<IamUserAccount | undefined>();
  const [memberUser, setMemberUser] = useState<IamUserAccount | undefined>();

  const query = useQuery({
    queryKey: ['iam-users', page],
    queryFn: () => listUsers(client, { page: String(page), page_size: '20' }),
  });

  const createMut = useMutation({
    mutationFn: (data: { user_id: string; display_name: string; email?: string; platform_roles: string[] }) => createUser(client, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['iam-users'] }); setCreateOpen(false); message.success('用户已创建'); },
  });

  const updateMut = useMutation({
    mutationFn: ({ userId, data }: { userId: string; data: Record<string, unknown> }) => updateUser(client, userId, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['iam-users'] }); setEditUser(undefined); message.success('用户已更新'); },
  });

  const statusMut = useMutation({
    mutationFn: ({ userId, action }: { userId: string; action: 'activate' | 'disable' }) =>
      action === 'activate' ? activateUser(client, userId) : disableUser(client, userId),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['iam-users'] }); message.success('状态已更新'); },
    onError: (err: Error & { code?: string }) => {
      if (err.code === 'IAM_LAST_PLATFORM_ADMIN_REQUIRED') {
        message.error('至少需要保留一个活跃的平台管理员');
      }
    },
  });

  const columns: ColumnsType<IamUserAccount> = [
    { title: 'user_id', dataIndex: 'user_id', key: 'user_id' },
    { title: '姓名', dataIndex: 'display_name', key: 'display_name' },
    { title: '邮箱', dataIndex: 'email', key: 'email', render: (v: string | null) => v ?? '-' },
    { title: '状态', dataIndex: 'status', key: 'status', render: (v: string) => <Tag color={v === 'active' ? 'green' : 'red'}>{v === 'active' ? '活跃' : '已禁用'}</Tag> },
    { title: '全局角色', dataIndex: 'platform_roles', key: 'platform_roles', render: (v: string[]) => v.length > 0 ? v.map((r) => <Tag key={r} color="blue">{r}</Tag>) : '-' },
    { title: '更新时间', dataIndex: 'updated_at', key: 'updated_at', render: formatDateTime },
    ...(canWrite ? [{
      title: '操作', key: 'actions', render: (_: unknown, record: IamUserAccount) => (
        <Space>
          <Button size="small" onClick={() => setEditUser(record)}>编辑</Button>
          <Button size="small" onClick={() => setMemberUser(record)}>成员关系</Button>
          {record.status === 'active'
            ? <Button size="small" danger onClick={() => statusMut.mutate({ userId: record.user_id, action: 'disable' })}>禁用</Button>
            : <Button size="small" onClick={() => statusMut.mutate({ userId: record.user_id, action: 'activate' })}>启用</Button>}
        </Space>
      ),
    }] : []),
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div><h1>用户管理</h1><p>管理平台用户目录。</p></div>
        {canWrite && <Button type="primary" onClick={() => setCreateOpen(true)}>创建用户</Button>}
      </div>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      <section className="cp-section">
        <Table
          rowKey="user_id"
          loading={query.isLoading}
          columns={columns}
          dataSource={query.data?.items ?? []}
          pagination={{ current: page, pageSize: 20, total: query.data?.total ?? 0, onChange: setPage }}
          locale={{ emptyText: <EmptyState description="暂无用户" /> }}
        />
      </section>
      <Drawer title="创建用户" open={createOpen} onClose={() => setCreateOpen(false)} width={480}>
        <Form layout="vertical" onFinish={(v) => createMut.mutate({ ...v, platform_roles: v.platform_role === 'yes' ? ['platform_admin'] : [] })}>
          <Form.Item name="user_id" label="User ID" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="display_name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="email" label="邮箱"><Input /></Form.Item>
          <Form.Item name="platform_role" label="平台管理员">
            <select style={{ width: '100%', height: 32 }}>
              <option value="no">否</option>
              <option value="yes">是（高风险操作）</option>
            </select>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={createMut.isPending}>创建</Button>
        </Form>
      </Drawer>
      <EditUserDrawer user={editUser} onClose={() => setEditUser(undefined)} onSave={(data) => updateMut.mutate({ userId: editUser!.user_id, data })} />
      <UserMemberDrawer user={memberUser} onClose={() => setMemberUser(undefined)} client={client} />
    </div>
  );
}

function EditUserDrawer({ user, onClose, onSave }: { user: IamUserAccount | undefined; onClose: () => void; onSave: (data: Record<string, unknown>) => void }) {
  if (!user) return null;
  return (
    <Drawer title={`编辑 ${user.user_id}`} open={!!user} onClose={onClose} width={480}>
      <Form layout="vertical" initialValues={user} onFinish={(v) => {
        const data: Record<string, unknown> = { ...v, expected_revision: user.revision };
        if (v.platform_role === 'yes' && !user.platform_roles.includes('platform_admin')) {
          Modal.confirm({
            title: '确认授予平台管理员',
            content: '此操作将授予用户全局管理权限。确认继续？',
            onOk: () => { data.platform_roles = ['platform_admin']; onSave(data); },
          });
          return;
        }
        if (v.platform_role === 'no' && user.platform_roles.includes('platform_admin')) {
          data.platform_roles = [];
        }
        onSave(data);
      }}>
        <Form.Item name="display_name" label="姓名" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="email" label="邮箱"><Input /></Form.Item>
        <Form.Item name="platform_role" label="平台管理员" initialValue={user.platform_roles.includes('platform_admin') ? 'yes' : 'no'}>
          <select style={{ width: '100%', height: 32 }}>
            <option value="no">否</option>
            <option value="yes">是（高风险操作）</option>
          </select>
        </Form.Item>
        <Button type="primary" htmlType="submit">保存</Button>
      </Form>
    </Drawer>
  );
}

function UserMemberDrawer({ user, onClose, client }: { user: IamUserAccount | undefined; onClose: () => void; client: ReturnType<typeof useApiClient> }) {
  const membersQuery = useQuery({
    queryKey: ['iam-user-memberships', user?.user_id],
    queryFn: () => listMemberships(client, { user_id: user!.user_id, page_size: '100' }),
    enabled: !!user,
  });

  if (!user) return null;

  return (
    <Drawer title={`成员关系: ${user.user_id}`} open={!!user} onClose={onClose} width={600}>
      <Table
        rowKey={(r) => `${r.tenant_id}/${r.user_id}`}
        loading={membersQuery.isLoading}
        columns={[
          { title: '租户', dataIndex: 'tenant_id' },
          { title: '角色', dataIndex: 'roles', render: (v: string[]) => v.length > 0 ? v.join(', ') : '普通成员' },
          { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'active' ? 'green' : 'red'}>{v}</Tag> },
        ]}
        dataSource={membersQuery.data?.items ?? []}
        pagination={false}
        locale={{ emptyText: <EmptyState description="暂无成员关系" /> }}
      />
    </Drawer>
  );
}
