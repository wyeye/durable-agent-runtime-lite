import type {
  Conversation,
  ConversationMessage,
} from '@dar/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorAlert } from '../../components/ErrorAlert.js';
import { useApiClient } from '../../api/use-api-client.js';
import {
  archiveConversation,
  createConversation,
  getConversation,
  hasPendingMessage,
  listConversationMessages,
  listConversations,
  renameConversation,
  sendConversationMessage,
  unarchiveConversation,
} from '../../api/conversations-api.js';
import { formatDateTime } from '../../utils/format.js';
import { displayStatus } from '../../utils/i18n-labels.js';

const conversationPageSize = 50;
const messagePageSize = 100;

export function ChatPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams<{ conversationId?: string }>();
  const { message } = App.useApp();
  const [statusFilter, setStatusFilter] = useState<'active' | 'archived'>('active');
  const [draft, setDraft] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  const conversationsQuery = useQuery({
    queryKey: ['conversations', statusFilter],
    queryFn: () => listConversations(client, { status: statusFilter, page_size: conversationPageSize }),
  });

  const selectedConversationId = params.conversationId ?? conversationsQuery.data?.items[0]?.conversation_id;

  useEffect(() => {
    if (!params.conversationId && conversationsQuery.data?.items[0]?.conversation_id) {
      navigate(`/chat/${conversationsQuery.data.items[0].conversation_id}`, { replace: true });
    }
  }, [conversationsQuery.data?.items, navigate, params.conversationId]);

  const conversationQuery = useQuery({
    queryKey: ['conversation', selectedConversationId],
    enabled: Boolean(selectedConversationId),
    queryFn: () => getConversation(client, selectedConversationId!),
  });

  const messagesQuery = useQuery({
    queryKey: ['conversation-messages', selectedConversationId],
    enabled: Boolean(selectedConversationId),
    queryFn: () => listConversationMessages(client, selectedConversationId!, { order: 'oldest', page_size: messagePageSize }),
    refetchInterval: (query) => {
      const messages = query.state.data?.items ?? [];
      return hasPendingMessage(messages) ? 2000 : false;
    },
  });

  const createMutation = useMutation({
    mutationFn: () => createConversation(client, {}),
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      navigate(`/chat/${conversation.conversation_id}`);
    },
  });

  const renameMutation = useMutation({
    mutationFn: (input: { conversationId: string; title: string; expectedRevision?: number }) =>
      renameConversation(client, input.conversationId, {
        title: input.title,
        ...(input.expectedRevision ? { expected_revision: input.expectedRevision } : {}),
      }),
    onSuccess: async (conversation) => {
      setRenameOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversation.conversation_id] }),
      ]);
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (input: { conversationId: string; archived: boolean }) => (
      input.archived
        ? unarchiveConversation(client, input.conversationId)
        : archiveConversation(client, input.conversationId)
    ),
    onSuccess: async (conversation) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', conversation.conversation_id] }),
      ]);
      if (conversation.status === 'archived' && params.conversationId === conversation.conversation_id) {
        setStatusFilter('active');
      }
    },
  });

  const sendMutation = useMutation({
    mutationFn: (input: { conversationId: string; content: string }) =>
      sendConversationMessage(client, input.conversationId, {
        content: input.content,
        client_message_id: crypto.randomUUID(),
      }),
    onSuccess: async (response) => {
      setDraft('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['conversations'] }),
        queryClient.invalidateQueries({ queryKey: ['conversation', response.conversation.conversation_id] }),
        queryClient.invalidateQueries({ queryKey: ['conversation-messages', response.conversation.conversation_id] }),
      ]);
    },
  });

  const selectedConversation = conversationQuery.data;
  const messages = messagesQuery.data?.items ?? [];
  const selectedHasPending = hasPendingMessage(messages);
  const sendDisabled = !selectedConversation || selectedConversation.status !== 'active' || selectedHasPending || sendMutation.isPending;

  useEffect(() => {
    if (selectedConversation) {
      setRenameValue(selectedConversation.title);
    }
  }, [selectedConversation?.conversation_id, selectedConversation?.title]);

  const statusOptions = useMemo(() => [
    { label: '进行中', value: 'active' },
    { label: '已归档', value: 'archived' },
  ], []);

  return (
    <div className="cp-page">
      <div className="cp-page-header">
        <div>
          <h1>对话</h1>
          <p>每条消息通过现有任务链路进入 Router、Temporal 和 Pi，历史回答会持久化到当前会话。</p>
        </div>
        <Space wrap>
          <Segmented options={statusOptions} value={statusFilter} onChange={(value) => setStatusFilter(value as 'active' | 'archived')} />
          <Button onClick={() => createMutation.mutate()} loading={createMutation.isPending} type="primary">
            新建对话
          </Button>
          <Button
            onClick={() => {
              void conversationsQuery.refetch();
              void conversationQuery.refetch();
              void messagesQuery.refetch();
            }}
            loading={conversationsQuery.isFetching || conversationQuery.isFetching || messagesQuery.isFetching}
          >
            刷新
          </Button>
        </Space>
      </div>

      {(conversationsQuery.error || conversationQuery.error || messagesQuery.error || createMutation.error || renameMutation.error || archiveMutation.error || sendMutation.error) ? (
        <ErrorAlert error={conversationsQuery.error ?? conversationQuery.error ?? messagesQuery.error ?? createMutation.error ?? renameMutation.error ?? archiveMutation.error ?? sendMutation.error} />
      ) : null}

      <div className="cp-chat-layout">
        <Card
          title="会话列表"
          className="cp-chat-sidebar"
          extra={<span>{conversationsQuery.data?.total ?? 0} 个</span>}
        >
          {conversationsQuery.isLoading ? (
            <div className="cp-chat-loading"><Spin /></div>
          ) : (
            <List
              dataSource={conversationsQuery.data?.items ?? []}
              locale={{ emptyText: <EmptyState description={statusFilter === 'active' ? '暂无进行中的对话' : '暂无归档对话'} /> }}
              renderItem={(conversation) => (
                <List.Item
                  className={conversation.conversation_id === selectedConversationId ? 'cp-chat-conversation cp-chat-conversation-active' : 'cp-chat-conversation'}
                  onClick={() => navigate(`/chat/${conversation.conversation_id}`)}
                  actions={[
                    <Tag key="status">{conversation.status === 'active' ? '进行中' : '已归档'}</Tag>,
                  ]}
                >
                  <List.Item.Meta
                    title={<span>{conversation.title}</span>}
                    description={`最近更新：${formatDateTime(conversation.updated_at)}`}
                  />
                </List.Item>
              )}
            />
          )}
        </Card>

        <Card
          title={selectedConversation?.title ?? '请选择会话'}
          className="cp-chat-main"
          extra={selectedConversation ? (
            <Space>
              <Button
                size="small"
                onClick={() => setRenameOpen(true)}
              >
                重命名
              </Button>
              <Button
                size="small"
                onClick={() => archiveMutation.mutate({
                  conversationId: selectedConversation.conversation_id,
                  archived: selectedConversation.status === 'archived',
                })}
                loading={archiveMutation.isPending}
              >
                {selectedConversation.status === 'archived' ? '恢复' : '归档'}
              </Button>
            </Space>
          ) : null}
        >
          {!selectedConversationId ? (
            <Empty description="先创建一个会话开始聊天" />
          ) : conversationQuery.isLoading ? (
            <div className="cp-chat-loading"><Spin /></div>
          ) : (
            <div className="cp-chat-panel">
              <div className="cp-chat-meta">
                <Tag>{selectedConversation?.status === 'archived' ? '已归档' : '进行中'}</Tag>
                <Typography.Text type="secondary">会话 ID：{selectedConversation?.conversation_id}</Typography.Text>
                <Typography.Text type="secondary">修订：{selectedConversation?.revision}</Typography.Text>
              </div>

              <div className="cp-chat-messages">
                {messagesQuery.isLoading ? (
                  <div className="cp-chat-loading"><Spin /></div>
                ) : messages.length === 0 ? (
                  <EmptyState description="还没有消息，发一条开始吧" />
                ) : (
                  messages.map((messageItem) => (
                    <MessageBubble key={messageItem.message_id} message={messageItem} />
                  ))
                )}
              </div>

              <Form
                layout="vertical"
                onFinish={() => {
                  if (!selectedConversationId || !draft.trim()) {
                    return;
                  }
                  sendMutation.mutate({
                    conversationId: selectedConversationId,
                    content: draft.trim(),
                  }, {
                    onError: () => {
                      message.error('发送失败，请检查错误信息后重试。');
                    },
                  });
                }}
              >
                <Form.Item label="发送消息" style={{ marginBottom: 8 }}>
                  <Input.TextArea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={5}
                    maxLength={8000}
                    placeholder={selectedConversation?.status === 'archived' ? '归档会话不可发送新消息' : '输入你要发给智能体的消息'}
                    disabled={!selectedConversation || selectedConversation.status !== 'active' || sendMutation.isPending}
                  />
                </Form.Item>
                <div className="cp-chat-compose-footer">
                  <Typography.Text type="secondary">
                    {selectedHasPending ? '上一轮仍在处理中，请等待当前 assistant 消息结束。' : `当前长度 ${draft.length}/8000`}
                  </Typography.Text>
                  <Button type="primary" htmlType="submit" loading={sendMutation.isPending} disabled={sendDisabled}>
                    发送
                  </Button>
                </div>
              </Form>
            </div>
          )}
        </Card>
      </div>

      <Modal
        title="重命名会话"
        open={renameOpen}
        onCancel={() => setRenameOpen(false)}
        onOk={() => {
          if (!selectedConversation) {
            return;
          }
          renameMutation.mutate({
            conversationId: selectedConversation.conversation_id,
            title: renameValue.trim(),
            expectedRevision: selectedConversation.revision,
          });
        }}
        confirmLoading={renameMutation.isPending}
        okButtonProps={{ disabled: !renameValue.trim() }}
      >
        <Input
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          maxLength={100}
          placeholder="输入新的会话标题"
        />
      </Modal>
    </div>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  const effectiveStatus = message.effective_status ?? message.status;
  const isAssistant = message.role === 'assistant';
  return (
    <div className={isAssistant ? 'cp-chat-message cp-chat-message-assistant' : 'cp-chat-message cp-chat-message-user'}>
      <div className="cp-chat-message-header">
        <Space wrap size={8}>
          <strong>{isAssistant ? 'Assistant' : 'User'}</strong>
          <Tag>{displayStatus(effectiveStatus)}</Tag>
          <Typography.Text type="secondary">{formatDateTime(message.created_at)}</Typography.Text>
        </Space>
      </div>
      <div className="cp-chat-message-body">
        {message.content_text?.trim() ? (
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
            {message.content_text}
          </Typography.Paragraph>
        ) : (
          <Typography.Text type="secondary">
            {effectiveStatus === 'failed'
              ? `消息处理失败${message.error_code ? `：${message.error_code}` : ''}`
              : '等待回答中...'}
          </Typography.Text>
        )}
      </div>
    </div>
  );
}
