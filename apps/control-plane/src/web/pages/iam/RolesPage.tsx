import { useQuery } from '@tanstack/react-query';
import { Card, Table, Tag, Typography } from 'antd';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import { fetchRoleCatalog } from '../../api/iam-api.js';

export function RolesPage() {
  const client = useApiClient();

  const query = useQuery({
    queryKey: ['iam-roles'],
    queryFn: () => fetchRoleCatalog(client),
  });

  const allRoles = [
    ...(query.data?.roles ?? []),
    ...(query.data?.membership_roles ?? []),
  ];

  const columns = [
    { title: '角色', dataIndex: 'role', key: 'role', render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: '作用域', dataIndex: 'scope', key: 'scope', render: (v: string) => <Tag>{v === 'global' ? '全局' : '租户'}</Tag> },
    { title: '说明', dataIndex: 'description', key: 'description' },
    { title: 'IAM 管理', dataIndex: 'can_manage_iam', key: 'can_manage_iam', render: (v: boolean) => v ? <Tag color="green">是</Tag> : <Tag>否</Tag> },
    { title: '写能力注册', dataIndex: 'can_write_registry', key: 'can_write_registry', render: (v: boolean) => v ? <Tag color="green">是</Tag> : <Tag>否</Tag> },
    { title: '人工任务', dataIndex: 'can_handle_human_task', key: 'can_handle_human_task', render: (v: boolean) => v ? <Tag color="green">是</Tag> : <Tag>否</Tag> },
    { title: '只读', dataIndex: 'is_read_only', key: 'is_read_only', render: (v: boolean) => v ? <Tag color="orange">是</Tag> : <Tag>否</Tag> },
    { title: '运行时', dataIndex: 'can_use_runtime', key: 'can_use_runtime', render: (v: boolean) => v ? <Tag color="green">是</Tag> : <Tag>否</Tag> },
  ];

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>角色说明</h1>
          <p>查看系统固定角色和权限。本阶段不支持自定义角色。</p>
        </div>
      </div>
      {query.error ? <ErrorAlert error={query.error} /> : null}
      <section className="cp-section">
        <Card title="全局角色（platform_admin）" style={{ marginBottom: 16 }}>
          <p><strong>platform_admin</strong> 是全局平台管理员，可管理所有租户、用户、成员关系和角色分配。拥有所有权限。</p>
        </Card>
        <Card title="成员关系角色" style={{ marginBottom: 16 }}>
          <p>以下角色通过租户成员关系分配，仅在对应租户内生效：</p>
          <ul>
            <li><strong>capability_operator</strong> - 租户级能力运营员：管理能力注册、发布、运营操作和人工任务。</li>
            <li><strong>auditor</strong> - 租户级审计员：只读查看配置、运行、评测和审计。</li>
            <li><strong>（普通成员）</strong> - 角色列表为空的成员：可使用运行时入口，可查看自己的运行数据。</li>
          </ul>
        </Card>
      </section>
      <section className="cp-section">
        <Typography.Title level={4}>权限矩阵</Typography.Title>
        <Table
          rowKey="role"
          loading={query.isLoading}
          columns={columns}
          dataSource={allRoles}
          pagination={false}
          locale={{ emptyText: <EmptyState description="暂无角色数据" /> }}
        />
      </section>
    </div>
  );
}
