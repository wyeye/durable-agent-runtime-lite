import React from 'react';
import { createRoot } from 'react-dom/client';
import { Layout, Menu, Table, Typography } from 'antd';
import 'antd/dist/reset.css';

const { Header, Content, Sider } = Layout;

const flows = [{ key: 'sample-flow', flow_id: 'sample_flow', version: 1, status: 'published' }];
const tools = [
  { key: 'knowledge.search', tool_name: 'knowledge.search', risk_level: 'L1' },
  { key: 'record.write.mock', tool_name: 'record.write.mock', risk_level: 'L3' },
];
const agents = [{ key: 'sample-agent', agent_id: 'sample_agent', model_policy: 'mock' }];
const tasks = [{ key: 'task-demo', task_run_id: 'task_demo', status: 'queued' }];
const audits = [{ key: 'audit-demo', action: 'tool.invoke', result: 'succeeded' }];

function SimpleTable({ title, data }: { title: string; data: Record<string, unknown>[] }) {
  const columns = Object.keys(data[0] ?? { key: 'empty' }).map((key) => ({
    title: key,
    dataIndex: key,
    key,
  }));

  return (
    <section style={{ marginBottom: 24 }}>
      <Typography.Title level={3}>{title}</Typography.Title>
      <Table size="small" dataSource={data} columns={columns} pagination={false} />
    </section>
  );
}

function App() {
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ color: 'white', fontWeight: 600 }}>Durable Agent Runtime Lite</Header>
      <Layout>
        <Sider theme="light">
          <Menu
            mode="inline"
            defaultSelectedKeys={['flows']}
            items={[
              { key: 'flows', label: 'Flow 列表' },
              { key: 'tools', label: 'Tool 列表' },
              { key: 'agents', label: 'Agent 列表' },
              { key: 'tasks', label: 'TaskRun 列表' },
              { key: 'audits', label: 'Audit 列表' },
            ]}
          />
        </Sider>
        <Content style={{ padding: 24 }}>
          <SimpleTable title="Flow 列表" data={flows} />
          <SimpleTable title="Tool 列表" data={tools} />
          <SimpleTable title="Agent 列表" data={agents} />
          <SimpleTable title="TaskRun 列表" data={tasks} />
          <SimpleTable title="Audit 列表" data={audits} />
        </Content>
      </Layout>
    </Layout>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
