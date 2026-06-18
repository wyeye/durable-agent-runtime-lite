import { createBrowserRouter, Navigate } from 'react-router';
import { AppLayout } from './layout/AppLayout.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { FlowsPage } from './pages/flows/FlowsPage.js';
import { RoutesPage } from './pages/routes/RoutesPage.js';
import { ToolsPage } from './pages/tools/ToolsPage.js';
import { AgentsPage } from './pages/agents/AgentsPage.js';
import { PromptsPage } from './pages/prompts/PromptsPage.js';
import { ReleasesPage } from './pages/releases/ReleasesPage.js';
import { HumanTasksPage } from './pages/human-tasks/HumanTasksPage.js';
import { TaskRunsPage } from './pages/task-runs/TaskRunsPage.js';
import { AgentRunsPage } from './pages/agent-runs/AgentRunsPage.js';
import { AuditEventsPage } from './pages/audit/AuditEventsPage.js';
import { ToolCallsPage } from './pages/tool-calls/ToolCallsPage.js';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'registry/flows', element: <FlowsPage /> },
      { path: 'registry/routes', element: <RoutesPage /> },
      { path: 'registry/tools', element: <ToolsPage /> },
      { path: 'registry/agents', element: <AgentsPage /> },
      { path: 'registry/prompts', element: <PromptsPage /> },
      { path: 'releases', element: <ReleasesPage /> },
      { path: 'human-tasks', element: <HumanTasksPage /> },
      { path: 'task-runs', element: <TaskRunsPage /> },
      { path: 'agent-runs', element: <AgentRunsPage /> },
      { path: 'audit-events', element: <AuditEventsPage /> },
      { path: 'tool-calls', element: <ToolCallsPage /> },
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
]);
