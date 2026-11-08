import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** `scrypt$N$r$p$salt$hash` — self-describing so params can evolve. */
export function hashSecret(value: string, params: ScryptParams): string {
  const salt = randomBytes(16);
  const hash = scryptSync(value, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export function verifySecret(value: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'base64');
    expected = Buffer.from(parts[5]!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = scryptSync(value, salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Short, non-reversible version of the PIN hash; changing the PIN rotates it. */
export function pinVersion(pinHash: string): string {
  return createHash('sha256').update(pinHash).digest('base64url').slice(0, 16);
}

export function hmacToken(secret: Buffer, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** `<base64url(json)>.<base64url(hmac)>` — compact signed payload. */
export function signToken(payload: object, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = hmacToken(secret, body);
  return `${body}.${signature}`;
}

export function verifyToken<T>(token: string, secret: Buffer): T | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!body || !signature) return null;

  const expected = Buffer.from(hmacToken(secret, body), 'base64url');
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Read the 32-byte HMAC secret, creating it with mode 0600 on first boot.
 * The secret is never committed and never logged.
 */
export function loadOrCreateSecret(path: string): Buffer {
  if (existsSync(path)) {
    const secret = readFileSync(path);
    if (secret.length < 32) {
      throw new Error(`Secret file ${path} is too short; delete it and restart`);
    }
    return secret;
  }

  mkdirSync(dirname(path), { recursive: true });
  const secret = randomBytes(32);
  writeFileSync(path, secret, { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}
