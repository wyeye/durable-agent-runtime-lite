import { describe, expect, it } from 'vitest';
import { smokeCatalog, smokeSuites } from '../src/smoke/catalog.js';
import { validateSmokeCatalog } from '../src/commands/check.js';

describe('repo-cli smoke catalog', () => {
  it('keeps scenario ids unique and suites populated', () => {
    expect(() => validateSmokeCatalog()).not.toThrow();
    const ids = new Set(smokeCatalog.map((scenario) => scenario.id));
    expect(ids.size).toBe(smokeCatalog.length);
    for (const suite of smokeSuites) {
      expect(smokeCatalog.some((scenario) => scenario.suite === suite)).toBe(true);
    }
  });

  it('keeps hosted suites free of real-only scenarios', () => {
    const hostedSuites = ['core', 'agent', 'governance', 'ui'];
    expect(
      smokeCatalog.filter((scenario) => hostedSuites.includes(scenario.suite) && scenario.mode === 'real'),
    ).toEqual([]);
  });

  it('maps known legacy coverage into the catalog', () => {
    const ids = new Set(smokeCatalog.map((scenario) => scenario.id));
    for (const id of [
      'temporal-db',
      'control-plane-api',
      'semantic-router',
      'http-readonly-tool',
      'pi-readonly',
      'pi-l3',
      'pi-user-input',
      'pi-handoff',
      'worker-crash-resume',
      'chat-mvp',
      'tenant-policy',
      'tenant-snapshot',
      'tenant-concurrency',
      'evaluation-framework',
      'evaluation-regression',
      'evaluation-publish-gate',
      'control-plane-ui',
      'evaluation-ui',
      'ollama-runtime',
      'live-model-provider',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });
});
