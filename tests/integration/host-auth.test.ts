import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { loadConfig } from '../../src/server/config';
import { openDatabase, type Db } from '../../src/server/db';
import { migrate } from '../../src/server/db/migrate';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface TestContext {
  app: FastifyInstance;
  db: Db;
  dir: string;
}

const contexts: TestContext[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

async function makeApp(): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-host-'));
  const dbPath = join(dir, 'home.db');
  const db = openDatabase(dbPath);
  migrate(db, { dbPath, backupDir: join(dir, 'backups') });

  const config = loadConfig({ rootDir: repoRoot, env: {} });
  const app = await buildApp({ config, db, secret: randomBytes(32), logger: false });

  const context = { app, db, dir };
  contexts.push(context);
  return context;
}

interface SetupResult {
  cookie: string;
  csrf: string;
  room: { room_id: string; room_code: string; status: string };
}

function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('missing set-cookie header');
  return value.split(';')[0]!;
}

async function setup(app: FastifyInstance): Promise<SetupResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/host/setup',
    payload: { pin: '1234' },
    headers: { 'content-type': 'application/json' },
  });
  expect(response.statusCode).toBe(200);

  const body = response.json<{ room: SetupResult['room']; csrfToken: string }>();
  return { cookie: cookieOf(response), csrf: body.csrfToken, room: body.room };
}

describe('host onboarding', () => {
  it('reports an uninitialized state before setup', async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: 'GET', url: '/api/host/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ initialized: false, authenticated: false, room: null });
  });

  it('creates the room, sets the PIN and refuses a second setup', async () => {
    const { app } = await makeApp();
    const result = await setup(app);

    expect(result.room.room_code).toMatch(/^\d{6}$/);
    expect(result.room.status).toBe('draft');

    const status = await app.inject({
      method: 'GET',
      url: '/api/host/status',
      headers: { cookie: result.cookie },
    });
    expect(status.json()).toMatchObject({ initialized: true, authenticated: true });

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/host/setup',
      payload: { pin: '5678' },
      headers: { 'content-type': 'application/json' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: { code: string } }>().error.code).toBe('ALREADY_INITIALIZED');
  });

  it('logs in with the PIN and throttles repeated failures', async () => {
    const first = await makeApp();
    await setup(first.app);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await first.app.inject({
        method: 'POST',
        url: '/api/host/login',
        payload: { pin: '0000' },
        headers: { 'content-type': 'application/json' },
      });
      expect(response.statusCode).toBe(401);
    }

    const blocked = await first.app.inject({
      method: 'POST',
      url: '/api/host/login',
      payload: { pin: '1234' },
      headers: { 'content-type': 'application/json' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');

    const second = await makeApp();
    await setup(second.app);
    const ok = await second.app.inject({
      method: 'POST',
      url: '/api/host/login',
      payload: { pin: '1234' },
      headers: { 'content-type': 'application/json' },
    });
    expect(ok.statusCode).toBe(200);
    expect(cookieOf(ok)).toContain('wtm_host=');
  });
});

describe('host session and room status', () => {
  it('requires a session and CSRF for mutations, and enforces transitions', async () => {
    const { app } = await makeApp();
    const { cookie, csrf, room } = await setup(app);

    const anonymous = await app.inject({ method: 'GET', url: `/api/room/${room.room_id}` });
    expect(anonymous.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: `/api/room/${room.room_id}`,
      headers: { cookie },
    });
    expect(authorized.statusCode).toBe(200);

    const noCsrf = await app.inject({
      method: 'PATCH',
      url: `/api/room/${room.room_id}/status`,
      payload: { status: 'live' },
      headers: { cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json<{ error: { code: string } }>().error.code).toBe('CSRF_INVALID');

    const live = await app.inject({
      method: 'PATCH',
      url: `/api/room/${room.room_id}/status`,
      payload: { status: 'live' },
      headers: { cookie, 'x-wtm-csrf': csrf },
    });
    expect(live.statusCode).toBe(200);
    expect(live.json<{ room: { status: string } }>().room.status).toBe('live');

    const backwards = await app.inject({
      method: 'PATCH',
      url: `/api/room/${room.room_id}/status`,
      payload: { status: 'draft' },
      headers: { cookie, 'x-wtm-csrf': csrf },
    });
    expect(backwards.statusCode).toBe(409);
    expect(backwards.json<{ error: { code: string } }>().error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects a cross-origin mutation even with a valid CSRF token', async () => {
    const { app } = await makeApp();
    const { cookie, csrf, room } = await setup(app);

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/room/${room.room_id}/status`,
      payload: { status: 'live' },
      headers: { cookie, 'x-wtm-csrf': csrf, origin: 'http://evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('CSRF_INVALID');
  });

  it('invalidates old sessions when the PIN changes', async () => {
    const { app } = await makeApp();
    const { cookie, csrf } = await setup(app);

    const before = await app.inject({
      method: 'GET',
      url: '/api/host/me',
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/host/pin',
      payload: { currentPin: '1234', newPin: '5678' },
      headers: { cookie, 'x-wtm-csrf': csrf },
    });
    expect(changed.statusCode).toBe(200);
    const newCookie = cookieOf(changed);

    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/host/me',
      headers: { cookie },
    });
    expect(oldSession.statusCode).toBe(401);

    const newSession = await app.inject({
      method: 'GET',
      url: '/api/host/me',
      headers: { cookie: newCookie },
    });
    expect(newSession.statusCode).toBe(200);
  });

  it('blocks non-loopback requests unless LAN admin is enabled', async () => {
    const { app } = await makeApp();

    const response = await app.inject({
      method: 'GET',
      url: '/api/host/status',
      remoteAddress: '192.168.1.9',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('HOST_LOCAL_ONLY');
  });
});
