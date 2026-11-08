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
 * Redact bearer-ish secrets from a request URL before it reaches the log file.
 *
 * The query string is dropped entirely (`?t=<ticket>`), and card tokens in the
 * path are replaced (`/d/<token>`, `/api/play/d/<token>`). The pathname itself
 * is kept so access logs stay useful.
 */
export function redactLogPath(url: string): string {
  const pathname = (url.split('?')[0] ?? '').split('#')[0] ?? '';
  return pathname.replace(/(^|\/)d\/[^/]+/g, '$1d/[redacted]');
}

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
          path: redactLogPath(req.url ?? ''),
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
