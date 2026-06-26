import { useMemo } from 'react';
import { Alert, App, Button, Card, Form, Input, Space, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { ApiClient } from '../api/client.js';
import { localDevLogin } from '../api/auth-api.js';
import { fromResolvedIdentity, useIdentity } from '../auth/identity-context.js';
import { toFriendlyError } from '../utils/errors.js';

interface LoginFormValues {
  user_id: string;
  tenant_id: string;
  password: string;
}

const initialValues: LoginFormValues = {
  user_id: 'dev_admin',
  tenant_id: 'development',
  password: '',
};

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = App.useApp();
  const { setIdentity } = useIdentity();
  const [form] = Form.useForm<LoginFormValues>();

  const client = useMemo(() => new ApiClient({ getIdentity: () => undefined }), []);
  const nextPath = useMemo(() => {
    const params = new URLSearchParams(location.search);
    const next = params.get('next');
    return next && next.startsWith('/') ? next : '/chat';
  }, [location.search]);

  const loginMutation = useMutation({
    mutationFn: (values: LoginFormValues) => localDevLogin(client, {
      user_id: values.user_id.trim(),
      tenant_id: values.tenant_id.trim(),
      password: values.password,
    }),
    onSuccess: (resolvedIdentity) => {
      setIdentity(fromResolvedIdentity(resolvedIdentity));
      void message.success('登录成功，正在进入控制台。');
      navigate(nextPath, { replace: true });
    },
  });

  const friendlyError = loginMutation.error ? toFriendlyError(loginMutation.error) : undefined;

  return (
    <div className="cp-login-shell">
      <div className="cp-login-hero">
        <Typography.Text className="cp-login-eyebrow">LOCAL DEV LOGIN</Typography.Text>
        <Typography.Title level={1}>智能体运行平台</Typography.Title>
        <Typography.Paragraph>
          本地控制台现在需要先输入开发身份和密码，登录成功后才会进入对话与运营页面。
        </Typography.Paragraph>
        <Space direction="vertical" size={4}>
          <Typography.Text type="secondary">默认租户：`development`</Typography.Text>
          <Typography.Text type="secondary">推荐账号：`dev_admin`</Typography.Text>
        </Space>
      </div>

      <Card className="cp-login-card" bordered={false}>
        <Space direction="vertical" size={18} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 8 }}>登录控制台</Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              这是仅用于本地开发环境的密码入口，不会替代生产鉴权。
            </Typography.Paragraph>
          </div>

          {friendlyError ? (
            <Alert
              type="error"
              showIcon
              message={friendlyError.title}
              description={friendlyError.description}
            />
          ) : null}

          <Form<LoginFormValues>
            form={form}
            layout="vertical"
            initialValues={initialValues}
            onFinish={(values) => loginMutation.mutate(values)}
          >
            <Form.Item
              label="user_id"
              name="user_id"
              rules={[{ required: true, message: '请输入 user_id' }]}
            >
              <Input autoComplete="username" placeholder="例如 dev_admin" />
            </Form.Item>
            <Form.Item
              label="tenant_id"
              name="tenant_id"
              rules={[{ required: true, message: '请输入 tenant_id' }]}
            >
              <Input autoComplete="organization" placeholder="例如 development" />
            </Form.Item>
            <Form.Item
              label="password"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password autoComplete="current-password" placeholder="输入本地开发密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={loginMutation.isPending}>
              登录
            </Button>
          </Form>
        </Space>
      </Card>
    </div>
  );
}
