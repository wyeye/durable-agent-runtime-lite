import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  agentSpecSchema,
  flowSpecSchema,
  promptDefinitionSchema,
  routeSpecSchema,
  toolManifestSchema,
} from '@dar/contracts';
import {
  closeDb,
  createDb,
  FlowDefinitionRepository,
  RouteConfigRepository,
  ToolManifestRepository,
  upsertAgentSpec,
  upsertPromptDefinition,
} from '@dar/db';

const repoRootUrl = new URL('..', import.meta.url);
const tenantId = process.env.SEED_TENANT_ID ?? 'default';
const defaultDatabaseUrl = 'postgres://dar:dar_local_password@localhost:15432/durable_agent_runtime';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(path, repoRootUrl), 'utf8'));
}

export async function seedExamples(databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl): Promise<void> {
  const db = createDb({ databaseUrl });
  try {
    const flow = flowSpecSchema.parse(await readJson('examples/flows/sample-flow.json'));
    const route = routeSpecSchema.parse(await readJson('examples/routes/sample-route.json'));
    const knowledgeSearchTool = toolManifestSchema.parse(
      await readJson('examples/tools/knowledge-search-tool.json'),
    );
    const recordWriteTool = toolManifestSchema.parse(
      await readJson('examples/tools/record-write-mock-tool.json'),
    );
    const agent = agentSpecSchema.parse(await readJson('examples/agents/sample-agent.json'));
    const promptContent = await readFile(new URL('examples/prompts/sample-prompt.md', repoRootUrl), 'utf8');
    const prompt = promptDefinitionSchema.parse({
      prompt_id: 'sample_prompt',
      version: 1,
      name: 'Sample controlled agent prompt',
      content: promptContent,
      variables: [],
      status: 'published',
    });

    await new FlowDefinitionRepository(db).upsert(flow, { tenantId, status: 'published', createdBy: 'seed-examples' });
    await new RouteConfigRepository(db).upsert(route, { tenantId, status: 'published', createdBy: 'seed-examples' });
    await new ToolManifestRepository(db).upsert(knowledgeSearchTool, {
      tenantId,
      status: 'published',
      createdBy: 'seed-examples',
    });
    await new ToolManifestRepository(db).upsert(recordWriteTool, {
      tenantId,
      status: 'published',
      createdBy: 'seed-examples',
    });
    await upsertAgentSpec(db, agent, { tenantId, status: 'published', createdBy: 'seed-examples' });
    await upsertPromptDefinition(db, prompt, { tenantId, status: 'published', createdBy: 'seed-examples' });
  } finally {
    await closeDb(db);
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  seedExamples()
    .then(() => {
      console.log(`seeded examples for tenant ${tenantId}`);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
