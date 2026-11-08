import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { createGuest } from '../db/repos/guests';
import { getDoll, getDollByAnyToken, getDollByShortCode } from '../db/repos/dolls';
import { getProgress, markCollected, upsertDiscovered } from '../db/repos/progress';
import { getRoomByCode, getRoomById } from '../db/repos/rooms';
import type { RoomRow } from '../db/rows';
import { AppError } from '../lib/errors';
import { parseBody } from '../lib/http';
import { cardUrl, normalizeShortCode } from '../services/cards';
import {
  createGuestSession,
  guestCookie,
  readGuestSession,
  readGuestToken,
  requireGuest,
} from '../services/guest-auth';
import { buildE1View, collectionSummary } from '../services/play';

export interface PlayRouteOptions {
  config: AppConfig;
  db: Db;
  secret: Buffer;
}

const ShortcodeBody = z
  .object({
    room_code: z.string().regex(/^\d{6}$/, '房间码必须是 6 位数字'),
    short_code: z.string().min(1).max(12),
  })
  .strict();

const JoinBody = z
  .object({
    room_code: z.string().regex(/^\d{6}$/, '房间码必须是 6 位数字'),
    nickname: z.string().trim().min(1).max(20),
    device_hint: z.string().max(40).optional(),
  })
  .strict();

const DiscoverBody = z
  .object({ doll_id: z.string().min(1).max(40) })
  .strict();

const COLLECTED_STATES = new Set(['collected', 'egg_answering', 'egg_unlocked']);

function finaleHint(room: RoomRow): {
  enabled: boolean;
  trigger: string | null;
  hard_mode: boolean;
} {
  try {
    const finale = JSON.parse(room.finale_json) as {
      enabled?: unknown;
      trigger?: { type?: unknown };
    };
    const trigger = typeof finale.trigger?.type === 'string' ? finale.trigger.type : null;
    return {
      enabled: Boolean(finale.enabled),
      trigger,
      hard_mode: trigger === 'all_eggs',
    };
  } catch {
    return { enabled: false, trigger: null, hard_mode: false };
  }
}

function countDolls(db: Db, roomId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM dolls WHERE room_id = ?').get(roomId) as { n: number })
    .n;
}

export async function playRoutes(
  app: FastifyInstance,
  options: PlayRouteOptions,
): Promise<void> {
  const deps = { db: options.db, secret: options.secret };

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

  app.post('/api/guests/join', async (request, reply) => {
    const body = parseBody(JoinBody, request.body);

    const room = getRoomByCode(options.db, body.room_code);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间码不存在');
    if (room.status !== 'live') {
      throw new AppError('ROOM_NOT_LIVE', 403, '这一局还没开始或已结束');
    }

    const guest = createGuest(options.db, {
      roomId: room.room_id,
      nickname: body.nickname,
      deviceHint: body.device_hint ?? '',
    });
    const { token } = createGuestSession(options.secret, guest.guest_id, room.room_id);

    reply.header('set-cookie', guestCookie(token));

    return {
      guest_id: guest.guest_id,
      guest_token: token,
      room: {
        room_id: room.room_id,
        title: room.title,
        status: room.status,
      },
      doll_count: countDolls(options.db, room.room_id),
      finale_hint: finaleHint(room),
    };
  });

  app.post('/api/guests/resume', async (request, reply) => {
    const token = readGuestToken(request);
    const session = readGuestSession(request, deps);
    if (!token || !session) {
      throw new AppError('GUEST_UNAUTHORIZED', 401, '请先填写昵称');
    }

    reply.header('set-cookie', guestCookie(token));
    return { guest_id: session.guestId, room_id: session.roomId };
  });

  app.get('/api/play/d/:token', async (request) => {
    const session = requireGuest(request, deps);
    const { token } = request.params as { token: string };

    const doll = getDollByAnyToken(options.db, token);
    if (!doll) throw new AppError('TOKEN_INVALID', 403, '这张卡不属于本局');

    const room = getRoomById(options.db, doll.room_id);
    if (!room || room.room_id !== session.roomId) {
      throw new AppError('TOKEN_INVALID', 403, '这张卡不属于本局');
    }
    if (room.status !== 'live') {
      throw new AppError('ROOM_NOT_LIVE', 403, '这一局还没开始或已结束');
    }

    // Scanning is the "discovered" write (idempotent; powers the host board).
    upsertDiscovered(options.db, room.room_id, session.guestId, doll.doll_id);

    return buildE1View(options.db, options.config, options.secret, session, doll);
  });

  app.post('/api/play/discover', async (request) => {
    const session = requireGuest(request, deps);
    const body = parseBody(DiscoverBody, request.body);

    const doll = getDoll(options.db, body.doll_id);
    if (!doll || doll.room_id !== session.roomId) {
      throw new AppError('DOLL_NOT_FOUND', 404, '人偶不存在');
    }

    const room = getRoomById(options.db, doll.room_id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');
    if (room.status !== 'live') {
      throw new AppError('ROOM_NOT_LIVE', 403, '这一局还没开始或已结束');
    }

    const prior = getProgress(options.db, room.room_id, session.guestId, doll.doll_id);
    const already = prior !== undefined && COLLECTED_STATES.has(prior.state);

    const updated = markCollected(options.db, room.room_id, session.guestId, doll.doll_id);
    const summary = collectionSummary(options.db, room.room_id, session.guestId);

    return {
      state: updated.state,
      already,
      collection: { found: summary.found, total: summary.total },
      // Finale evaluation is implemented in T801; keep the wire shape stable.
      finale: { reached: false, remaining: summary.remaining },
    };
  });
}
