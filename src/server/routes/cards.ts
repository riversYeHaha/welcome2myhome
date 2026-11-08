import type { FastifyInstance } from 'fastify';
import type { Db } from '../db';
import { getDoll } from '../db/repos/dolls';
import { getPrimaryRoom, getRoomById } from '../db/repos/rooms';
import { AppError } from '../lib/errors';
import { cardUrl, qrPng, welcomeUrl } from '../services/cards';

export interface CardRouteOptions {
  db: Db;
}

/**
 * QR PNG endpoints. They are public by design: a QR only encodes the card URL
 * (which is printed on the card) and never contains answers or secret assets.
 */
export async function cardRoutes(
  app: FastifyInstance,
  options: CardRouteOptions,
): Promise<void> {
  app.get('/api/cards/:dollId/qr.png', async (request, reply) => {
    const { dollId } = request.params as { dollId: string };

    const doll = getDoll(options.db, dollId);
    if (!doll) throw new AppError('NOT_FOUND', 404, '人偶不存在');

    const room = getRoomById(options.db, doll.room_id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const png = await qrPng(cardUrl(room, doll.card_token, request.hostname));
    return reply
      .type('image/png')
      .header('cache-control', 'public, max-age=300')
      .send(png);
  });

  app.get('/api/cards/welcome.png', async (request, reply) => {
    const room = getPrimaryRoom(options.db);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间还没有创建');

    const png = await qrPng(welcomeUrl(room, request.hostname));
    return reply
      .type('image/png')
      .header('cache-control', 'public, max-age=300')
      .send(png);
  });
}
