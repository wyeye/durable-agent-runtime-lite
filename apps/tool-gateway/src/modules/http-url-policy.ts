import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { RuntimeConfig } from '@dar/config';
import type { ToolManifest } from '@dar/contracts';
import { adapterError } from './adapter-errors.js';

export interface HttpToolUrlPolicyOptions {
  allowedHosts: string[];
  allowInsecureLocalhost: boolean;
}

export interface HttpToolUrlPolicyResult {
  url: URL;
  hostname: string;
  resolvedAddresses: string[];
}

const LOCAL_DEVELOPMENT_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'mock-server']);

export class HttpToolUrlPolicy {
  constructor(private readonly options: HttpToolUrlPolicyOptions) {}

  static fromConfig(config: RuntimeConfig): HttpToolUrlPolicy {
    return new HttpToolUrlPolicy({
      allowedHosts: parseAllowedHosts(config.TOOL_HTTP_ALLOWED_HOSTS),
      allowInsecureLocalhost: config.TOOL_HTTP_ALLOW_INSECURE_LOCALHOST,
    });
  }

  async validate(manifest: ToolManifest): Promise<HttpToolUrlPolicyResult> {
    if (manifest.adapter.type !== 'http_readonly') {
      throw adapterError('TOOL_ADAPTER_NOT_SUPPORTED', 'HTTP URL 策略仅支持 http_readonly adapter');
    }
    const baseUrl = parseUrl(manifest.adapter.base_url);
    if (!baseUrl) {
      throw adapterError('TOOL_HTTP_INSECURE_URL', 'HTTP 工具 base_url 不合法');
    }
    if (baseUrl.username || baseUrl.password || baseUrl.hash) {
      throw adapterError('TOOL_HTTP_INSECURE_URL', 'HTTP 工具 URL 不能包含用户名、密码或 fragment');
    }
    if (!manifest.adapter.path.startsWith('/')) {
      throw adapterError('TOOL_HTTP_INSECURE_URL', 'HTTP 工具 path 必须以 / 开头');
    }

    const hostname = baseUrl.hostname.toLowerCase();
    if (!this.hostAllowed(hostname)) {
      throw adapterError('TOOL_HTTP_HOST_NOT_ALLOWED', 'HTTP 工具 Host 不在 Allowlist 中');
    }

    if (baseUrl.protocol !== 'https:') {
      const isLocal = LOCAL_DEVELOPMENT_HTTP_HOSTS.has(hostname);
      if (!(this.options.allowInsecureLocalhost && isLocal)) {
        throw adapterError('TOOL_HTTP_INSECURE_URL', '生产默认只允许 HTTPS HTTP 工具 URL');
      }
    }

    const target = new URL(manifest.adapter.path, baseUrl);
    target.search = '';
    target.hash = '';
    if (target.hostname.toLowerCase() !== hostname || target.protocol !== baseUrl.protocol) {
      throw adapterError('TOOL_HTTP_INSECURE_URL', 'HTTP 工具 path 不能改变 Host 或协议');
    }

    const resolvedAddresses = await resolveHost(hostname);
    for (const address of resolvedAddresses) {
      if (!this.addressAllowed(hostname, address)) {
        throw adapterError('TOOL_HTTP_HOST_NOT_ALLOWED', 'HTTP 工具 DNS 解析结果不在 Allowlist 或命中 SSRF 禁止网段');
      }
    }

    return { url: target, hostname, resolvedAddresses };
  }

  hostAllowed(hostname: string): boolean {
    if (this.options.allowedHosts.length === 0) {
      return false;
    }
    if (this.options.allowedHosts.includes('*')) {
      return false;
    }
    return this.options.allowedHosts.some((allowed) => hostnameMatches(hostname, allowed));
  }

  private addressAllowed(hostname: string, address: string): boolean {
    if (!isUnsafeAddress(address)) {
      return true;
    }
    return this.options.allowInsecureLocalhost && LOCAL_DEVELOPMENT_HTTP_HOSTS.has(hostname);
  }
}

export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function hostnameMatches(hostname: string, allowlistEntry: string): boolean {
  const normalized = allowlistEntry.toLowerCase();
  if (normalized === '*') {
    return false;
  }
  if (hostname === normalized) {
    return true;
  }
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  if (normalized.startsWith('.')) {
    return hostname.endsWith(normalized) && hostname.length > normalized.length;
  }
  return false;
}

async function resolveHost(hostname: string): Promise<string[]> {
  if (isIP(hostname) !== 0) {
    return [hostname];
  }
  if (hostname === 'localhost') {
    return ['127.0.0.1'];
  }
  try {
    const records = await lookup(hostname, { all: true, verbatim: false });
    return records.map((record) => record.address);
  } catch {
    if (hostname === 'mock-server') {
      return ['127.0.0.1'];
    }
    throw adapterError('TOOL_HTTP_HOST_NOT_ALLOWED', 'HTTP 工具 Host 无法解析');
  }
}

function isUnsafeAddress(address: string): boolean {
  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    const [a = 0, b = 0] = address.split('.').map((part) => Number.parseInt(part, 10));
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 192 && b === 168) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    return address === '100.100.100.200';
  }
  if (ipVersion === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fe80:')
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized === '::'
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:169.254.');
  }
  return true;
}
