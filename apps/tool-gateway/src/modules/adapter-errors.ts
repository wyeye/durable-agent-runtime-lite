export class ToolAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ToolAdapterError';
  }
}

export function adapterError(code: string, message: string, retryable = false): ToolAdapterError {
  return new ToolAdapterError(code, message, retryable);
}
