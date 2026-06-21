import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveLocale, type SupportedLocale } from './locale.js';
import { createTranslator, type Translator } from './translator.js';

declare module 'fastify' {
  interface FastifyRequest {
    locale: SupportedLocale;
    t: Translator;
  }
}

export async function fastifyLocalePlugin(server: FastifyInstance): Promise<void> {
  installFastifyLocale(server);
}

export function installFastifyLocale(server: FastifyInstance): void {
  server.addHook('onRequest', async (request, reply) => {
    const locale = resolveLocale(request.headers['accept-language']);
    request.locale = locale;
    request.t = createTranslator(locale);
    setLocaleHeaders(reply, locale);
  });
}

export function setLocaleHeaders(reply: FastifyReply, locale: SupportedLocale): void {
  reply.header('Content-Language', locale);
  const existing = reply.getHeader('Vary');
  const vary = Array.isArray(existing) ? existing.join(', ') : String(existing ?? '');
  const values = vary
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === 'accept-language')) {
    values.push('Accept-Language');
  }
  reply.header('Vary', values.join(', '));
}

export function requestLocale(request: FastifyRequest): SupportedLocale {
  return request.locale ?? resolveLocale(request.headers['accept-language']);
}
