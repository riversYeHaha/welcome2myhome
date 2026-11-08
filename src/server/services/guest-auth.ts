import type { FastifyRequest } from 'fastify';
import type { Db } from '../db';
import { getGuest, touchGuest } from '../db/repos/guests';
import { parseCookies } from '../lib/cookies';
import { signToken, verifyToken } from '../lib/crypto';
import { AppError } from '../lib/errors';

export const GUEST_COOKIE = 'wtm_guest';
export const GUEST_SESSION_TTL_SEC = 30 * 24 * 60 * 60;

interface GuestSessionPayload {
  v: 1;
  g: string;
  r: string;
  exp: number;
}

export interface GuestSession {
  guestId: string;
  roomId: string;
  exp: number;
}

export interface GuestAuthDeps {
  db: Db;
  secret: Buffer;
}

export function createGuestSession(
  secret: Buffer,
  guestId: string,
  roomId: string,
): { token: string; session: GuestSession } {
  const payload: GuestSessionPayload = {
    v: 1,
    g: guestId,
    r: roomId,
    exp: Math.floor(Date.now() / 1000) + GUEST_SESSION_TTL_SEC,
  };

  return {
    token: signToken(payload, secret),
    session: { guestId, roomId, exp: payload.exp },
  };
}

/** Bearer token from fetch, then the HttpOnly cookie used by SSR navigations. */
export function readGuestToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return token;
  }
  return parseCookies(request.headers.cookie)[GUEST_COOKIE] ?? null;
}

export function readGuestSession(
  request: FastifyRequest,
  deps: GuestAuthDeps,
): GuestSession | null {
  const token = readGuestToken(request);
  if (!token) return null;

  const payload = verifyToken<GuestSessionPayload>(token, deps.secret);
  if (!payload || payload.v !== 1) return null;
  if (payload.exp * 1000 <= Date.now()) return null;

  const guest = getGuest(deps.db, payload.g);
  if (!guest || guest.room_id !== payload.r) return null;

  return { guestId: guest.guest_id, roomId: guest.room_id, exp: payload.exp };
}

export function requireGuest(request: FastifyRequest, deps: GuestAuthDeps): GuestSession {
  const session = readGuestSession(request, deps);
  if (!session) throw new AppError('GUEST_UNAUTHORIZED', 401, '请先填写昵称');
  // Powers the host board's "online" column; cheap single-row update.
  touchGuest(deps.db, session.guestId);
  return session;
}

export function guestCookie(token: string): string {
  return [
    `${GUEST_COOKIE}=${encodeURIComponent(token)}`,
    `Max-Age=${GUEST_SESSION_TTL_SEC}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ].join('; ');
}

export function clearGuestCookie(): string {
  return `${GUEST_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}
