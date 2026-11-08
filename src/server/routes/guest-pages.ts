import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { createGuest } from '../db/repos/guests';
import { getDollByAnyToken } from '../db/repos/dolls';
import { markCollected, upsertDiscovered } from '../db/repos/progress';
import { getRoomByCode, getRoomById } from '../db/repos/rooms';
import { buildE1View } from '../services/play';
import {
  createGuestSession,
  guestCookie,
  readGuestSession,
} from '../services/guest-auth';
import { renderCardPage } from '../views/card';
import { renderErrorPage } from '../views/html';
import { renderJoinPage } from '../views/join';

export interface GuestPageOptions {
  config: AppConfig;
  db: Db;
  secret: Buffer;
}

const COLLECTED_STATES = new Set(['collected', 'egg_answering', 'egg_unlocked']);

function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.length > 512
  ) {
    return '/';
  }
  return value;
}

function sendHtml(reply: FastifyReply, status: number, body: string): FastifyReply {
  return reply
    .code(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(body);
}

function sendError(
  reply: FastifyReply,
  status: number,
  title: string,
  message: string,
  backHref = '/',
): FastifyReply {
  return sendHtml(reply, status, renderErrorPage({ title, message, backHref }));
}

function roomUnavailableMessage(status: string): string {
  if (status === 'paused') return '这一局暂时暂停了，等主人重新开始。';
  if (status === 'ended') return '这一局已经结束，可以回看收藏，但不能再拆新卡。';
  return '这一局还没开始，等主人开局后再来。';
}

export async function guestPages(
  app: FastifyInstance,
  options: GuestPageOptions,
): Promise<void> {
  const deps = { db: options.db, secret: options.secret };

  app.get('/d/:token', async (request, reply) => {
    const { token } = request.params as { token: string };

    const doll = getDollByAnyToken(options.db, token);
    if (!doll) {
      return sendError(reply, 404, '这张卡不属于本局', '核对一下卡面上的短码，或回首页重新进入。');
    }

    const room = getRoomById(options.db, doll.room_id);
    if (!room) {
      return sendError(reply, 404, '房间不存在', '请让主人检查房间是否已创建。');
    }

    const session = readGuestSession(request, deps);
    if (!session) {
      const next = encodeURIComponent(request.url);
      return reply.redirect(`/join?r=${encodeURIComponent(room.room_code)}&next=${next}`);
    }

    if (session.roomId !== room.room_id) {
      return sendError(reply, 403, '这张卡不属于本局', '请回到本次游戏的欢迎码重新进入。');
    }

    if (room.status !== 'live') {
      return sendError(reply, 403, '这一局暂时不能拆卡', roomUnavailableMessage(room.status));
    }

    const progress = upsertDiscovered(
      options.db,
      room.room_id,
      session.guestId,
      doll.doll_id,
    );
    const view = buildE1View(
      options.db,
      options.config,
      options.secret,
      session,
      doll,
    );

    return sendHtml(
      reply,
      200,
      renderCardPage({
        view,
        token,
        collected: COLLECTED_STATES.has(progress.state),
      }),
    );
  });

  app.post('/d/:token/collect', async (request, reply) => {
    const { token } = request.params as { token: string };

    const doll = getDollByAnyToken(options.db, token);
    if (!doll) {
      return sendError(reply, 404, '这张卡不属于本局', '核对一下卡面上的短码。');
    }

    const room = getRoomById(options.db, doll.room_id);
    if (!room) {
      return sendError(reply, 404, '房间不存在', '请让主人检查房间。');
    }

    const session = readGuestSession(request, deps);
    if (!session) {
      const next = encodeURIComponent(`/d/${encodeURIComponent(token)}`);
      return reply.redirect(`/join?r=${encodeURIComponent(room.room_code)}&next=${next}`);
    }

    if (session.roomId !== room.room_id) {
      return sendError(reply, 403, '这张卡不属于本局', '请回到本次游戏的欢迎码重新进入。');
    }
    if (room.status !== 'live') {
      return sendError(reply, 403, '这一局暂时不能收藏', roomUnavailableMessage(room.status));
    }

    markCollected(options.db, room.room_id, session.guestId, doll.doll_id);
    return reply.code(303).redirect(`/d/${encodeURIComponent(token)}`);
  });

  app.get('/join', async (request, reply) => {
    const query = request.query as { r?: string; next?: string };
    const session = readGuestSession(request, deps);

    if (session) {
      const room = getRoomById(options.db, session.roomId);
      if (room && (!query.r || room.room_code === query.r)) {
        return reply.redirect(safeNext(query.next));
      }
    }

    return sendHtml(
      reply,
      200,
      renderJoinPage({
        roomCode: typeof query.r === 'string' ? query.r : '',
        next: safeNext(query.next),
      }),
    );
  });

  app.post('/join', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const roomCodeRaw = typeof body.room_code === 'string' ? body.room_code.trim() : '';
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
    const next = safeNext(body.next);

    const joinError = (message: string): FastifyReply =>
      sendHtml(
        reply,
        422,
        renderJoinPage({ roomCode: roomCodeRaw, next, error: message }),
      );

    if (!/^\d{6}$/.test(roomCodeRaw)) return joinError('房间码是 6 位数字，再看看门口或餐桌上的欢迎码。');
    if (nickname.length === 0 || nickname.length > 20) return joinError('昵称留 1–20 个字就好。');

    const room = getRoomByCode(options.db, roomCodeRaw);
    if (!room) return joinError('房间码不对，或者这个家还没开门。');
    if (room.status !== 'live') {
      return sendError(reply, 403, '这一局暂时进不来', roomUnavailableMessage(room.status));
    }

    const guest = createGuest(options.db, { roomId: room.room_id, nickname });
    const { token } = createGuestSession(options.secret, guest.guest_id, room.room_id);

    reply.header('set-cookie', guestCookie(token));
    return reply.code(303).redirect(next);
  });
}
