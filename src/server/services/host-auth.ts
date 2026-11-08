import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { getRoomById } from '../db/repos/rooms';
import { parseCookies } from '../lib/cookies';
import { hmacToken, pinVersion, signToken, verifyToken } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { isLoopback } from '../lib/http';
import { randomBase62 } from '../lib/ids';

export const HOST_COOKIE = 'wtm_host';
export const HOST_SESSION_TTL_SEC = 12 * 60 * 60;

interface HostSessionPayload {
  v: 1;
  sid: string;
  r: string;
  exp: number;
  pinv: string;
}

export interface HostSession {
  roomId: string;
  sid: string;
  exp: number;
  csrfToken: string;
}

export interface HostAuthDeps {
  config: AppConfig;
  db: Db;
  secret: Buffer;
}

function csrfFor(secret: Buffer, sid: string): string {
  return hmacToken(secret, `csrf:${sid}`);
}

export function createHostSession(
  secret: Buffer,
  roomId: string,
  pinHash: string,
): { token: string; session: HostSession } {
  const sid = randomBase62(24);
  const payload: HostSessionPayload = {
    v: 1,
    sid,
    r: roomId,
    exp: Math.floor(Date.now() / 1000) + HOST_SESSION_TTL_SEC,
    pinv: pinVersion(pinHash),
  };

  return {
    token: signToken(payload, secret),
    session: { roomId, sid, exp: payload.exp, csrfToken: csrfFor(secret, sid) },
  };
}

/**
 * Verify the `wtm_host` cookie and re-check `pinv` against the live PIN hash,
 * so changing the PIN invalidates every previously issued session.
 */
export function readHostSession(request: FastifyRequest, deps: HostAuthDeps): HostSession | null {
  const token = parseCookies(request.headers.cookie)[HOST_COOKIE];
  if (!token) return null;

  const payload = verifyToken<HostSessionPayload>(token, deps.secret);
  if (!payload || payload.v !== 1 || typeof payload.sid !== 'string') return null;
  if (payload.exp * 1000 <= Date.now()) return null;

  const room = getRoomById(deps.db, payload.r);
  if (!room?.host_pin_hash) return null;
  if (payload.pinv !== pinVersion(room.host_pin_hash)) return null;

  return {
    roomId: room.room_id,
    sid: payload.sid,
    exp: payload.exp,
    csrfToken: csrfFor(deps.secret, payload.sid),
  };
}

/** Admin UI/API is local-only unless the host explicitly opts into LAN admin. */
export function requireLocal(request: FastifyRequest, config: AppConfig): void {
  if (config.server.allowLanAdmin) return;
  if (!isLoopback(request.socket.remoteAddress)) {
    throw new AppError('HOST_LOCAL_ONLY', 403, '请在主人电脑上打开管理端');
  }
}

export function requireHost(request: FastifyRequest, deps: HostAuthDeps): HostSession {
  requireLocal(request, deps.config);
  const session = readHostSession(request, deps);
  if (!session) throw new AppError('HOST_UNAUTHORIZED', 401, '请先登录');
  return session;
}

/**
 * Double-submit protection: the `X-WTM-CSRF` header must match the HMAC derived
 * from the session id, and a present `Origin` must be same-origin (dev proxy and
 * explicit CORS allowlist excepted).
 */
export function requireCsrf(
  request: FastifyRequest,
  session: HostSession,
  deps: HostAuthDeps,
): void {
  const header = request.headers['x-wtm-csrf'];
  if (typeof header !== 'string' || header !== session.csrfToken) {
    throw new AppError('CSRF_INVALID', 403, '请求校验失败，请刷新页面后重试');
  }

  const origin = request.headers.origin;
  if (!origin) return;

  const sameOrigin = origin === `http://${request.host}`;
  const allowlisted = deps.config.server.corsAllowlist.includes(origin);
  const devProxy =
    process.env.NODE_ENV !== 'production' &&
    (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173');

  if (!sameOrigin && !allowlisted && !devProxy) {
    throw new AppError('CSRF_INVALID', 403, '请求来源不合法');
  }
}

export function sessionCookie(token: string): string {
  return [
    `${HOST_COOKIE}=${encodeURIComponent(token)}`,
    `Max-Age=${HOST_SESSION_TTL_SEC}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ].join('; ');
}

export function clearSessionCookie(): string {
  return `${HOST_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`;
}
