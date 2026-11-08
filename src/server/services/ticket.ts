import { signToken, verifyToken } from '../lib/crypto';
import { AppError } from '../lib/errors';
import { randomBase62 } from '../lib/ids';

export type TicketScope = 'base' | 'secret';

interface TicketPayload {
  v: 1;
  s: TicketScope;
  d: string;
  g: string;
  e: number;
  n: string;
}

export interface TicketExpectation {
  scope: TicketScope;
  dollId: string;
  guestId?: string;
}

export function signTicket(
  secret: Buffer,
  options: {
    scope: TicketScope;
    dollId: string;
    guestId: string;
    ttlSec: number;
  },
): string {
  const payload: TicketPayload = {
    v: 1,
    s: options.scope,
    d: options.dollId,
    g: options.guestId,
    e: Math.floor(Date.now() / 1000) + options.ttlSec,
    n: randomBase62(8),
  };
  return `t1.${signToken(payload, secret)}`;
}

/**
 * Verify signature, expiry, scope, doll binding (and guest binding when given).
 * Errors map to the 403 codes documented in tech design §9.4.
 */
export function verifyTicket(
  secret: Buffer,
  token: string,
  expected: TicketExpectation,
): TicketPayload {
  if (!token.startsWith('t1.')) {
    throw new AppError('TICKET_INVALID', 403, '资产凭证无效');
  }

  const payload = verifyToken<TicketPayload>(token.slice(3), secret);
  if (!payload || payload.v !== 1) {
    throw new AppError('TICKET_INVALID', 403, '资产凭证无效');
  }
  if (payload.e * 1000 <= Date.now()) {
    throw new AppError('TICKET_EXPIRED', 403, '资产凭证已过期，请刷新页面');
  }
  if (payload.s !== expected.scope) {
    throw new AppError('TICKET_SCOPE_MISMATCH', 403, '资产凭证权限不足');
  }
  if (payload.d !== expected.dollId) {
    throw new AppError('TICKET_INVALID', 403, '资产凭证与人偶不匹配');
  }
  if (expected.guestId && payload.g !== expected.guestId) {
    throw new AppError('TICKET_INVALID', 403, '资产凭证与客人不匹配');
  }

  return payload;
}
