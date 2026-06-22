import { readFile } from 'node:fs/promises';
import { agentSpecSchema, modelPolicySchema } from '@dar/contracts';
import { hashModelPolicy } from '@dar/db';
import { describe, expect, it } from 'vitest';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
}

describe('example ModelPolicy references', () => {
  it('locks the sample AgentSpec to the seeded sample ModelPolicy', async () => {
    const policy = modelPolicySchema.parse(await readJson('examples/model-policies/sample-model-policy.json'));
    const agent = agentSpecSchema.parse(await readJson('examples/agents/sample-agent.json'));
    const target = policy.targets[0];

    expect(target?.model_ref.model_id).toBe('deterministic-final-only');
    expect(target?.model_ref.version).toBe(1);
    expect(target?.model_ref.model_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(agent.model_policy_ref).toEqual({
      model_policy_id: policy.model_policy_id,
      model_policy_version: policy.version,
      model_policy_hash: hashModelPolicy(policy),
    });
  });

  it('defines the opt-in local Ollama seed policy with the exact release-gate model', async () => {
    const seedScript = await readFile(new URL('../scripts/seed-examples.ts', import.meta.url), 'utf8');

    expect(seedScript).toContain('SEED_LOCAL_OLLAMA_MODEL_POLICY');
    expect(seedScript).toContain('local-ollama');
    expect(seedScript).toContain('qwen2.5:7b-instruct-q4_K_M');
  });
});
