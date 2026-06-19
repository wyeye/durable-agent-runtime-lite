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

    expect(target?.model_id).toBe(agent.model_policy);
    expect(agent.model_policy_ref).toEqual({
      model_policy_id: policy.model_policy_id,
      model_policy_version: policy.version,
      model_policy_hash: hashModelPolicy(policy),
    });
  });
});
