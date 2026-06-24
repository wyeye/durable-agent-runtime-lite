import { describe, expect, it } from 'vitest';
import {
  LOCAL_OLLAMA_MODEL_ID,
  applySmokeModelGatewayReadiness,
} from '../src/scripts/model-catalog-seed.js';

describe('model-catalog smoke readiness mapping', () => {
  it('keeps the explicit mock seed when runtime-worker reports the default local-dev profile', () => {
    expect(applySmokeModelGatewayReadiness(
      {
        profile: 'local-mock',
        model: 'dar-local-model',
        baseUrl: 'http://mock-server:4100',
      },
      {
        model_gateway_profile: 'local-dev',
        model_gateway_model: 'dar-local-model',
      },
    )).toEqual({
      profile: 'local-mock',
      model: 'dar-local-model',
      baseUrl: 'http://mock-server:4100',
    });
  });

  it('switches to the ollama seed when runtime-worker reports local-ollama', () => {
    expect(applySmokeModelGatewayReadiness(
      {
        profile: 'local-mock',
        model: 'dar-local-model',
        baseUrl: 'http://mock-server:4100',
      },
      {
        model_gateway_profile: 'local-ollama',
      },
    )).toEqual({
      profile: 'local-ollama',
      model: LOCAL_OLLAMA_MODEL_ID,
      baseUrl: 'http://host.docker.internal:11434/v1',
    });
  });
});
