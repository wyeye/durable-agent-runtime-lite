import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { RuntimeConfig } from '@dar/config';

export async function openApiPlugin(server: FastifyInstance, options: { config: RuntimeConfig }): Promise<void> {
  await server.register(swagger, {
    openapi: {
      info: {
        title: 'Durable Agent Runtime Lite Control Plane API',
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
