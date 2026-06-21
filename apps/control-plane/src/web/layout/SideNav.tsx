import { Menu } from 'antd';
import { Link, useLocation } from 'react-router';

const items = [
  { key: '/dashboard', label: <Link to="/dashboard">Dashboard</Link> },
  {
    key: 'registry',
    label: 'Registry',
    children: [
      { key: '/registry/flows', label: <Link to="/registry/flows">Flows</Link> },
      { key: '/registry/routes', label: <Link to="/registry/routes">Routes</Link> },
      { key: '/registry/tools', label: <Link to="/registry/tools">Tools</Link> },
      { key: '/registry/agents', label: <Link to="/registry/agents">Agents</Link> },
      { key: '/registry/model-policies', label: <Link to="/registry/model-policies">Model Policies</Link> },
      { key: '/registry/prompts', label: <Link to="/registry/prompts">Prompts</Link> },
    ],
  },
  {
    key: 'evaluation',
    label: 'Evaluation',
    children: [
      { key: '/evaluation/datasets', label: <Link to="/evaluation/datasets">Datasets</Link> },
      { key: '/evaluation/runs', label: <Link to="/evaluation/runs">Runs</Link> },
      { key: '/evaluation/gates', label: <Link to="/evaluation/gates">Gates</Link> },
    ],
  },
  { key: '/releases', label: <Link to="/releases">Release Center</Link> },
  { key: '/human-tasks', label: <Link to="/human-tasks">Human Tasks</Link> },
  { key: '/task-runs', label: <Link to="/task-runs">TaskRuns</Link> },
  { key: '/agent-runs', label: <Link to="/agent-runs">AgentRuns</Link> },
  { key: '/audit-events', label: <Link to="/audit-events">Audit</Link> },
  { key: '/tool-calls', label: <Link to="/tool-calls">ToolCalls</Link> },
  { key: '/policy-snapshots', label: <Link to="/policy-snapshots">Policy Snapshots</Link> },
  { key: '/tenant-admissions', label: <Link to="/tenant-admissions">Tenant Admissions</Link> },
];

export function SideNav() {
  const location = useLocation();
  const selected = leafKeys.find((key) => location.pathname.startsWith(key)) ?? '/dashboard';
  const openKeys = selected.startsWith('/registry') ? ['registry']
    : selected.startsWith('/evaluation') ? ['evaluation']
      : [];
  return <Menu mode="inline" selectedKeys={[selected]} defaultOpenKeys={openKeys} items={items} />;
}

const leafKeys = [
  '/dashboard',
  '/registry/flows',
  '/registry/routes',
  '/registry/tools',
  '/registry/agents',
  '/registry/model-policies',
  '/registry/prompts',
  '/evaluation/datasets',
  '/evaluation/runs',
  '/evaluation/gates',
  '/releases',
  '/human-tasks',
  '/task-runs',
  '/agent-runs',
  '/audit-events',
  '/tool-calls',
  '/policy-snapshots',
  '/tenant-admissions',
];
