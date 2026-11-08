import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/server/lib/errors';
import { signTicket, verifyTicket } from '../../src/server/services/ticket';

const secret = Buffer.alloc(32, 3);

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

describe('two-level tickets', () => {
  it('signs and verifies a base ticket', () => {
    const ticket = signTicket(secret, {
      scope: 'base',
      dollId: 'd_001',
      guestId: 'g_001',
      ttlSec: 60,
    });

    const payload = verifyTicket(secret, ticket, {
      scope: 'base',
      dollId: 'd_001',
      guestId: 'g_001',
    });
    expect(payload.d).toBe('d_001');
    expect(payload.s).toBe('base');
  });

  it('rejects scope, doll, guest, expiry and tampering', () => {
    const ticket = signTicket(secret, {
      scope: 'base',
      dollId: 'd_001',
      guestId: 'g_001',
      ttlSec: 60,
    });

    expectCode(
      () => verifyTicket(secret, ticket, { scope: 'secret', dollId: 'd_001' }),
      'TICKET_SCOPE_MISMATCH',
    );
    expectCode(
      () => verifyTicket(secret, ticket, { scope: 'base', dollId: 'd_002' }),
      'TICKET_INVALID',
    );
    expectCode(
      () => verifyTicket(secret, ticket, {
        scope: 'base',
        dollId: 'd_001',
        guestId: 'g_002',
      }),
      'TICKET_INVALID',
    );
    expectCode(
      () => verifyTicket(secret, `${ticket.slice(0, -2)}xx`, { scope: 'base', dollId: 'd_001' }),
      'TICKET_INVALID',
    );
    expectCode(() => verifyTicket(secret, 'nope', { scope: 'base', dollId: 'd_001' }), 'TICKET_INVALID');

    const expired = signTicket(secret, {
      scope: 'base',
      dollId: 'd_001',
      guestId: 'g_001',
      ttlSec: -1,
    });
    expectCode(
      () => verifyTicket(secret, expired, { scope: 'base', dollId: 'd_001' }),
      'TICKET_EXPIRED',
    );
  });
});
