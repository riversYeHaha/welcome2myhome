import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCookies, serializeCookie } from '../../src/server/lib/cookies';
import {
  hashSecret,
  loadOrCreateSecret,
  pinVersion,
  signToken,
  verifySecret,
  verifyToken,
} from '../../src/server/lib/crypto';

const params = { N: 16384, r: 8, p: 1 };
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-crypto-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('pin hashing', () => {
  it('verifies the correct PIN and rejects everything else', () => {
    const hash = hashSecret('1234', params);
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifySecret('1234', hash)).toBe(true);
    expect(verifySecret('4321', hash)).toBe(false);
    expect(verifySecret('1234', 'not-a-hash')).toBe(false);
    expect(verifySecret('1234', 'scrypt$1$2$3$$')).toBe(false);
  });

  it('rotates the session version when the PIN changes', () => {
    const first = hashSecret('1234', params);
    const second = hashSecret('5678', params);
    expect(pinVersion(first)).not.toBe(pinVersion(second));
    expect(pinVersion(first)).toBe(pinVersion(first));
  });
});

describe('signed tokens', () => {
  it('round-trips a payload and rejects tampering', () => {
    const secret = Buffer.alloc(32, 7);
    const payload = { v: 1, sid: 'abc', exp: 4_102_444_800 };
    const token = signToken(payload, secret);

    expect(verifyToken<typeof payload>(token, secret)).toEqual(payload);

    const tampered = `${token.slice(0, -2)}xx`;
    expect(verifyToken(tampered, secret)).toBeNull();
    expect(verifyToken(token, Buffer.alloc(32, 8))).toBeNull();
    expect(verifyToken('garbage', secret)).toBeNull();
  });
});

describe('secret file', () => {
  it('creates a 0600 secret on first boot and reuses it', () => {
    const dir = makeTempDir();
    const path = join(dir, 'secret.key');

    const first = loadOrCreateSecret(path);
    expect(first).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const second = loadOrCreateSecret(path);
    expect(second.equals(first)).toBe(true);
  });
});

describe('cookies', () => {
  it('parses and serializes cookie headers', () => {
    const parsed = parseCookies('wtm_host=abc.def; theme=dark; empty=');
    expect(parsed).toEqual({ wtm_host: 'abc.def', theme: 'dark', empty: '' });

    const serialized = serializeCookie('wtm_host', 'abc.def', {
      maxAgeSec: 60,
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(serialized).toBe('wtm_host=abc.def; Max-Age=60; Path=/; HttpOnly; SameSite=Strict');
  });
});
