import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { createGuest, getGuest, markFinaleReached } from '../db/repos/guests';
import { getDoll, getDollByAnyToken, getDollByShortCode } from '../db/repos/dolls';
import {
  getProgress,
  markCollected,
  recordAttempt,
  skipEgg,
  startEgg,
  unlockEgg,
  upsertDiscovered,
} from '../db/repos/progress';
import { getRoomByCode, getRoomById } from '../db/repos/rooms';
import type { DollRow, RoomRow } from '../db/rows';
import { AppError } from '../lib/errors';
import { CLIENT_EVENT_TYPES, emitEvent, type BoardHub } from '../lib/events';
import { parseBody } from '../lib/http';
import { publicHost } from '../lib/network';
import { SlidingWindowLimiter } from '../lib/rate-limit';
import { cardUrl, normalizeShortCode } from '../services/cards';
import {
  createGuestSession,
  guestCookie,
  readGuestSession,
  readGuestToken,
  requireGuest,
} from '../services/guest-auth';
import { evaluateFinale } from '../services/finale';
import { verifyAnswer } from '../services/judge';
import { buildE1View, collectionSummary } from '../services/play';
import { signTicket } from '../services/ticket';

export interface PlayRouteOptions {
  config: AppConfig;
  db: Db;
  secret: Buffer;
  hub: BoardHub;
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

const EggBody = z
  .object({ doll_id: z.string().min(1).max(40) })
  .strict();

const AnswerBody = z.union([
  z
    .object({
      doll_id: z.string().min(1).max(40),
      choice_index: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      doll_id: z.string().min(1).max(40),
      answer_text: z.string().max(200),
    })
    .strict(),
]);

const COLLECTED_STATES = new Set(['collected', 'egg_answering', 'egg_unlocked']);

const TelemetryBody = z
  .object({
    type: z.enum(CLIENT_EVENT_TYPES),
    doll_id: z.string().min(1).max(40).optional(),
    payload: z
      .record(z.union([z.string().max(80), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict();

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

function parseOptions(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function secretPayload(doll: DollRow, ticket: string) {
  return {
    story: doll.secret_story,
    whisper: doll.secret_whisper,
    effect: doll.secret_effect,
    star: doll.secret_star === 1,
    model_url: doll.secret_model_url
      ? `/api/assets/${encodeURIComponent(doll.doll_id)}/secret-model?t=${encodeURIComponent(ticket)}`
      : null,
  };
}

function secretResponse(doll: DollRow, ticket: string) {
  return {
    correct: true as const,
    secret_ticket: ticket,
    secret: secretPayload(doll, ticket),
  };
}

export async function playRoutes(
  app: FastifyInstance,
  options: PlayRouteOptions,
): Promise<void> {
  const deps = { db: options.db, secret: options.secret };

  const burstLimiter = new SlidingWindowLimiter(options.config.judge.burstPer30s, 30_000);
  const guestLimiter = new SlidingWindowLimiter(options.config.judge.perGuestPerMin, 60_000);
  const telemetryLimiter = new SlidingWindowLimiter(120, 60_000);

  function note(
    roomId: string,
    type: string,
    guestId: string,
    extra: { dollId?: string | null; payload?: Record<string, unknown> } = {},
  ): void {
    emitEvent(options.db, options.hub, {
      roomId,
      type,
      guestId,
      dollId: extra.dollId ?? null,
      payload: extra.payload,
    });
  }

  /** Idempotent finale bookkeeping; emits only on the first success. */
  function settleFinale(room: RoomRow, guestId: string): ReturnType<typeof evaluateFinale> {
    const evaluation = evaluateFinale(options.db, room, guestId);
    if (!evaluation.reached) return evaluation;

    const seen = Boolean(getGuest(options.db, guestId)?.finale_reached_at);
    markFinaleReached(options.db, guestId);
    if (!seen) {
      note(room.room_id, 'finale_reached', guestId, {
        payload: { trigger: evaluation.config.trigger.type, remaining: 0 },
      });
    }
    return evaluation;
  }

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
      card_url: cardUrl(room, doll.card_token, publicHost(room, request.hostname)),
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
    note(room.room_id, 'guest_join', guest.guest_id, {
      payload: { nickname: guest.nickname, channel: 'join' },
    });

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
    note(room.room_id, 'card_scanned', session.guestId, {
      dollId: doll.doll_id,
      payload: { doll_id: doll.doll_id, short_code: doll.short_code },
    });

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

    note(room.room_id, 'progress', session.guestId, {
      dollId: doll.doll_id,
      payload: { doll_id: doll.doll_id, state: updated.state, already },
    });

    const evaluation = settleFinale(room, session.guestId);

    return {
      state: updated.state,
      already,
      collection: { found: summary.found, total: summary.total },
      finale: { reached: evaluation.reached, remaining: evaluation.progress.remaining },
    };
  });
  app.post('/api/play/egg/start', async (request) => {
    const session = requireGuest(request, deps);
    const body = parseBody(EggBody, request.body);

    const doll = getDoll(options.db, body.doll_id);
    if (!doll || doll.room_id !== session.roomId) {
      throw new AppError('DOLL_NOT_FOUND', 404, '人偶不存在');
    }
    const room = getRoomById(options.db, doll.room_id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');
    if (room.status !== 'live') {
      throw new AppError('ROOM_NOT_LIVE', 403, '这一局还没开始或已结束');
    }
    if (doll.egg_enabled !== 1) {
      throw new AppError('EGG_DISABLED', 409, '这张卡没有彩蛋题');
    }

    const current = getProgress(options.db, room.room_id, session.guestId, doll.doll_id);
    if (!current || current.state === 'locked' || current.state === 'discovered') {
      throw new AppError('EGG_NOT_READY', 409, '先收下 TA，再来听故事');
    }

    if (current.state === 'collected') {
      startEgg(options.db, room.room_id, session.guestId, doll.doll_id);
      note(room.room_id, 'egg_challenge_started', session.guestId, {
        dollId: doll.doll_id,
        payload: { doll_id: doll.doll_id },
      });
    }

    const updated = getProgress(options.db, room.room_id, session.guestId, doll.doll_id);
    return {
      state: updated?.state ?? current.state,
      attempts: updated?.attempts ?? current.attempts,
      egg_skipped: updated?.egg_skipped === 1,
    };
  });

  app.post('/api/play/egg/skip', async (request) => {
    const session = requireGuest(request, deps);
    const body = parseBody(EggBody, request.body);

    const doll = getDoll(options.db, body.doll_id);
    if (!doll || doll.room_id !== session.roomId) {
      throw new AppError('DOLL_NOT_FOUND', 404, '人偶不存在');
    }
    const room = getRoomById(options.db, doll.room_id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');
    if (room.status !== 'live') {
      throw new AppError('ROOM_NOT_LIVE', 403, '这一局还没开始或已结束');
    }

    const current = getProgress(options.db, room.room_id, session.guestId, doll.doll_id);
    if (!current || current.state === 'locked' || current.state === 'discovered') {
      throw new AppError('EGG_NOT_READY', 409, '先收下 TA，再来听故事');
    }

    if (current.state !== 'egg_unlocked') {
      skipEgg(options.db, room.room_id, session.guestId, doll.doll_id);
      note(room.room_id, 'progress', session.guestId, {
        dollId: doll.doll_id,
        payload: { doll_id: doll.doll_id, state: 'collected', skipped: true },
      });
    }

    const updated = getProgress(options.db, room.room_id, session.guestId, doll.doll_id);
    return {
      state: updated?.state ?? current.state,
      egg_skipped: updated?.egg_skipped === 1,
    };
  });

  app.get('/api/play/secret/:dollId', async (request) => {
    const session = requireGuest(request, deps);
    const { dollId } = request.params as { dollId: string };

    const doll = getDoll(options.db, dollId);
    if (!doll || doll.room_id !== session.roomId) {
      throw new AppError('DOLL_NOT_FOUND', 404, '人偶不存在');
    }

    const progress = getProgress(options.db, doll.room_id, session.guestId, doll.doll_id);
    if (progress?.state !== 'egg_unlocked') {
      throw new AppError('EGG_LOCKED', 403, '先答对 TA 的题，才能听到这段故事');
    }

    const ticket = signTicket(options.secret, {
      scope: 'secret',
      dollId: doll.doll_id,
      guestId: session.guestId,
      ttlSec: options.config.ticket.ttlSec,
    });

    return { secret_ticket: ticket, secret: secretPayload(doll, ticket) };
  });

  app.post('/api/play/answer', async (request, reply) => {
    const session = requireGuest(request, deps);
    const body = parseBody(AnswerBody, request.body);

    const doll = getDoll(options.db, body.doll_id);
    if (!doll || doll.room_id !== session.roomId) {
      throw new AppError('DOLL_NOT_FOUND', 404, '人偶不存在');
    }
    const room = getRoomById(options.db, doll.room_id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');
    if (room.status !== 'live') {
      throw new AppError('ROOM_NOT_LIVE', 403, '这一局还没开始或已结束');
    }
    if (doll.egg_enabled !== 1 || doll.answer_hash.length === 0) {
      throw new AppError('EGG_DISABLED', 409, '这张卡没有彩蛋题');
    }

    const current = getProgress(options.db, room.room_id, session.guestId, doll.doll_id);

    // Reopening an unlocked egg is idempotent and does not consume attempts.
    if (current?.state === 'egg_unlocked') {
      const ticket = signTicket(options.secret, {
        scope: 'secret',
        dollId: doll.doll_id,
        guestId: session.guestId,
        ttlSec: options.config.ticket.ttlSec,
      });
      return secretResponse(doll, ticket);
    }

    if (!current || (current.state !== 'collected' && current.state !== 'egg_answering')) {
      throw new AppError('EGG_NOT_READY', 409, '先收下 TA，再来听故事');
    }

    const burstKey = `${session.guestId}:${doll.doll_id}`;
    const burstOk = burstLimiter.allow(burstKey);
    const guestOk = guestLimiter.allow(session.guestId);
    if (!burstOk || !guestOk) {
      const retry = Math.max(
        burstLimiter.retryAfterSec(burstKey),
        guestLimiter.retryAfterSec(session.guestId),
      );
      reply.header('retry-after', String(retry));
      throw new AppError('RATE_LIMITED', 429, '慢一点，歇口气再试', true);
    }

    let submitted: string;
    if ('choice_index' in body) {
      const choices = parseOptions(doll.options_json);
      if (body.choice_index >= choices.length) {
        throw new AppError('VALIDATION_FAILED', 422, '选项不存在');
      }
      submitted = choices[body.choice_index]!;
    } else {
      submitted = body.answer_text;
    }

    let correct = false;
    try {
      correct = verifyAnswer(submitted, doll.answer_hash, doll.synonyms_json);
    } catch {
      throw new AppError('JUDGE_UNAVAILABLE', 503, '故事稍后再来', true);
    }

    if (!correct) {
      if (current.state === 'collected') {
        startEgg(options.db, room.room_id, session.guestId, doll.doll_id);
      }
      const updated = recordAttempt(
        options.db,
        room.room_id,
        session.guestId,
        doll.doll_id,
      );
      note(room.room_id, 'answer_submit', session.guestId, {
        dollId: doll.doll_id,
        payload: {
          doll_id: doll.doll_id,
          correct: false,
          attempts: updated?.attempts ?? current.attempts + 1,
        },
      });
      return {
        correct: false as const,
        wrong_text: doll.wrong_text || '还差一点点，再想想那天……',
        ...(doll.hint ? { hint: doll.hint } : {}),
        attempts: updated?.attempts ?? current.attempts + 1,
        max_attempts: doll.max_attempts,
        can_retry: true,
        can_skip: true,
      };
    }

    const updated = unlockEgg(options.db, room.room_id, session.guestId, doll.doll_id);
    if (!updated) throw new AppError('JUDGE_UNAVAILABLE', 503, '故事稍后再来', true);

    note(room.room_id, 'answer_submit', session.guestId, {
      dollId: doll.doll_id,
      payload: { doll_id: doll.doll_id, correct: true, attempts: updated.attempts },
    });
    note(room.room_id, 'egg2_unlocked', session.guestId, {
      dollId: doll.doll_id,
      payload: { doll_id: doll.doll_id },
    });

    const ticket = signTicket(options.secret, {
      scope: 'secret',
      dollId: doll.doll_id,
      guestId: session.guestId,
      ttlSec: options.config.ticket.ttlSec,
    });
    const summary = collectionSummary(options.db, room.room_id, session.guestId);
    const evaluation = settleFinale(room, session.guestId);

    return {
      ...secretResponse(doll, ticket),
      collection: { found: summary.found, total: summary.total, eggs: summary.eggs },
      finale: { reached: evaluation.reached, remaining: evaluation.progress.remaining },
    };
  });

  /**
   * Browser-reported moments the server cannot observe: E1 playback, replays,
   * session completion and offline errors. Payloads stay whitelisted.
   */
  app.post('/api/play/telemetry', async (request, reply) => {
    const session = requireGuest(request, deps);
    const body = parseBody(TelemetryBody, request.body);

    if (!telemetryLimiter.allow(session.guestId)) {
      reply.header('retry-after', String(telemetryLimiter.retryAfterSec(session.guestId)));
      throw new AppError('RATE_LIMITED', 429, '上报太频繁了', true);
    }

    let dollId: string | null = null;
    if (body.doll_id) {
      const doll = getDoll(options.db, body.doll_id);
      if (!doll || doll.room_id !== session.roomId) {
        throw new AppError('DOLL_NOT_FOUND', 404, '人偶不存在');
      }
      dollId = doll.doll_id;
    }

    note(session.roomId, body.type, session.guestId, {
      dollId,
      payload: body.payload,
    });

    return reply.code(204).send();
  });
}
