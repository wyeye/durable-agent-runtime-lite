import type { ToolManifest } from '@dar/contracts';
import type { RuntimeConfig } from '@dar/config';
import { adapterError } from './adapter-errors.js';
import { HttpReadonlyAdapter, type SafeToolContext, type ToolAdapterInvokeInput } from './http-readonly-adapter.js';
import { HttpToolUrlPolicy } from './http-url-policy.js';
import { invokeMockAdapter } from './mock-adapter.js';

export interface ToolAdapter {
  invoke(input: ToolAdapterInvokeInput): Promise<unknown>;
  supportsCommit?: boolean;
}

export interface ToolAdapterDispatcherOptions {
  adapters?: Partial<Record<ToolManifest['adapter']['type'], ToolAdapter>>;
}

class MockToolAdapter implements ToolAdapter {
  supportsCommit = true;

  async invoke(input: ToolAdapterInvokeInput): Promise<unknown> {
    return invokeMockAdapter({ toolName: input.manifest.tool_name, args: input.arguments });
  }
}

export class ToolAdapterDispatcher {
  private readonly adapters: Partial<Record<ToolManifest['adapter']['type'], ToolAdapter>>;

  constructor(options: ToolAdapterDispatcherOptions = {}) {
    this.adapters = {
      mock: new MockToolAdapter(),
      ...options.adapters,
    };
  }

  static fromConfig(config: RuntimeConfig): ToolAdapterDispatcher {
    return new ToolAdapterDispatcher({
      adapters: {
        http_readonly: new HttpReadonlyAdapter({
          urlPolicy: HttpToolUrlPolicy.fromConfig(config),
          maxTimeoutMs: config.TOOL_HTTP_MAX_TIMEOUT_MS,
          maxResponseBytes: config.TOOL_HTTP_MAX_RESPONSE_BYTES,
        }),
      },
    });
  }

  async invoke(input: {
    manifest: ToolManifest;
    arguments: Record<string, unknown>;
    requestContext: SafeToolContext;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const adapter = this.adapters[input.manifest.adapter.type];
    if (!adapter) {
      throw adapterError('TOOL_ADAPTER_NOT_SUPPORTED', '工具 Adapter 不受支持');
    }
    return adapter.invoke(input);
  }

  assertCommitSupported(manifest: ToolManifest): void {
    const adapter = this.adapters[manifest.adapter.type];
    if (!adapter?.supportsCommit) {
      throw adapterError('TOOL_ADAPTER_NOT_SUPPORTED', '当前工具 Adapter 不支持 commit');
    }
  }
}
