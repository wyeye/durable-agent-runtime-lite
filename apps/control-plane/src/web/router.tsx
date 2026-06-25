import { createBrowserRouter, Navigate } from 'react-router';
import { AppLayout } from './layout/AppLayout.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { FlowsPage } from './pages/flows/FlowsPage.js';
import { RoutesPage } from './pages/routes/RoutesPage.js';
import { ToolsPage } from './pages/tools/ToolsPage.js';
import { AgentsPage } from './pages/agents/AgentsPage.js';
import { ModelPoliciesPage } from './pages/model-policies/ModelPoliciesPage.js';
import { ModelGatewaysPage } from './pages/model-gateways/ModelGatewaysPage.js';
import { ModelsPage } from './pages/models/ModelsPage.js';
import { PromptsPage } from './pages/prompts/PromptsPage.js';
import { ReleasesPage } from './pages/releases/ReleasesPage.js';
import { HumanTasksPage } from './pages/human-tasks/HumanTasksPage.js';
import { TaskRunsPage } from './pages/task-runs/TaskRunsPage.js';
import { AgentRunsPage } from './pages/agent-runs/AgentRunsPage.js';
import { AuditEventsPage } from './pages/audit/AuditEventsPage.js';
import { ToolCallsPage } from './pages/tool-calls/ToolCallsPage.js';
import { PolicySnapshotsPage } from './pages/policy-snapshots/PolicySnapshotsPage.js';
import { TenantAdmissionsPage } from './pages/tenant-admissions/TenantAdmissionsPage.js';
import { EvaluationDatasetDetailPage } from './pages/evaluation/EvaluationDatasetDetailPage.js';
import { EvaluationDatasetsPage } from './pages/evaluation/EvaluationDatasetsPage.js';
import { EvaluationDecisionDetailPage } from './pages/evaluation/EvaluationDecisionDetailPage.js';
import { EvaluationGateDetailPage } from './pages/evaluation/EvaluationGateDetailPage.js';
import { EvaluationGatesPage } from './pages/evaluation/EvaluationGatesPage.js';
import { EvaluationRunDetailPage } from './pages/evaluation/EvaluationRunDetailPage.js';
import { EvaluationRunsPage } from './pages/evaluation/EvaluationRunsPage.js';
import { TenantsPage } from './pages/iam/TenantsPage.js';
import { UsersPage } from './pages/iam/UsersPage.js';
import { RolesPage } from './pages/iam/RolesPage.js';

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
      { path: 'registry/model-policies', element: <ModelPoliciesPage /> },
      { path: 'model-policies', element: <ModelPoliciesPage /> },
      { path: 'model-gateways', element: <ModelGatewaysPage /> },
      { path: 'models', element: <ModelsPage /> },
      { path: 'registry/prompts', element: <PromptsPage /> },
      { path: 'releases', element: <ReleasesPage /> },
      { path: 'human-tasks', element: <HumanTasksPage /> },
      { path: 'task-runs', element: <TaskRunsPage /> },
      { path: 'agent-runs', element: <AgentRunsPage /> },
      { path: 'audit-events', element: <AuditEventsPage /> },
      { path: 'tool-calls', element: <ToolCallsPage /> },
      { path: 'policy-snapshots', element: <PolicySnapshotsPage /> },
      { path: 'tenant-admissions', element: <TenantAdmissionsPage /> },
      { path: 'evaluation/datasets', element: <EvaluationDatasetsPage /> },
      { path: 'evaluation/datasets/:datasetId/versions/:version', element: <EvaluationDatasetDetailPage /> },
      { path: 'evaluation/runs', element: <EvaluationRunsPage /> },
      { path: 'evaluation/runs/:runId', element: <EvaluationRunDetailPage /> },
      { path: 'evaluation/gates', element: <EvaluationGatesPage /> },
      { path: 'evaluation/gates/:gatePolicyId/versions/:version', element: <EvaluationGateDetailPage /> },
      { path: 'evaluation/gate-decisions/:decisionId', element: <EvaluationDecisionDetailPage /> },
      { path: 'iam/tenants', element: <TenantsPage /> },
      { path: 'iam/users', element: <UsersPage /> },
      { path: 'iam/roles', element: <RolesPage /> },
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
]);
