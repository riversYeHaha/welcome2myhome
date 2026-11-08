import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RoomStatus } from '../../shared/contracts';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { getDoll, listDolls } from '../db/repos/dolls';
import {
  createRoom,
  getRoomById,
  setRoomHostPinHash,
  setRoomLanIp,
  setRoomStatus,
} from '../db/repos/rooms';
import type { RoomRow } from '../db/rows';
import { hashSecret, verifySecret } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { parseBody } from '../lib/http';
import { LoginThrottle } from '../lib/login-throttle';
import { isUniqueViolation } from '../lib/sqlite';
import { issueBackupToken } from '../services/cards';
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

function roomView(room: RoomRow) {
  return {
    room_id: room.room_id,
    room_code: room.room_code,
    title: room.title,
    status: room.status,
    game_mode: room.game_mode,
    default_level_type: room.default_level_type,
    lan_ip: room.lan_ip,
    port: room.port,
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

    return { room: roomView(room), dolls: listDolls(options.db, id) };
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
