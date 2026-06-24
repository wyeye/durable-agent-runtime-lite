import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoCliRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const repoRoot = dirname(dirname(repoCliRoot));

export function fromRepo(...parts: string[]): string {
  return join(repoRoot, ...parts);
}

export function fromRepoCli(...parts: string[]): string {
  return join(repoCliRoot, ...parts);
}
