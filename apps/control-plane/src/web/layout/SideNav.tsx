import { Menu } from 'antd';
import { Link, useLocation } from 'react-router';

const items = [
  { key: '/dashboard', label: <Link to="/dashboard">Dashboard</Link> },
  { key: '/registry/flows', label: <Link to="/registry/flows">Flows</Link> },
  { key: '/registry/routes', label: <Link to="/registry/routes">Routes</Link> },
  { key: '/registry/tools', label: <Link to="/registry/tools">Tools</Link> },
  { key: '/registry/agents', label: <Link to="/registry/agents">Agents</Link> },
  { key: '/registry/prompts', label: <Link to="/registry/prompts">Prompts</Link> },
  { key: '/releases', label: <Link to="/releases">Release Center</Link> },
  { key: '/human-tasks', label: <Link to="/human-tasks">Human Tasks</Link> },
  { key: '/task-runs', label: <Link to="/task-runs">TaskRuns</Link> },
  { key: '/audit-events', label: <Link to="/audit-events">Audit</Link> },
  { key: '/tool-calls', label: <Link to="/tool-calls">ToolCalls</Link> },
];

export function SideNav() {
  const location = useLocation();
  const selected = items.find((item) => location.pathname.startsWith(item.key))?.key ?? '/dashboard';
  return <Menu mode="inline" selectedKeys={[selected]} items={items} />;
}
