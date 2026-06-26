import { Menu } from 'antd';
import { Link, useLocation } from 'react-router';
import { navLabel } from '../utils/i18n-labels.js';
import { useIdentity } from '../auth/identity-context.js';

const baseItems = [
  { key: '/chat', label: <Link to="/chat">{navLabel('chat')}</Link> },
  { key: '/dashboard', label: <Link to="/dashboard">{navLabel('dashboard')}</Link> },
  {
    key: 'ability',
    label: '能力管理',
    children: [
      { key: '/model-gateways', label: <Link to="/model-gateways">模型网关</Link> },
      { key: '/models', label: <Link to="/models">模型</Link> },
      { key: '/model-policies', label: <Link to="/model-policies">{navLabel('modelPolicies')}</Link> },
    ],
  },
  {
    key: 'registry',
    label: navLabel('registry'),
    children: [
      { key: '/registry/flows', label: <Link to="/registry/flows">{navLabel('flows')}</Link> },
      { key: '/registry/routes', label: <Link to="/registry/routes">{navLabel('routes')}</Link> },
      { key: '/registry/tools', label: <Link to="/registry/tools">{navLabel('tools')}</Link> },
      { key: '/registry/agents', label: <Link to="/registry/agents">{navLabel('agents')}</Link> },
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

const iamItems = [
  {
    key: 'iam',
    label: navLabel('iam'),
    children: [
      { key: '/iam/tenants', label: <Link to="/iam/tenants">{navLabel('tenants')}</Link> },
      { key: '/iam/users', label: <Link to="/iam/users">{navLabel('users')}</Link> },
      { key: '/iam/roles', label: <Link to="/iam/roles">{navLabel('roles')}</Link> },
    ],
  },
];

export function SideNav() {
  const location = useLocation();
  const { hasPermission, canUseRuntime } = useIdentity();
  const showIam = hasPermission('iam:read');
  const showOperations = hasPermission('operations:read');
  const showRegistry = hasPermission('registry:read');
  const showAbility = hasPermission('registry:write') || hasPermission('registry:read');
  const showReleases = hasPermission('release:read');
  const showChatOnly = canUseRuntime && !showOperations && !showRegistry && !showAbility && !showReleases && !showIam;
  const items = showChatOnly
    ? baseItems.filter((item) => item.key === '/chat')
    : [
        ...baseItems.filter((item) => {
          if (item.key === '/chat') {
            return canUseRuntime;
          }
          if (item.key === '/dashboard') {
            return showOperations;
          }
          if (item.key === 'ability') {
            return showAbility;
          }
          if (item.key === 'registry') {
            return showRegistry;
          }
          if (item.key === 'evaluation') {
            return showOperations || showRegistry;
          }
          if (item.key === '/releases') {
            return showReleases;
          }
          if (item.key === '/human-tasks') {
            return hasPermission('human_task:decide') || showOperations;
          }
          return showOperations;
        }),
        ...(showIam ? iamItems : []),
      ];

  const selected = leafKeys.find((key) => location.pathname.startsWith(key)) ?? '/chat';
  const openKeys = selected === '/model-gateways' || selected === '/models' || selected === '/model-policies' ? ['ability']
    : selected.startsWith('/registry') ? ['registry']
    : selected.startsWith('/evaluation') ? ['evaluation']
    : selected.startsWith('/iam') ? ['iam']
      : [];
  return <Menu mode="inline" selectedKeys={[selected]} defaultOpenKeys={openKeys} items={items} />;
}

const leafKeys = [
  '/chat',
  '/dashboard',
  '/registry/flows',
  '/registry/routes',
  '/registry/tools',
  '/registry/agents',
  '/registry/model-policies',
  '/model-policies',
  '/model-gateways',
  '/models',
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
  '/iam/tenants',
  '/iam/users',
  '/iam/roles',
];
