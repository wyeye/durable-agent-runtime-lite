import { Button, Form, Input, Modal, Select } from 'antd';
import { useEffect } from 'react';

export interface ConfirmActionValues {
  release_note: string;
  tenant_allowlist?: string;
  user_allowlist?: string;
  target_version?: number;
}

export function ConfirmActionModal({
  title,
  open,
  loading,
  requireGrayPolicy = false,
  versionOptions = [],
  noteLabel = '发布说明',
  onCancel,
  onConfirm,
}: {
  title: string;
  open: boolean;
  loading?: boolean;
  requireGrayPolicy?: boolean;
  versionOptions?: number[];
  noteLabel?: string;
  onCancel(): void;
  onConfirm(values: ConfirmActionValues): void;
}) {
  const [form] = Form.useForm<ConfirmActionValues>();
  useEffect(() => {
    if (open) {
      form.resetFields();
    }
  }, [form, open]);

  return (
    <Modal
      title={title}
      open={open}
      onCancel={onCancel}
      footer={null}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={onConfirm}
      >
        {versionOptions.length > 0 ? (
          <Form.Item
            label="目标版本"
            name="target_version"
            rules={[{ required: true, message: '请选择目标版本' }]}
          >
            <Select options={versionOptions.map((version) => ({ value: version, label: `v${version}` }))} />
          </Form.Item>
        ) : null}
        {requireGrayPolicy ? (
          <>
            <Form.Item label="租户白名单" name="tenant_allowlist">
              <Input placeholder="tenant-a, tenant-b" />
            </Form.Item>
            <Form.Item label="用户白名单" name="user_allowlist">
              <Input placeholder="user-a, user-b" />
            </Form.Item>
          </>
        ) : null}
        <Form.Item
          label={noteLabel}
          name="release_note"
          rules={[{ required: true, message: '请输入发布说明' }]}
        >
          <Input.TextArea data-testid="release-note" autoSize={{ minRows: 3, maxRows: 6 }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={Boolean(loading)} data-testid="confirm-primary">
          确认执行
        </Button>
      </Form>
    </Modal>
  );
}
