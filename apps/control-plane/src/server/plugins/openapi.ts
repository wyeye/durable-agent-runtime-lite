import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { RuntimeConfig } from '@dar/config';
import { translate } from '@dar/i18n';

export async function openApiPlugin(server: FastifyInstance, options: { config: RuntimeConfig }): Promise<void> {
  await server.register(swagger, {
    openapi: {
      info: {
        title: translate('common.openapi.controlPlaneTitle', undefined, options.config.DEFAULT_LOCALE),
        description: translate('common.openapi.controlPlaneDescription', undefined, options.config.DEFAULT_LOCALE),
        version: options.config.APP_VERSION,
      },
    },
  });

  server.get('/openapi.json', async () => server.swagger());

  if (options.config.CONTROL_PLANE_SWAGGER_ENABLED) {
    await server.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
      },
    });
  }
}
