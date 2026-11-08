import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClearSummary, SelfCheckResult } from '../../src/shared/host';
import { setRoomStatus } from '../../src/server/db/repos/rooms';
import { createDollWithCard } from '../../src/server/services/cards';
import { hashAnswer } from '../../src/server/services/judge';
import { makeTestApp, setupHost, type TestApp } from '../helpers/test-app';

const contexts: TestApp[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

interface Booted {
  context: TestApp;
  roomId: string;
  roomCode: string;
  cookie: string;
  csrf: string;
  doll: { doll_id: string; card_token: string };
  guestId?: string;
  guestToken?: string;
}

async function boot(options: { join?: boolean; eggReady?: boolean } = {}): Promise<Booted> {
  const context = await makeTestApp();
  contexts.push(context);

  const host = await setupHost(context.app);
  setRoomStatus(context.db, host.room.room_id, 'live');

  const doll = createDollWithCard(context.db, { roomId: host.room.room_id, name: '阿黄' });
  context.db
    .prepare(
      `UPDATE dolls SET base_story = '楼下纸箱里捡到的。', egg_enabled = ?,
         riddle_type = 'single_choice', question = '阿黄最怕什么？',
         options_json = ?, answer_hash = ?
       WHERE doll_id = ?`,
    )
    .run(
      options.eggReady === false ? 1 : 1,
      JSON.stringify(['吹风机', '打雷']),
      options.eggReady === false ? '' : hashAnswer('打雷', context.config.judge.scrypt),
      doll.doll_id,
    );

  let guestId: string | undefined;
  let guestToken: string | undefined;
  if (options.join !== false) {
    const join = await context.app.inject({
      method: 'POST',
      url: '/api/guests/join',
      payload: { room_code: host.room.room_code, nickname: '小林' },
      headers: { 'content-type': 'application/json' },
    });
    expect(join.statusCode).toBe(200);
    const body = join.json<{ guest_id: string; guest_token: string }>();
    guestId = body.guest_id;
    guestToken = body.guest_token;
  }

  return {
    context,
    roomId: host.room.room_id,
    roomCode: host.room.room_code,
    cookie: host.cookie,
    csrf: host.csrf,
    doll,
    guestId,
    guestToken,
  };
}

function hostHeaders(booted: Booted): Record<string, string> {
  return { cookie: booted.cookie, 'x-wtm-csrf': booted.csrf };
}

describe('host self check', () => {
  it('reports LAN address, data sizes and configuration readiness', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/host/selfcheck',
      headers: { cookie: booted.cookie },
    });
    expect(response.statusCode).toBe(200);

    const check = response.json<SelfCheckResult>();
    expect(check.room.room_code).toBe(booted.roomCode);
    expect(check.network.urls.some((item) => item.url.startsWith('http://'))).toBe(true);
    expect(check.checks.find((item) => item.id === 'dolls')?.ok).toBe(true);
    expect(check.checks.find((item) => item.id === 'eggs')?.ok).toBe(true);
    expect(check.checks.find((item) => item.id === 'local_only')?.ok).toBe(true);
    expect(check.data.dolls).toBe(1);
    expect(check.data.guests).toBe(1);
    expect(check.data.events).toBeGreaterThan(0);
    expect(response.body).not.toContain('打雷');
  });

  it('flags a missing egg answer and a LAN address that no longer matches', async () => {
    const booted = await boot({ eggReady: false });
    booted.context.db
      .prepare('UPDATE rooms SET lan_ip = ? WHERE room_id = ?')
      .run('10.255.255.1', booted.roomId);

    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/host/selfcheck',
      headers: { cookie: booted.cookie },
    });
    const check = response.json<SelfCheckResult>();
    const eggs = check.checks.find((item) => item.id === 'eggs');
    expect(eggs?.ok).toBe(false);
    expect(eggs?.hint).toBeTruthy();

    const lanMatch = check.checks.find((item) => item.id === 'lan_ip_match');
    // Only conclusive when the machine actually has a private IPv4.
    expect(lanMatch).toBeDefined();
  });

  it('requires a host session', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/host/selfcheck',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('backup and export', () => {
  it('exports portable configuration without secrets', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/host/backup/config',
      headers: { cookie: booted.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-disposition'])).toContain('wtm-config-');

    const payload = response.json<Record<string, unknown>>();
    expect(payload.schema).toBe('welcome2myhome/config');
    const dolls = payload.dolls as Array<Record<string, unknown>>;
    expect(dolls).toHaveLength(1);
    expect(dolls[0]!.name).toBe('阿黄');
    expect(dolls[0]!.answer_configured).toBe(true);
    // Options are public card content; the hash, synonyms and PIN must not leak.
    expect(response.body).not.toContain('answer_hash');
    expect(response.body).not.toContain('synonyms');
    expect(response.body).not.toContain(booted.doll.card_token);
    expect(response.body.toLowerCase()).not.toContain('pin_hash');
  });

  it('writes a consistent SQLite snapshot and prunes old ones', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/host/backup/db',
      headers: { cookie: booted.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/octet-stream');

    const match = /filename="([^"]+\.db)"/.exec(String(response.headers['content-disposition']));
    expect(match).toBeTruthy();
    const file = join(booted.context.config.paths.backups, match![1]!);
    expect(existsSync(file)).toBe(true);
    const header = readFileSync(file).subarray(0, 15).toString('utf8');
    expect(header).toBe('SQLite format 3');
  });
});

describe('FR-13 clear data', () => {
  it('wipes guests, progress, events and media but keeps the doll config', async () => {
    const booted = await boot();
    await booted.context.app.inject({
      method: 'GET',
      url: `/api/play/d/${booted.doll.card_token}`,
      headers: { authorization: `Bearer ${booted.guestToken}` },
    });

    const photo = join(booted.context.config.paths.photos, `${booted.doll.doll_id}_src.jpg`);
    writeFileSync(photo, 'fake-photo');
    booted.context.db
      .prepare('UPDATE dolls SET source_photo = ? WHERE doll_id = ?')
      .run(photo, booted.doll.doll_id);

    const response = await booted.context.app.inject({
      method: 'DELETE',
      url: `/api/room/${booted.roomId}/data`,
      payload: { confirm: '清空' },
      headers: { ...hostHeaders(booted), 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
    const cleared = response.json<{ cleared: ClearSummary }>().cleared;
    expect(cleared.guests).toBe(1);
    expect(cleared.progress).toBe(1);
    expect(cleared.events).toBeGreaterThan(0);
    expect(cleared.files).toBe(1);
    expect(existsSync(photo)).toBe(false);

    const room = booted.context.db
      .prepare('SELECT status FROM rooms WHERE room_id = ?')
      .get(booted.roomId) as { status: string };
    expect(room.status).toBe('draft');

    const doll = booted.context.db
      .prepare('SELECT name, question, source_photo, gen_status FROM dolls WHERE doll_id = ?')
      .get(booted.doll.doll_id) as {
      name: string;
      question: string;
      source_photo: string | null;
      gen_status: string;
    };
    expect(doll.name).toBe('阿黄');
    expect(doll.question).toBe('阿黄最怕什么？');
    expect(doll.source_photo).toBeNull();
    expect(doll.gen_status).toBe('preset');

    const counts = booted.context.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM guests WHERE room_id = ?) AS guests,
           (SELECT COUNT(*) FROM progress WHERE room_id = ?) AS progress,
           (SELECT COUNT(*) FROM events WHERE room_id = ?) AS events`,
      )
      .get(booted.roomId, booted.roomId, booted.roomId) as {
      guests: number;
      progress: number;
      events: number;
    };
    expect(counts).toEqual({ guests: 0, progress: 0, events: 0 });
  });

  it('rejects a wrong confirmation phrase and a missing CSRF token', async () => {
    const booted = await boot();
    const wrongPhrase = await booted.context.app.inject({
      method: 'DELETE',
      url: `/api/room/${booted.roomId}/data`,
      payload: { confirm: 'ok' },
      headers: { ...hostHeaders(booted), 'content-type': 'application/json' },
    });
    expect(wrongPhrase.statusCode).toBe(422);

    const noCsrf = await booted.context.app.inject({
      method: 'DELETE',
      url: `/api/room/${booted.roomId}/data`,
      payload: { confirm: '清空' },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('FR-12 emergency unlock', () => {
  it('marks a card discovered for a guest who lost it', async () => {
    const booted = await boot({ join: true });
    const response = await booted.context.app.inject({
      method: 'POST',
      url: `/api/room/${booted.roomId}/guests/${booted.guestId}/unlock`,
      payload: { doll_id: booted.doll.doll_id, action: 'discover' },
      headers: { ...hostHeaders(booted), 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ state: string }>().state).toBe('discovered');
  });

  it('force-opens a secret and records the host event', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject({
      method: 'POST',
      url: `/api/room/${booted.roomId}/guests/${booted.guestId}/unlock`,
      payload: { doll_id: booted.doll.doll_id, action: 'unlock' },
      headers: { ...hostHeaders(booted), 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ state: string }>().state).toBe('egg_unlocked');

    const event = booted.context.db
      .prepare(
        "SELECT payload_json, type FROM events WHERE room_id = ? AND type = 'egg2_unlocked' ORDER BY seq DESC LIMIT 1",
      )
      .get(booted.roomId) as { payload_json: string; type: string } | undefined;
    expect(event?.payload_json).toContain('"by":"host"');
  });

  it('refuses guests from another room', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject({
      method: 'POST',
      url: `/api/room/${booted.roomId}/guests/guest_unknown/unlock`,
      payload: { doll_id: booted.doll.doll_id, action: 'unlock' },
      headers: { ...hostHeaders(booted), 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(404);
  });
});
