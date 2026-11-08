import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { AppConfig } from './config';
import type { Db } from './db';
import { AppError } from './lib/errors';
import { buildLoggerOptions } from './lib/logger';
import { cardRoutes } from './routes/cards';
import { healthRoutes } from './routes/health';
import { hostRoutes } from './routes/host';
import { playRoutes } from './routes/play';
import './types';

export const APP_VERSION = '0.1.0';

export interface BuildAppOptions {
  config: AppConfig;
  db: Db;
  /** HMAC secret for host sessions and (later) tickets. */
  secret: Buffer;
  version?: string;
  /** Pass `false` in tests to keep output clean. */
  logger?: FastifyServerOptions['logger'];
}

/**
 * Compose the Fastify app. Kept side-effect free (no listen, no DB creation)
 * so integration tests can use `app.inject()` against a temp database.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db, secret, version = APP_VERSION } = options;
  const logger =
    options.logger ?? buildLoggerOptions(config, { pretty: process.env.NODE_ENV !== 'production' });

  const app = Fastify({
    logger,
    requestIdHeader: 'x-request-id',
    bodyLimit: 64 * 1024,
    trustProxy: false,
  });

  app.decorate('config', config);
  app.decorate('db', db);

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });

  // Error handler must be installed before routes are registered: Fastify
  // resolves the handler per route at registration time.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          requestId: request.id,
        },
      });
    }

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    }
    return reply.code(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
        message: statusCode >= 500 ? '服务暂时不可用' : '请求不合法',
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: '接口不存在', requestId: request.id },
      });
    }
    return reply.code(404).type('text/plain; charset=utf-8').send('Not Found');
  });

  await app.register(healthRoutes, { version });
  await app.register(hostRoutes, { config, db, secret });
  await app.register(cardRoutes, { db });
  await app.register(playRoutes, { db });

  const webRoot = config.paths.web;
  if (existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      index: ['index.html'],
    });
  } else {
    app.log.warn(
      { webRoot },
      'dist/web not found; static hosting disabled (run `npm run build` first)',
    );
  }

  return app;
}
