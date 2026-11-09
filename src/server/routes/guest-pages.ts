import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { createGuest } from '../db/repos/guests';
import { getDollByAnyToken, getDollByShortCode } from '../db/repos/dolls';
import { markCollected, upsertDiscovered } from '../db/repos/progress';
import { getPrimaryRoom, getRoomByCode, getRoomById } from '../db/repos/rooms';
import { normalizeShortCode } from '../services/cards';
import { buildE1View } from '../services/play';
import { readHostSession } from '../services/host-auth';
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

  /**
   * Welcome-code landing. The printed QR points at `/`, so route it straight to
   * the join flow (or the collection for a returning guest) instead of serving
   * the old static skeleton.
   */
  app.get('/', async (request, reply) => {
    const session = readGuestSession(request, deps);
    if (session) return reply.redirect('/collection');

    const room = getPrimaryRoom(options.db);
    if (!room) {
      return sendError(reply, 404, '房间还没有创建', '请让主人先在管理端布置房间。');
    }
    return reply.redirect(`/join?r=${encodeURIComponent(room.room_code)}`);
  });

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

    const query = request.query as { preview?: string };
    if (query.preview === '1') {
      const hostSession = readHostSession(request, {
        config: options.config,
        db: options.db,
        secret: options.secret,
      });
      if (!hostSession || hostSession.roomId !== room.room_id) {
        return sendError(reply, 403, '预览需要主人登录', '请先在主人电脑上登录管理端。');
      }

      const previewSession = { guestId: 'host_preview', roomId: room.room_id, exp: 0 };
      const view = buildE1View(
        options.db,
        options.config,
        options.secret,
        previewSession,
        doll,
      );
      return sendHtml(
        reply,
        200,
        renderCardPage({ view, token, collected: false, preview: true }),
      );
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
    const shortCodeRaw = typeof body.short_code === 'string' ? body.short_code.trim() : '';
    const next = safeNext(body.next);

    const joinError = (message: string): FastifyReply =>
      sendHtml(
        reply,
        422,
        renderJoinPage({
          roomCode: roomCodeRaw,
          shortCode: shortCodeRaw,
          next,
          error: message,
        }),
      );

    if (!/^\d{6}$/.test(roomCodeRaw)) return joinError('房间码是 6 位数字，再看看门口或餐桌上的欢迎码。');
    if (nickname.length === 0 || nickname.length > 20) return joinError('昵称留 1–20 个字就好。');

    const room = getRoomByCode(options.db, roomCodeRaw);
    if (!room) return joinError('房间码不对，或者这个家还没开门。');
    if (room.status !== 'live') {
      return sendError(reply, 403, '这一局暂时进不来', roomUnavailableMessage(room.status));
    }

    // Optional FR-23 short-code entry: the card's 6 chars stand in for a scan.
    let shortCodeDoll: ReturnType<typeof getDollByShortCode> = undefined;
    if (shortCodeRaw.length > 0) {
      if (!/^[0-9A-Za-z]{6}$/.test(shortCodeRaw)) {
        return joinError('卡片短码是 6 位字母或数字，再核对一下。');
      }
      shortCodeDoll = getDollByShortCode(options.db, normalizeShortCode(shortCodeRaw));
      if (!shortCodeDoll || shortCodeDoll.room_id !== room.room_id) {
        return joinError('短码不对，核对一下卡片上的 6 位短码。');
      }
    }

    const guest = createGuest(options.db, { roomId: room.room_id, nickname });
    const { token } = createGuestSession(options.secret, guest.guest_id, room.room_id);

    reply.header('set-cookie', guestCookie(token));
    const target = shortCodeDoll
      ? `/d/${encodeURIComponent(shortCodeDoll.card_token)}`
      : next;
    return reply.code(303).redirect(target);
  });
}
