import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { getDoll } from '../db/repos/dolls';
import { AppError } from '../lib/errors';
import { verifyTicket } from '../services/ticket';

export interface AssetRouteOptions {
  config: AppConfig;
  db: Db;
  secret: Buffer;
}

const KINDS = new Set(['base-model', 'photo', 'secret-model']);

/** Whitelisted silhouette names (`d_xxx_silhouette.png`, tech design §7.4). */
const SILHOUETTE_NAME = /^[A-Za-z0-9_-]+\.png$/;

function etagOf(file: string): { size: number; etag: string } {
  const stat = statSync(file);
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  return { size: stat.size, etag };
}

/**
 * Parse a single `bytes=` range (tech design §5.8). Multi-range requests are
 * ignored and answered with the full body, which is allowed by RFC 9110.
 * Returns `'invalid'` for a syntactically valid but unsatisfiable range.
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return null;

  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) {
    return 'invalid';
  }
  return { start, end: Math.min(end, size - 1) };
}

/** Stream one file with `ETag`, `Range` and `Cache-Control` (§5.8). */
function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: string,
  contentType: string,
  cacheControl: string,
): FastifyReply {
  const { size, etag } = etagOf(file);
  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch === etag) {
    return reply.code(304).header('etag', etag).header('cache-control', cacheControl).send();
  }

  const range = parseRange(request.headers.range, size);
  if (range === 'invalid') {
    return reply.code(416).header('content-range', `bytes */${size}`).send();
  }
  if (range) {
    return reply
      .code(206)
      .type(contentType)
      .header('cache-control', cacheControl)
      .header('etag', etag)
      .header('accept-ranges', 'bytes')
      .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
      .header('content-length', String(range.end - range.start + 1))
      .send(createReadStream(file, { start: range.start, end: range.end }));
  }

  return reply
    .type(contentType)
    .header('cache-control', cacheControl)
    .header('etag', etag)
    .header('accept-ranges', 'bytes')
    .header('content-length', String(size))
    .send(createReadStream(file));
}

/**
 * Ticket-protected base assets (tech design §4.4). E2 assets get their own
 * `secret` scope in T702; the same route can branch then.
 */
export async function assetRoutes(
  app: FastifyInstance,
  options: AssetRouteOptions,
): Promise<void> {
  app.get('/api/assets/:dollId/:kind', async (request, reply) => {
    const { dollId, kind } = request.params as { dollId: string; kind: string };
    if (!KINDS.has(kind)) throw new AppError('NOT_FOUND', 404, '资产类型不存在');

    const ticket = (request.query as { t?: string }).t;
    if (!ticket) throw new AppError('TICKET_INVALID', 403, '缺少资产凭证');

    const scope = kind === 'secret-model' ? 'secret' : 'base';
    verifyTicket(options.secret, ticket, { scope, dollId });

    const doll = getDoll(options.db, dollId);
    if (!doll) throw new AppError('NOT_FOUND', 404, '人偶不存在');

    const file =
      kind === 'secret-model'
        ? join(options.config.paths.models, `${doll.doll_id}_alt.glb`)
        : kind === 'base-model'
          ? join(options.config.paths.models, `${doll.doll_id}.glb`)
          : join(options.config.paths.photos, `${doll.doll_id}_src.jpg`);

    if (!existsSync(file)) {
      throw new AppError('ASSET_NOT_FOUND', 404, '资产还没准备好');
    }

    return sendFile(
      request,
      reply,
      file,
      kind === 'photo' ? 'image/jpeg' : 'model/gltf-binary',
      'private, max-age=86400',
    );
  });

  // Silhouettes are public placeholders — they reveal no name/answer/story
  // (§5.8). Path traversal is blocked by the name whitelist + resolve check.
  app.get('/assets/silhouettes/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    if (!SILHOUETTE_NAME.test(file)) {
      throw new AppError('NOT_FOUND', 404, '剪影不存在');
    }
    const dir = resolve(options.config.paths.silhouettes);
    const full = resolve(dir, file);
    if (!full.startsWith(dir + sep) || !existsSync(full)) {
      throw new AppError('NOT_FOUND', 404, '剪影不存在');
    }
    return sendFile(request, reply, full, 'image/png', 'public, max-age=604800');
  });
}
