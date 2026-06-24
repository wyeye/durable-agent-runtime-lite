import { spawn } from 'node:child_process';
import { repoRoot } from './paths.js';

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (!options.inherit) {
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

export function assertSuccess(result: RunResult, label: string): void {
  if (result.code !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
    throw new Error(`${label} failed with exit code ${result.code}${detail ? `\n${detail}` : ''}`);
  }
}
