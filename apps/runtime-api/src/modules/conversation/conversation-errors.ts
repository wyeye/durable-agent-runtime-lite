import { ConversationRepositoryError } from '@dar/db';

export class ConversationServiceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ConversationServiceError';
  }
}

export function mapConversationError(error: unknown): never {
  if (error instanceof ConversationServiceError) {
    throw error;
  }
  if (error instanceof ConversationRepositoryError) {
    throw new ConversationServiceError(
      error.code,
      statusForConversationCode(error.code),
      error.details,
    );
  }
  throw error;
}

export function statusForConversationCode(code: string): number {
  switch (code) {
    case 'CONVERSATION_NOT_FOUND':
    case 'CONVERSATION_MESSAGE_NOT_FOUND':
      return 404;
    case 'CONVERSATION_ACCESS_DENIED':
      return 403;
    case 'CONVERSATION_CONTEXT_HASH_MISMATCH':
    case 'CONVERSATION_MESSAGE_TOO_LARGE':
    case 'CONVERSATION_CONTEXT_TOO_LARGE':
      return 422;
    case 'CONVERSATION_ARCHIVED':
    case 'CONVERSATION_REVISION_CONFLICT':
    case 'CONVERSATION_TURN_IN_PROGRESS':
    case 'CONVERSATION_MESSAGE_IDEMPOTENCY_CONFLICT':
    case 'CONVERSATION_FINALIZATION_CONFLICT':
      return 409;
    default:
      return 400;
  }
}
