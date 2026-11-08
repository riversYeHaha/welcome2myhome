import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
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

const KINDS = new Set(['base-model', 'photo']);

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

    verifyTicket(options.secret, ticket, { scope: 'base', dollId });

    const doll = getDoll(options.db, dollId);
    if (!doll) throw new AppError('NOT_FOUND', 404, '人偶不存在');

    const file =
      kind === 'base-model'
        ? join(options.config.paths.models, `${doll.doll_id}.glb`)
        : join(options.config.paths.photos, `${doll.doll_id}_src.jpg`);

    if (!existsSync(file)) {
      throw new AppError('ASSET_NOT_FOUND', 404, '资产还没准备好');
    }

    return reply
      .type(kind === 'base-model' ? 'model/gltf-binary' : 'image/jpeg')
      .header('cache-control', 'private, max-age=86400')
      .send(createReadStream(file));
  });
}
