import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('../../../..', import.meta.url).pathname;
const webRoot = join(root, 'apps/control-plane/src/web');
const writablePages = [
  'pages/registry/RegistryResourcePage.tsx',
  'pages/evaluation/EvaluationDatasetsPage.tsx',
  'pages/evaluation/EvaluationDatasetDetailPage.tsx',
  'pages/evaluation/EvaluationGatesPage.tsx',
  'pages/evaluation/EvaluationGateDetailPage.tsx',
];
const smokeScripts = [
  'devtools/repo-cli/src/scripts/smoke-control-plane-ui-e2e.ts',
  'devtools/repo-cli/src/scripts/smoke-evaluation-ui-e2e.ts',
];

async function main(): Promise<void> {
  const failures: string[] = [];

  for (const page of writablePages) {
    const source = await readFile(join(webRoot, page), 'utf8');
    if (source.includes('JsonEditor')) {
      failures.push(`${page} must not import or render editable JsonEditor`);
    }
    if (source.includes('parseJson(')) {
      failures.push(`${page} must not parse user config JSON`);
    }
    if (/json-editor-textarea/u.test(source)) {
      failures.push(`${page} must not use editable JSON textarea selectors`);
    }
  }

  for (const script of smokeScripts) {
    const source = await readFile(join(root, script), 'utf8');
    if (/json-editor-textarea/u.test(source)) {
      failures.push(`${script} must not drive writable JSON textarea flows`);
    }
  }

  const visualFiles = await listFiles(join(webRoot, 'visual-config'));
  const previewSource = await readFile(join(webRoot, 'visual-config/components/ReadonlyJsonPreview.tsx'), 'utf8');
  if (/onChange\s*[:=]/u.test(previewSource) || /TextArea/u.test(previewSource)) {
    failures.push('ReadonlyJsonPreview must not expose onChange or editable text areas');
  }
  const jsonEditorSource = await readFile(join(webRoot, 'components/JsonEditor.tsx'), 'utf8');
  if (/TextArea/u.test(jsonEditorSource) || /onChange\s*\(/u.test(jsonEditorSource)) {
    failures.push('JsonEditor is retained only as a read-only wrapper and must not edit text');
  }

  const requiredEditors = [
    'PromptVisualEditor',
    'RouteVisualEditor',
    'AgentVisualEditor',
    'ModelPolicyVisualEditor',
    'ToolVisualEditor',
    'TenantRuntimePolicyVisualEditor',
    'FlowVisualEditor',
    'EvaluationDatasetVisualEditor',
    'EvaluationCaseVisualEditor',
    'EvaluationGatePolicyVisualEditor',
  ];
  const allVisualSource = (await Promise.all(visualFiles.map((file) => readFile(file, 'utf8')))).join('\n');
  for (const editor of requiredEditors) {
    if (!allVisualSource.includes(`function ${editor}`)) {
      failures.push(`missing visual editor: ${editor}`);
    }
  }

  const roundTripTest = join(webRoot, 'visual-config/visual-config-roundtrip.test.ts');
  const roundTripSource = await readFile(roundTripTest, 'utf8').catch(() => '');
  for (const fixture of [
    'flow',
    'route',
    'tool',
    'agent',
    'model_policy',
    'prompt',
    'tenant_runtime_policy',
    'evaluationDataset',
    'evaluationCase',
    'evaluationGatePolicy',
  ]) {
    if (!roundTripSource.includes(fixture)) {
      failures.push(`round-trip test missing fixture marker: ${fixture}`);
    }
  }

  const i18n = await readFile(join(root, 'packages/i18n/src/locales/zh-CN/visual-config.ts'), 'utf8').catch(() => '');
  if (!i18n.includes('visualConfig')) {
    failures.push('visualConfig i18n resource is missing');
  }

  if (failures.length) {
    console.error(failures.map((failure) => `- ${failure}`).join('\n'));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    checked_pages: writablePages.length,
    visual_files: visualFiles.map((file) => relative(root, file)).length,
  }, null, 2));
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat().filter((file) => /\.(tsx?|jsx?)$/u.test(file));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
