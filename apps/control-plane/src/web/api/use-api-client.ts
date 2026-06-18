import { useMemo } from 'react';
import { useIdentity } from '../auth/identity-context.js';
import { ApiClient } from './client.js';

export function useApiClient(): ApiClient {
  const { identity } = useIdentity();
  return useMemo(() => new ApiClient({ getIdentity: () => identity }), [identity]);
}
