import type { FastifyInstance } from 'fastify';
import {
  conversationCreateRequestSchema,
  conversationMessageQuerySchema,
  conversationQuerySchema,
  conversationSendMessageRequestSchema,
  conversationUpdateRequestSchema,
} from '@dar/contracts';
import type { RuntimeApiOperationsClient } from '../clients/runtime-api-client.js';
import { authOf } from '../plugins/auth.js';
import { jsonSchema, ok, requestIdOf } from '../utils/http.js';

export interface ConversationRoutesOptions {
  runtimeApiClient: RuntimeApiOperationsClient;
}

export async function conversationRoutes(
  server: FastifyInstance,
  options: ConversationRoutesOptions,
): Promise<void> {
  server.get('/api/v1/conversations', {
    schema: { querystring: jsonSchema(conversationQuerySchema) },
  }, async (request) => {
    const auth = authOf(request);
    const query = conversationQuerySchema.parse(request.query);
    return ok(
      await options.runtimeApiClient.listConversations(
        toSearchParams(query),
        forward(auth, requestIdOf(request), request.locale),
      ),
      auth.request_id,
    );
  });

  server.post('/api/v1/conversations', {
    schema: { body: jsonSchema(conversationCreateRequestSchema) },
  }, async (request) => {
    const auth = authOf(request);
    return ok(
      await options.runtimeApiClient.createConversation(
        conversationCreateRequestSchema.parse(request.body),
        forward(auth, requestIdOf(request), request.locale),
      ),
      auth.request_id,
    );
  });

  server.get('/api/v1/conversations/:conversationId', async (request) => {
    const auth = authOf(request);
    const { conversationId } = request.params as { conversationId: string };
    return ok(
      await options.runtimeApiClient.getConversation(
        conversationId,
        forward(auth, requestIdOf(request), request.locale),
      ),
      auth.request_id,
    );
  });

  server.patch('/api/v1/conversations/:conversationId', {
    schema: { body: jsonSchema(conversationUpdateRequestSchema) },
  }, async (request) => {
    const auth = authOf(request);
    const { conversationId } = request.params as { conversationId: string };
    return ok(
      await options.runtimeApiClient.updateConversation(
        conversationId,
        conversationUpdateRequestSchema.parse(request.body),
        forward(auth, requestIdOf(request), request.locale),
      ),
      auth.request_id,
    );
  });

  server.post('/api/v1/conversations/:conversationId/archive', async (request) => {
    const auth = authOf(request);
    const { conversationId } = request.params as { conversationId: string };
    return ok(
      await options.runtimeApiClient.archiveConversation(
        conversationId,
        forward(auth, requestIdOf(request), request.locale),
      ),
      auth.request_id,
    );
  });

  server.post('/api/v1/conversations/:conversationId/unarchive', async (request) => {
    const auth = authOf(request);
    const { conversationId } = request.params as { conversationId: string };
    return ok(
      await options.runtimeApiClient.unarchiveConversation(
        conversationId,
        forward(auth, requestIdOf(request), request.locale),
      ),
      auth.request_id,
    );
  });

  server.get('/api/v1/conversations/:conversationId/messages', {
    schema: { querystring: jsonSchema(conversationMessageQuerySchema) },
  }, async (request) => {
    const auth = authOf(request);
    const { conversationId } = request.params as { conversationId: string };
    const query = conversationMessageQuerySchema.parse(request.query);
    return ok(
      await options.runtimeApiClient.listConversationMessages(
        conversationId,
        toSearchParams(query),
        forward(auth, requestIdOf(request), request.locale),
      ),
      auth.request_id,
    );
  });

  server.post('/api/v1/conversations/:conversationId/messages', {
    schema: { body: jsonSchema(conversationSendMessageRequestSchema) },
  }, async (request) => {
    const auth = authOf(request);
    const { conversationId } = request.params as { conversationId: string };
    return ok(
      await options.runtimeApiClient.sendConversationMessage(
        conversationId,
        conversationSendMessageRequestSchema.parse(request.body),
        forward(auth, requestIdOf(request), request.locale),
      ),
      auth.request_id,
    );
  });
}

function forward(
  auth: { user_id: string; tenant_id: string; roles: string[] },
  requestId?: string,
  locale = 'zh-CN',
) {
  return {
    userId: auth.user_id,
    tenantId: auth.tenant_id,
    roles: auth.roles,
    ...(requestId ? { requestId } : {}),
    locale,
  };
}

function toSearchParams(values: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  return params;
}
