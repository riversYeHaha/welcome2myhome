import type { FastifyInstance } from 'fastify';
import type { Db } from '../db';
import { markFinaleReached } from '../db/repos/guests';
import { getRoomById } from '../db/repos/rooms';
import { AppError } from '../lib/errors';
import { evaluateFinale, finaleContent } from '../services/finale';
import { requireGuest } from '../services/guest-auth';

export interface FinaleRouteOptions {
  db: Db;
  secret: Buffer;
}

/**
 * Guest finale endpoint. Not-reached returns only progress; reached returns the
 * host-configured content and idempotently records `finale_reached_at`.
 */
export async function finaleRoutes(
  app: FastifyInstance,
  options: FinaleRouteOptions,
): Promise<void> {
  app.get('/api/finale/:room_id', async (request) => {
    const session = requireGuest(request, { db: options.db, secret: options.secret });
    const { room_id } = request.params as { room_id: string };

    if (room_id !== session.roomId) {
      throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');
    }

    const room = getRoomById(options.db, room_id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const evaluation = evaluateFinale(options.db, room, session.guestId);
    if (!evaluation.reached) {
      return { reached: false, progress: evaluation.progress };
    }

    markFinaleReached(options.db, session.guestId);
    return { reached: true, content: finaleContent(evaluation.config) };
  });
}
