import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { getGuest, markFinaleReached } from '../db/repos/guests';
import { getPrimaryRoom, getRoomById } from '../db/repos/rooms';
import { AppError } from '../lib/errors';
import { emitEvent, type BoardHub } from '../lib/events';
import { buildCollection } from '../services/collection';
import { renderShareCard } from '../services/share';
import { evaluateFinale, finaleContent } from '../services/finale';
import { readGuestSession, requireGuest } from '../services/guest-auth';
import { renderCollectionPage } from '../views/collection';
import { renderFinalePage } from '../views/finale';
import { nowIso } from '../lib/ids';
import { renderErrorPage } from '../views/html';

export interface CollectionRouteOptions {
  config: AppConfig;
  db: Db;
  secret: Buffer;
  hub: BoardHub;
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

  /** T803: settlement/share card PNG for the guest's collection. */
  app.get('/api/share/card.png', async (request, reply) => {
    const session = requireGuest(request, deps);
    const data = buildCollection(options.db, options.config, options.secret, session);
    if (data.summary.found === 0) {
      throw new AppError('NOTHING_COLLECTED', 409, '先收集至少一位成员，再来生成分享卡');
    }

    const guest = getGuest(options.db, session.guestId);
    const names = data.items
      .filter((item) => item.state !== 'locked' && item.name)
      .map((item) => item.name as string);

    const png = await renderShareCard({
      roomTitle: data.room.title,
      guestName: guest?.nickname ?? '',
      found: data.summary.found,
      total: data.summary.total,
      eggs: data.summary.eggs,
      names,
      finaleTitle:
        data.finale.reached && data.finale.content ? data.finale.content.title : null,
      date: nowIso().slice(0, 10).replace(/-/g, '.'),
    });

    return reply
      .type('image/png')
      .header('cache-control', 'no-store')
      .header('content-disposition', 'inline; filename="welcome-home-share.png"')
      .send(png);
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
    const seenBefore = Boolean(getGuest(options.db, session.guestId)?.finale_reached_at);
    if (evaluation.reached) markFinaleReached(options.db, session.guestId);
    if (evaluation.reached && !seenBefore) {
      emitEvent(options.db, options.hub, {
        roomId: room.room_id,
        type: 'session_complete',
        guestId: session.guestId,
        payload: { finale: true },
      });
    }

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
