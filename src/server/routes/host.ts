import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RoomStatus } from '../../shared/contracts';
import type { HostDoll, HostRoom } from '../../shared/host';
import { isLevelTypeAvailableForP0 } from '../../shared/levels';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import {
  deleteDoll,
  getDoll,
  listDolls,
  updateDollBasics,
  updateDollLevel,
} from '../db/repos/dolls';
import {
  createRoom,
  getRoomById,
  setRoomFinaleJson,
  setRoomHostPinHash,
  setRoomLanIp,
  setRoomStatus,
} from '../db/repos/rooms';
import type { DollRow, RoomRow } from '../db/rows';
import { hashSecret, verifySecret } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { parseBody } from '../lib/http';
import { LoginThrottle } from '../lib/login-throttle';
import { isUniqueViolation } from '../lib/sqlite';
import {
  FinaleInputSchema,
  dollCount,
  eggQuizDollCount,
  parseFinaleConfig,
} from '../services/finale';
import { createDollWithCard, issueBackupToken } from '../services/cards';
import { hashAnswer, normalizeAnswer } from '../services/judge';
import {
  clearSessionCookie,
  createHostSession,
  readHostSession,
  requireCsrf,
  requireHost,
  requireLocal,
  sessionCookie,
} from '../services/host-auth';

export interface HostRouteOptions {
  config: AppConfig;
  db: Db;
  secret: Buffer;
}

const PinSchema = z.string().regex(/^\d{4,8}$/, 'PIN 必须是 4–8 位数字');
const SetupBody = z
  .object({
    pin: PinSchema,
    title: z.string().trim().min(1).max(60).optional(),
    roomCode: z
      .string()
      .regex(/^\d{6}$/, '房间码必须是 6 位数字')
      .optional(),
  })
  .strict();
const LoginBody = z.object({ pin: PinSchema }).strict();
const ChangePinBody = z.object({ currentPin: PinSchema, newPin: PinSchema }).strict();
const RoomStatusBody = z
  .object({ status: z.enum(['draft', 'live', 'paused', 'ended']) })
  .strict();
const NetworkBody = z
  .object({
    lan_ip: z.string().ip({ version: 'v4' }),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

const CreateDollBody = z
  .object({
    name: z.string().trim().min(1).max(30),
    tagline: z.string().max(80).optional(),
    levelType: z.enum(['discovery', 'bonus_quiz']).optional(),
  })
  .strict();

const BasicsBody = z
  .object({
    name: z.string().trim().min(1).max(30).optional(),
    tagline: z.string().max(80).optional(),
    silhouetteUrl: z.string().max(300).optional(),
    clue: z.string().max(120).optional(),
    hideHint: z.string().max(120).optional(),
    baseStory: z.string().max(200).optional(),
    baseCaption: z.string().max(120).optional(),
  })
  .strict();

const RiddleBody = z
  .object({
    type: z.enum(['single_choice', 'short_answer']).optional(),
    question: z.string().max(200).default(''),
    options: z.array(z.string().max(40)).max(4).default([]),
    answer: z.string().max(100).default(''),
    hint: z.string().max(200).default(''),
    wrong_text: z.string().max(200).default(''),
    max_attempts: z.number().int().min(0).max(100).default(0),
    synonyms: z.array(z.string().max(40)).max(20).default([]),
  })
  .strict();

const SecretBody = z
  .object({
    story: z.string().max(1000).default(''),
    whisper: z.string().max(200).default(''),
    effect: z.string().max(40).default('golden_gather'),
    star: z.boolean().default(true),
    model_url: z.string().max(300).nullable().optional(),
  })
  .strict();

const LevelBody = z
  .object({
    level_type: z.enum(['discovery', 'bonus_quiz', 'clue_chain', 'duo_scan', 'timed']),
    egg_enabled: z.boolean(),
    next_clue: z.string().max(120).nullable().optional(),
    e1: z
      .object({
        effect: z.enum(['starlight', 'confetti', 'bubbles', 'sparks']),
        sound: z.boolean(),
      })
      .strict(),
    riddle: RiddleBody.optional(),
    secret: SecretBody.optional(),
  })
  .strict();

const TRANSITIONS: Record<RoomStatus, readonly RoomStatus[]> = {
  draft: ['live'],
  live: ['paused', 'ended'],
  paused: ['live', 'ended'],
  ended: [],
};

function primaryRoom(db: Db): RoomRow | undefined {
  return db
    .prepare(
      'SELECT * FROM rooms WHERE host_pin_hash IS NOT NULL ORDER BY created_at ASC LIMIT 1',
    )
    .get() as RoomRow | undefined;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function dollView(doll: DollRow): HostDoll {
  return {
    doll_id: doll.doll_id,
    room_id: doll.room_id,
    name: doll.name,
    tagline: doll.tagline,
    sort_order: doll.sort_order,
    card_token: doll.card_token,
    short_code: doll.short_code,
    clue: doll.clue,
    hide_hint: doll.hide_hint,
    silhouette_url: doll.silhouette_url,
    level_type: doll.level_type,
    next_clue: doll.next_clue,
    egg_enabled: doll.egg_enabled === 1,
    e1_effect: doll.e1_effect,
    e1_sound: doll.e1_sound === 1,
    riddle_type: doll.riddle_type,
    question: doll.question,
    options: parseStringArray(doll.options_json),
    hint: doll.hint,
    wrong_text: doll.wrong_text,
    max_attempts: doll.max_attempts,
    answer_configured: doll.answer_hash.length > 0,
    synonyms: parseStringArray(doll.synonyms_json),
    base_story: doll.base_story,
    base_caption: doll.base_caption,
    base_model_url: doll.base_model_url,
    base_photo_url: doll.base_photo_url,
    secret_model_url: doll.secret_model_url,
    secret_story: doll.secret_story,
    secret_whisper: doll.secret_whisper,
    secret_effect: doll.secret_effect,
    secret_star: doll.secret_star === 1,
    gen_status: doll.gen_status,
  };
}

function roomView(room: RoomRow): HostRoom {
  return {
    room_id: room.room_id,
    room_code: room.room_code,
    title: room.title,
    status: room.status,
    game_mode: room.game_mode,
    default_level_type: room.default_level_type,
    lan_ip: room.lan_ip,
    port: room.port,
    finale: parseFinaleConfig(room.finale_json),
  };
}

/**
 * Host administration. Every route is local-only (unless `allowLanAdmin`),
 * authenticated by the `wtm_host` cookie, and mutations additionally require
 * the `X-WTM-CSRF` header derived from the session.
 */
export async function hostRoutes(
  app: FastifyInstance,
  options: HostRouteOptions,
): Promise<void> {
  const throttle = new LoginThrottle();
  const deps = { config: options.config, db: options.db, secret: options.secret };

  function requestIp(request: FastifyRequest): string {
    return request.ip;
  }

  app.get('/api/host/status', async (request) => {
    requireLocal(request, options.config);

    const room = primaryRoom(options.db);
    const session = readHostSession(request, deps);

    return {
      initialized: Boolean(room),
      authenticated: Boolean(session),
      room: room ? roomView(room) : null,
      ...(session ? { csrfToken: session.csrfToken } : {}),
    };
  });

  app.post('/api/host/setup', async (request, reply) => {
    requireLocal(request, options.config);
    if (primaryRoom(options.db)) {
      throw new AppError('ALREADY_INITIALIZED', 409, '主人端已初始化，请直接登录');
    }

    const body = parseBody(SetupBody, request.body);
    let room: RoomRow;
    try {
      room = createRoom(options.db, {
        title: body.title ?? '欢迎来到我的家',
        roomCode: body.roomCode,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError('ROOM_CODE_TAKEN', 409, '房间码已被占用，请换一个');
      }
      throw error;
    }

    const pinHash = hashSecret(body.pin, options.config.judge.scrypt);
    const updated = setRoomHostPinHash(options.db, room.room_id, pinHash);
    const { token, session } = createHostSession(options.secret, room.room_id, pinHash);

    reply.header('set-cookie', sessionCookie(token));
    return { room: roomView(updated ?? room), csrfToken: session.csrfToken };
  });

  app.post('/api/host/login', async (request, reply) => {
    requireLocal(request, options.config);

    const room = primaryRoom(options.db);
    if (!room) throw new AppError('NEEDS_SETUP', 409, '尚未初始化，请先设置 PIN');

    const ip = requestIp(request);
    if (throttle.isBlocked(ip)) {
      reply.header('retry-after', String(throttle.retryAfterSec(ip)));
      throw new AppError('RATE_LIMITED', 429, '尝试次数过多，请稍后再试', true);
    }

    const body = parseBody(LoginBody, request.body);
    if (!room.host_pin_hash || !verifySecret(body.pin, room.host_pin_hash)) {
      throttle.recordFailure(ip);
      throw new AppError('PIN_INVALID', 401, 'PIN 不正确');
    }
    throttle.reset(ip);

    const { token, session } = createHostSession(
      options.secret,
      room.room_id,
      room.host_pin_hash,
    );
    reply.header('set-cookie', sessionCookie(token));
    return { room: roomView(room), csrfToken: session.csrfToken };
  });

  app.post('/api/host/logout', async (request, reply) => {
    requireLocal(request, options.config);
    reply.header('set-cookie', clearSessionCookie());
    return reply.code(204).send();
  });

  app.get('/api/host/me', async (request) => {
    const session = requireHost(request, deps);
    const room = getRoomById(options.db, session.roomId);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');
    return { room: roomView(room), csrfToken: session.csrfToken };
  });

  app.post('/api/host/pin', async (request, reply) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const body = parseBody(ChangePinBody, request.body);
    const room = getRoomById(options.db, session.roomId);
    if (!room?.host_pin_hash || !verifySecret(body.currentPin, room.host_pin_hash)) {
      throw new AppError('PIN_INVALID', 401, '当前 PIN 不正确');
    }

    const nextHash = hashSecret(body.newPin, options.config.judge.scrypt);
    setRoomHostPinHash(options.db, room.room_id, nextHash);

    const { token, session: nextSession } = createHostSession(
      options.secret,
      room.room_id,
      nextHash,
    );
    reply.header('set-cookie', sessionCookie(token));
    return { csrfToken: nextSession.csrfToken };
  });

  app.get('/api/room/:id', async (request) => {
    const session = requireHost(request, deps);
    const { id } = request.params as { id: string };
    if (id !== session.roomId) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const room = getRoomById(options.db, id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    return { room: roomView(room), dolls: listDolls(options.db, id).map(dollView) };
  });

  app.post('/api/dolls', async (request) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const body = parseBody(CreateDollBody, request.body);
    const doll = createDollWithCard(options.db, {
      roomId: session.roomId,
      name: body.name,
      tagline: body.tagline,
      levelType: body.levelType,
    });

    return { doll: dollView(doll) };
  });

  app.patch('/api/dolls/:id', async (request) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const { id } = request.params as { id: string };
    const doll = getDoll(options.db, id);
    if (!doll || doll.room_id !== session.roomId) {
      throw new AppError('NOT_FOUND', 404, '人偶不存在');
    }

    const body = parseBody(BasicsBody, request.body);
    const updated = updateDollBasics(options.db, id, body);
    if (!updated) throw new AppError('NOT_FOUND', 404, '人偶不存在');
    return { doll: dollView(updated) };
  });

  app.delete('/api/dolls/:id', async (request, reply) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const { id } = request.params as { id: string };
    const doll = getDoll(options.db, id);
    if (!doll || doll.room_id !== session.roomId) {
      throw new AppError('NOT_FOUND', 404, '人偶不存在');
    }

    deleteDoll(options.db, id);
    return reply.code(204).send();
  });

  app.patch('/api/dolls/:id/level', async (request) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const { id } = request.params as { id: string };
    const doll = getDoll(options.db, id);
    if (!doll || doll.room_id !== session.roomId) {
      throw new AppError('NOT_FOUND', 404, '人偶不存在');
    }

    const body = parseBody(LevelBody, request.body);
    if (!isLevelTypeAvailableForP0(body.level_type)) {
      throw new AppError('LEVEL_TYPE_NOT_AVAILABLE', 422, '该关卡类型将在后续版本开放');
    }

    const isDiscovery = body.level_type === 'discovery';
    const eggEnabled = isDiscovery ? false : body.egg_enabled;
    const riddle = isDiscovery ? undefined : body.riddle;

    const riddleType = eggEnabled ? (riddle?.type ?? 'short_answer') : null;
    const question = eggEnabled ? (riddle?.question ?? '') : '';
    const answer = eggEnabled ? (riddle?.answer ?? '') : '';
    const hintText = eggEnabled ? (riddle?.hint ?? '') : '';
    const wrongText = eggEnabled ? (riddle?.wrong_text ?? '') : '';
    const maxAttempts = eggEnabled ? (riddle?.max_attempts ?? 0) : 0;
    const synonymInput = eggEnabled ? (riddle?.synonyms ?? []) : [];

    let answerHash = '';
    let synonyms: string[] = [];
    let choiceOptions: string[] = [];

    if (eggEnabled) {
      if (question.trim().length === 0 || answer.trim().length === 0) {
        throw new AppError('VALIDATION_FAILED', 422, '启用彩蛋题时必须填写题干和答案');
      }

      choiceOptions = (riddle?.options ?? [])
        .map((option) => option.trim())
        .filter(Boolean);

      if (riddleType === 'single_choice') {
        if (choiceOptions.length < 2 || choiceOptions.length > 4) {
          throw new AppError('VALIDATION_FAILED', 422, '单选题需要 2–4 个选项');
        }
        const normalizedAnswer = normalizeAnswer(answer);
        if (
          !choiceOptions.some(
            (option) => normalizeAnswer(option) === normalizedAnswer,
          )
        ) {
          throw new AppError('VALIDATION_FAILED', 422, '正确答案必须是选项之一');
        }
      }

      answerHash = hashAnswer(answer, options.config.judge.scrypt);
      synonyms = [
        ...new Set(
          synonymInput
            .map(normalizeAnswer)
            .filter((synonym) => synonym.length > 0),
        ),
      ];
    }

    const secret = body.secret;
    const updated = updateDollLevel(options.db, id, {
      levelType: body.level_type,
      nextClue: body.next_clue ?? null,
      eggEnabled,
      e1Effect: body.e1.effect,
      e1Sound: body.e1.sound,
      riddleType,
      question,
      optionsJson: JSON.stringify(choiceOptions),
      hint: hintText,
      wrongText,
      maxAttempts,
      answerHash,
      synonymsJson: JSON.stringify(synonyms),
      secretModelUrl: secret?.model_url || null,
      secretStory: secret?.story ?? '',
      secretWhisper: secret?.whisper ?? '',
      secretEffect: secret?.effect ?? 'golden_gather',
      secretStar: secret?.star ?? true,
    });

    if (!updated) throw new AppError('NOT_FOUND', 404, '人偶不存在');
    return { doll: dollView(updated) };
  });

  app.patch('/api/room/:id/finale', async (request) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const { id } = request.params as { id: string };
    if (id !== session.roomId) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const input = parseBody(FinaleInputSchema, request.body);
    const room = getRoomById(options.db, id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const total = dollCount(options.db, id);
    if (input.trigger.type === 'count_gte' && input.trigger.value > total) {
      throw new AppError('VALIDATION_FAILED', 422, `触发人数不能超过房间人偶数（${total}）`);
    }

    const previous = parseFinaleConfig(room.finale_json);
    const finale = {
      ...input,
      trigger: {
        type: input.trigger.type,
        value: input.trigger.type === 'count_gte' ? input.trigger.value : null,
      },
      opened_at:
        input.trigger.type === 'manual' ? previous.opened_at : null,
    };

    const updated = setRoomFinaleJson(options.db, id, JSON.stringify(finale));
    const warning =
      input.trigger.type === 'all_eggs' && eggQuizDollCount(options.db, id) === 0
        ? '当前没有任何彩蛋题，all_eggs 将等价于 all_collected'
        : undefined;

    return {
      finale: parseFinaleConfig(updated?.finale_json ?? JSON.stringify(finale)),
      ...(warning ? { warning } : {}),
    };
  });

  app.post('/api/room/:id/finale/open', async (request) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const { id } = request.params as { id: string };
    if (id !== session.roomId) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const room = getRoomById(options.db, id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const finale = parseFinaleConfig(room.finale_json);
    if (finale.trigger.type !== 'manual') {
      throw new AppError('FINALE_NOT_MANUAL', 409, '终局不是手动模式，无需手动开启');
    }

    const next = {
      ...finale,
      opened_at: finale.opened_at ?? new Date().toISOString(),
    };
    const updated = setRoomFinaleJson(options.db, id, JSON.stringify(next));

    return { finale: parseFinaleConfig(updated?.finale_json ?? JSON.stringify(next)) };
  });

  app.patch('/api/room/:id/network', async (request) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const { id } = request.params as { id: string };
    if (id !== session.roomId) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const body = parseBody(NetworkBody, request.body);
    const updated = setRoomLanIp(options.db, id, body.lan_ip, body.port);
    if (!updated) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    return { room: roomView(updated) };
  });

  app.post('/api/dolls/:id/backup-token', async (request) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const { id } = request.params as { id: string };
    const doll = getDoll(options.db, id);
    if (!doll || doll.room_id !== session.roomId) {
      throw new AppError('NOT_FOUND', 404, '人偶不存在');
    }

    const updated = issueBackupToken(options.db, id);
    return { doll_id: updated.doll_id, backup_token: updated.card_token_backup };
  });

  app.patch('/api/room/:id/status', async (request) => {
    const session = requireHost(request, deps);
    requireCsrf(request, session, deps);

    const { id } = request.params as { id: string };
    if (id !== session.roomId) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const body = parseBody(RoomStatusBody, request.body);
    const room = getRoomById(options.db, id);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    if (!TRANSITIONS[room.status].includes(body.status)) {
      throw new AppError(
        'INVALID_TRANSITION',
        409,
        `房间不能从 ${room.status} 切换到 ${body.status}`,
      );
    }

    const updated = setRoomStatus(options.db, id, body.status);
    return { room: roomView(updated ?? room) };
  });

}
