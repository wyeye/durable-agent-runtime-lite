import { Menu } from 'antd';
import { Link, useLocation } from 'react-router';
import { navLabel } from '../utils/i18n-labels.js';

const items = [
  { key: '/dashboard', label: <Link to="/dashboard">{navLabel('dashboard')}</Link> },
  {
    key: 'registry',
    label: navLabel('registry'),
    children: [
      { key: '/registry/flows', label: <Link to="/registry/flows">{navLabel('flows')}</Link> },
      { key: '/registry/routes', label: <Link to="/registry/routes">{navLabel('routes')}</Link> },
      { key: '/registry/tools', label: <Link to="/registry/tools">{navLabel('tools')}</Link> },
      { key: '/registry/agents', label: <Link to="/registry/agents">{navLabel('agents')}</Link> },
      { key: '/registry/model-policies', label: <Link to="/registry/model-policies">{navLabel('modelPolicies')}</Link> },
      { key: '/registry/prompts', label: <Link to="/registry/prompts">{navLabel('prompts')}</Link> },
    ],
  },
  {
    key: 'evaluation',
    label: navLabel('evaluation'),
    children: [
      { key: '/evaluation/datasets', label: <Link to="/evaluation/datasets">{navLabel('datasets')}</Link> },
      { key: '/evaluation/runs', label: <Link to="/evaluation/runs">{navLabel('runs')}</Link> },
      { key: '/evaluation/gates', label: <Link to="/evaluation/gates">{navLabel('gates')}</Link> },
    ],
  },
  { key: '/releases', label: <Link to="/releases">{navLabel('releaseCenter')}</Link> },
  { key: '/human-tasks', label: <Link to="/human-tasks">{navLabel('humanTasks')}</Link> },
  { key: '/task-runs', label: <Link to="/task-runs">{navLabel('taskRuns')}</Link> },
  { key: '/agent-runs', label: <Link to="/agent-runs">{navLabel('agentRuns')}</Link> },
  { key: '/audit-events', label: <Link to="/audit-events">{navLabel('audit')}</Link> },
  { key: '/tool-calls', label: <Link to="/tool-calls">{navLabel('toolCalls')}</Link> },
  { key: '/policy-snapshots', label: <Link to="/policy-snapshots">{navLabel('policySnapshots')}</Link> },
  { key: '/tenant-admissions', label: <Link to="/tenant-admissions">{navLabel('tenantAdmissions')}</Link> },
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
