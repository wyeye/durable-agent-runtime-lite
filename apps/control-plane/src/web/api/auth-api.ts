import type { IamResolvedIdentity } from '@dar/contracts';
import type { ApiClient } from './client.js';

export interface LocalDevLoginInput {
  user_id: string;
  tenant_id: string;
  password: string;
}

export function localDevLogin(client: ApiClient, input: LocalDevLoginInput): Promise<IamResolvedIdentity> {
  return client.request('/api/v1/auth/dev-login', {
    method: 'POST',
    body: input,
  });
}
