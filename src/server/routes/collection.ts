import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { markFinaleReached } from '../db/repos/guests';
import { getPrimaryRoom, getRoomById } from '../db/repos/rooms';
import { AppError } from '../lib/errors';
import { buildCollection } from '../services/collection';
import { evaluateFinale, finaleContent } from '../services/finale';
import { readGuestSession, requireGuest } from '../services/guest-auth';
import { renderCollectionPage } from '../views/collection';
import { renderFinalePage } from '../views/finale';
import { renderErrorPage } from '../views/html';

export interface CollectionRouteOptions {
  config: AppConfig;
  db: Db;
  secret: Buffer;
}

function sendHtml(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(body);
}

export async function collectionRoutes(
  app: FastifyInstance,
  options: CollectionRouteOptions,
): Promise<void> {
  const deps = { db: options.db, secret: options.secret };

  app.get('/api/collection', async (request) => {
    const session = requireGuest(request, deps);
    return buildCollection(options.db, options.config, options.secret, session);
  });

  app.get('/collection', async (request, reply) => {
    const session = readGuestSession(request, deps);
    if (!session) {
      const room = getPrimaryRoom(options.db);
      if (!room) {
        return sendHtml(
          reply,
          404,
          renderErrorPage({ title: '房间还没有创建', message: '请让主人先在管理端布置房间。' }),
        );
      }
      return reply.redirect(`/join?r=${encodeURIComponent(room.room_code)}&next=%2Fcollection`);
    }

    const room = getRoomById(options.db, session.roomId);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const data = buildCollection(options.db, options.config, options.secret, session);
    return sendHtml(reply, 200, renderCollectionPage(data));
  });

  app.get('/finale', async (request, reply) => {
    const session = readGuestSession(request, deps);
    if (!session) {
      const room = getPrimaryRoom(options.db);
      if (!room) {
        return sendHtml(
          reply,
          404,
          renderErrorPage({ title: '房间还没有创建', message: '请让主人先在管理端布置房间。' }),
        );
      }
      return reply.redirect(`/join?r=${encodeURIComponent(room.room_code)}&next=%2Ffinale`);
    }

    const room = getRoomById(options.db, session.roomId);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const evaluation = evaluateFinale(options.db, room, session.guestId);
    if (evaluation.reached) markFinaleReached(options.db, session.guestId);

    return sendHtml(
      reply,
      200,
      renderFinalePage({
        reached: evaluation.reached,
        content: evaluation.reached ? finaleContent(evaluation.config) : null,
        remaining: evaluation.progress.remaining,
      }),
    );
  });
}
