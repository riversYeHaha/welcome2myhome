import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db';
import { getDollByShortCode } from '../db/repos/dolls';
import { getRoomByCode } from '../db/repos/rooms';
import { AppError } from '../lib/errors';
import { parseBody } from '../lib/http';
import { cardUrl, normalizeShortCode } from '../services/cards';

export interface PlayRouteOptions {
  db: Db;
}

const ShortcodeBody = z
  .object({
    room_code: z.string().regex(/^\d{6}$/, '房间码必须是 6 位数字'),
    short_code: z.string().min(1).max(12),
  })
  .strict();

/**
 * Guest entry points. T401 adds `/api/play/d/:token`; for now the short code
 * resolves to the same card URL so the SSR card page can take over.
 */
export async function playRoutes(
  app: FastifyInstance,
  options: PlayRouteOptions,
): Promise<void> {
  app.post('/api/play/shortcode', async (request) => {
    const body = parseBody(ShortcodeBody, request.body);

    const room = getRoomByCode(options.db, body.room_code);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间码不存在');
    if (room.status !== 'live') {
      throw new AppError('ROOM_NOT_LIVE', 403, '这一局还没开始或已结束');
    }

    const shortCode = normalizeShortCode(body.short_code);
    const doll = getDollByShortCode(options.db, shortCode);
    if (!doll || doll.room_id !== room.room_id) {
      throw new AppError('SHORTCODE_INVALID', 404, '短码无效，请核对卡片');
    }

    return {
      doll_id: doll.doll_id,
      card_url: cardUrl(room, doll.card_token, request.hostname),
    };
  });
}
