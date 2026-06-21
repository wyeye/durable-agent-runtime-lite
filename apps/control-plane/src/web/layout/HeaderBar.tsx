import { Button, Form, Input, Popover, Select, Space, Tag, Typography } from 'antd';
import { useState } from 'react';
import type { ControlPlaneIdentity } from '../auth/identity-context.js';
import { useIdentity } from '../auth/identity-context.js';
import { displayRole } from '../utils/i18n-labels.js';

const roleOptions = [
  { value: 'platform_admin', label: displayRole('platform_admin') },
  { value: 'capability_operator', label: displayRole('capability_operator') },
  { value: 'auditor', label: displayRole('auditor') },
];

export function HeaderBar() {
  const { identity, setIdentity, clearIdentity } = useIdentity();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<ControlPlaneIdentity>();

  const content = (
    <Form
      form={form}
      layout="vertical"
      initialValues={identity ?? { user_id: '', tenant_id: '', roles: [] }}
      onFinish={(values) => {
        setIdentity({
          user_id: values.user_id.trim(),
          tenant_id: values.tenant_id.trim(),
          roles: values.roles,
        });
        setOpen(false);
      }}
      style={{ width: 320 }}
    >
      <Form.Item
        label="user_id"
        name="user_id"
        rules={[{ required: true, message: '请输入 user_id' }]}
      >
        <Input data-testid="identity-user" />
      </Form.Item>
      <Form.Item
        label="tenant_id"
        name="tenant_id"
        rules={[{ required: true, message: '请输入 tenant_id' }]}
      >
        <Input data-testid="identity-tenant" />
      </Form.Item>
      <Form.Item
        label="roles"
        name="roles"
        rules={[{ required: true, message: '请选择角色' }]}
      >
        <Select
          data-testid="identity-roles"
          mode="multiple"
          options={roleOptions}
        />
      </Form.Item>
      <Space>
        <Button type="primary" htmlType="submit" data-testid="identity-save">保存身份</Button>
        <Button
          onClick={() => {
            clearIdentity();
            setOpen(false);
          }}
        >
          清除
        </Button>
      </Space>
    </Form>
  );

  return (
    <header className="cp-header">
      <div className="cp-brand">
        <strong>智能体运行平台</strong>
        <span>Durable Agent Runtime Lite</span>
      </div>
      <Space wrap>
        {identity ? (
          <>
            <Tag color="blue">{identity.tenant_id}</Tag>
            <Typography.Text>{identity.user_id}</Typography.Text>
            {identity.roles.map((role) => <Tag key={role}>{displayRole(role)}</Tag>)}
          </>
        ) : (
          <Tag color="red">未配置身份</Tag>
        )}
        <Popover
          trigger="click"
          open={open}
          onOpenChange={(next) => {
            form.setFieldsValue(identity ?? { user_id: '', tenant_id: '', roles: [] });
            setOpen(next);
          }}
          title="开发身份"
          content={content}
        >
          <Button data-testid="identity-panel">身份</Button>
        </Popover>
      </Space>
    </header>
  );
}
