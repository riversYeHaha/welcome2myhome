import type { FastifyServerOptions } from 'fastify';
import type { AppConfig } from '../config';

type LogReq = {
  method?: string;
  url?: string;
  ip?: string;
  id?: string;
};

type LogRes = {
  statusCode?: number;
};

/**
 * Fastify/pino logger options.
 *
 * Redaction matters: tickets and guest tokens live in headers or query strings.
 * The request serializer keeps only the pathname, so `?t=<ticket>` never lands
 * in the log file.
 */
export function buildLoggerOptions(config: AppConfig, options: { pretty: boolean }): FastifyServerOptions['logger'] {
  const base: Record<string, unknown> = {
    level: config.logging.level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.ticket',
        '*.guest_token',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(req: LogReq) {
        return {
          id: req.id,
          method: req.method,
          path: (req.url ?? '').split('?')[0],
          ip: req.ip,
        };
      },
      res(res: LogRes) {
        return { statusCode: res.statusCode };
      },
    },
  };

  if (!options.pretty) {
    return base as FastifyServerOptions['logger'];
  }

  return {
    ...base,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:mm:ss',
        ignore: 'pid,hostname',
      },
    },
  } as FastifyServerOptions['logger'];
}
