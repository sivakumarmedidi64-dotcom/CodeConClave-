/**
 * CodeConClave — Swagger/OpenAPI Documentation
 * Auto-generated API documentation using swagger-jsdoc and swagger-ui-express.
 */
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import type { Express } from 'express';
import { env } from '../config/env.js';

const swaggerOptions: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'CodeConClave API',
      version: '1.0.0',
      description: 'CodeConClave Pro — AI Developer Operating System API',
      contact: {
        name: 'CodeConClave Team',
        url: 'https://codeconclave.app',
      },
      license: {
        name: 'UNLICENSED',
      },
    },
    servers: [
      {
        url: env.API_URL || `http://localhost:${env.PORT}`,
        description: 'Current environment',
      },
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'cc_session',
        },
        csrfToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-csrf-token',
        },
      },
    },
    security: [
      {
        cookieAuth: [],
        csrfToken: [],
      },
    ],
    tags: [
      { name: 'Health', description: 'Health and readiness checks' },
      { name: 'Auth', description: 'Authentication and authorization' },
      { name: 'Chat', description: 'Chat and conversation endpoints' },
      { name: 'Projects', description: 'Project management' },
    ],
  },
  apis: [
    './src/modules/auth/routes.ts',
    './src/modules/conversations/routes.ts',
    './src/modules/projects/routes.ts',
    './src/server.ts',
  ],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

export function mountSwagger(app: Express): void {
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'CodeConClave API Docs',
      customfavIcon: '/favicon.ico',
    })
  );

  // Raw JSON spec endpoint
  app.get('/api/docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}