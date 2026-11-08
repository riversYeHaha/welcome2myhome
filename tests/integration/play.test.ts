import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setRoomStatus } from '../../src/server/db/repos/rooms';
import { createDollWithCard } from '../../src/server/services/cards';
import { cookieOf, makeTestApp, setupHost, type TestApp } from '../helpers/test-app';

const contexts: TestApp[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

interface Boot {
  context: TestApp;
  roomCode: string;
  roomId: string;
  doll: ReturnType<typeof createDollWithCard>;
}

async function boot(): Promise<Boot> {
  const context = await makeTestApp();
  contexts.push(context);

  const setup = await setupHost(context.app);
  setRoomStatus(context.db, setup.room.room_id, 'live');

  const doll = createDollWithCard(context.db, {
    roomId: setup.room.room_id,
    name: '阿黄',
    tagline: '家里的第一位成员',
  });

  context.db
    .prepare(
      `UPDATE dolls SET
         base_story = ?, base_caption = ?,
         egg_enabled = 1, riddle_type = 'single_choice',
         question = ?, options_json = ?, hint = ?, wrong_text = ?,
         answer_hash = ?, synonyms_json = ?
       WHERE doll_id = ?`,
    )
    .run(
      '2015 年冬天在楼下纸箱里捡到的。',
      '它陪了我们十一年',
      '阿黄最怕的东西是什么？',
      JSON.stringify(['吹风机', '黄瓜', '打雷', '拖鞋']),
      '每逢下雨天它就会钻到沙发底下',
      '还差一点点',
      'TOP_SECRET_HASH',
      JSON.stringify(['雷声']),
      doll.doll_id,
    );

  return { context, roomCode: setup.room.room_code, roomId: setup.room.room_id, doll };
}

async function joinGuest(booted: Boot): Promise<{ cookie: string; token: string }> {
  const response = await booted.context.app.inject({
    method: 'POST',
    url: '/api/guests/join',
    payload: { room_code: booted.roomCode, nickname: '小林' },
    headers: { 'content-type': 'application/json' },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json<{ guest_token: string; doll_count: number }>();
  expect(body.doll_count).toBe(1);
  return { cookie: cookieOf(response), token: body.guest_token };
}

describe('guest join and E1 payload', () => {
  it('joins with a nickname and returns a strictly trimmed E1 payload', async () => {
    const booted = await boot();
    const guest = await joinGuest(booted);

    const response = await booted.context.app.inject({
      method: 'GET',
      url: `/api/play/d/${booted.doll.card_token}`,
      headers: { cookie: guest.cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      name: string;
      tagline: string;
      level: { egg_enabled: boolean; riddle: { question: string; options: string[] } | null };
      base: { story: string };
      progress: { state: string };
      ticket_ttl: number;
    }>();

    expect(body.name).toBe('阿黄');
    expect(body.tagline).toBe('家里的第一位成员');
    expect(body.level.egg_enabled).toBe(true);
    expect(body.level.riddle?.question).toBe('阿黄最怕的东西是什么？');
    expect(body.level.riddle?.options).toHaveLength(4);
    expect(body.base.story).toContain('2015');
    expect(body.progress.state).toBe('discovered');
    expect(body.ticket_ttl).toBe(60);

    const raw = response.body;
    expect(raw).not.toContain('TOP_SECRET_HASH');
    expect(raw).not.toContain('answer_hash');
    expect(raw).not.toContain('synonyms');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('hide_hint');
    expect(raw).not.toContain('card_token_backup');
  });

  it('requires a guest session and enforces room ownership', async () => {
    const booted = await boot();

    const anonymous = await booted.context.app.inject({
      method: 'GET',
      url: `/api/play/d/${booted.doll.card_token}`,
    });
    expect(anonymous.statusCode).toBe(401);

    const guest = await joinGuest(booted);

    const otherRoom = await booted.context.app.inject({
      method: 'POST',
      url: '/api/guests/join',
      payload: { room_code: '000000', nickname: '陌生人' },
      headers: { 'content-type': 'application/json' },
    });
    expect(otherRoom.statusCode).toBe(404);

    // A second room with its own doll must not be reachable with the first guest.
    booted.context.db
      .prepare(
        `INSERT INTO rooms (room_id, room_code, title, status, created_at, updated_at)
         VALUES ('r_other', '999999', '别人家', 'live', datetime('now'), datetime('now'))`,
      )
      .run();
    const otherDoll = createDollWithCard(booted.context.db, {
      roomId: 'r_other',
      name: '别人的阿黄',
    });

    const crossRoom = await booted.context.app.inject({
      method: 'GET',
      url: `/api/play/d/${otherDoll.card_token}`,
      headers: { cookie: guest.cookie },
    });
    expect(crossRoom.statusCode).toBe(403);
    expect(crossRoom.json<{ error: { code: string } }>().error.code).toBe('TOKEN_INVALID');
  });

  it('blocks scanning when the room is paused or ended', async () => {
    const booted = await boot();
    const guest = await joinGuest(booted);
    setRoomStatus(booted.context.db, booted.roomId, 'paused');

    const response = await booted.context.app.inject({
      method: 'GET',
      url: `/api/play/d/${booted.doll.card_token}`,
      headers: { cookie: guest.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('ROOM_NOT_LIVE');
  });
});

describe('discover', () => {
  it('is idempotent and reports collection progress', async () => {
    const booted = await boot();
    const guest = await joinGuest(booted);

    const first = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/discover',
      payload: { doll_id: booted.doll.doll_id },
      headers: { cookie: guest.cookie, 'content-type': 'application/json' },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      state: string;
      already: boolean;
      collection: { found: number; total: number };
      finale: { reached: boolean; remaining: number };
    }>();
    expect(firstBody.state).toBe('collected');
    expect(firstBody.already).toBe(false);
    expect(firstBody.collection).toEqual({ found: 1, total: 1 });
    expect(firstBody.finale).toEqual({ reached: true, remaining: 0 });

    const second = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/discover',
      payload: { doll_id: booted.doll.doll_id },
      headers: { cookie: guest.cookie, 'content-type': 'application/json' },
    });
    const secondBody = second.json<{ already: boolean; collection: { found: number } }>();
    expect(secondBody.already).toBe(true);
    expect(secondBody.collection.found).toBe(1);
  });
});

describe('SSR card page and no-JS flow', () => {
  it('redirects a guest without a session to the join page', async () => {
    const booted = await boot();

    const response = await booted.context.app.inject({
      method: 'GET',
      url: `/d/${booted.doll.card_token}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain(`/join?r=${booted.roomCode}`);
    expect(response.headers.location).toContain('next=');
  });

  it('renders content without secrets and collects through a plain form POST', async () => {
    const booted = await boot();
    const guest = await joinGuest(booted);

    const page = await booted.context.app.inject({
      method: 'GET',
      url: `/d/${booted.doll.card_token}`,
      headers: { cookie: guest.cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('阿黄');
    expect(page.body).toContain('2015');
    expect(page.body).toContain('收下 TA');
    expect(page.body).toContain('/effect.js');
    expect(page.body).not.toContain('TOP_SECRET_HASH');

    const collect = await booted.context.app.inject({
      method: 'POST',
      url: `/d/${booted.doll.card_token}/collect`,
      headers: { cookie: guest.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(collect.statusCode).toBe(303);
    expect(collect.headers.location).toBe(`/d/${booted.doll.card_token}`);

    const collected = await booted.context.app.inject({
      method: 'GET',
      url: `/d/${booted.doll.card_token}`,
      headers: { cookie: guest.cookie },
    });
    expect(collected.body).toContain('已收入收藏册');
  });

  it('join form creates a guest and honours the next path', async () => {
    const booted = await boot();

    const form = await booted.context.app.inject({
      method: 'GET',
      url: `/join?r=${booted.roomCode}&next=%2Fd%2F${booted.doll.card_token}`,
    });
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain('房间码');

    const submitted = await booted.context.app.inject({
      method: 'POST',
      url: '/join',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `room_code=${booted.roomCode}&nickname=%E5%B0%8F%E6%9E%97&next=%2Fd%2F${booted.doll.card_token}`,
    });
    expect(submitted.statusCode).toBe(303);
    expect(submitted.headers.location).toBe(`/d/${booted.doll.card_token}`);
    expect(cookieOf(submitted)).toContain('wtm_guest=');
  });
});

describe('ticket-protected base assets', () => {
  it('serves the base model only with a valid base ticket', async () => {
    const booted = await boot();
    const guest = await joinGuest(booted);

    booted.context.db
      .prepare('UPDATE dolls SET base_model_url = ? WHERE doll_id = ?')
      .run('/assets/models/placeholder.glb', booted.doll.doll_id);

    const e1 = await booted.context.app.inject({
      method: 'GET',
      url: `/api/play/d/${booted.doll.card_token}`,
      headers: { cookie: guest.cookie },
    });
    const modelUrl = e1.json<{ base: { model_url: string | null } }>().base.model_url;
    expect(modelUrl).toBeTruthy();

    const modelPath = join(booted.context.config.paths.models, `${booted.doll.doll_id}.glb`);
    mkdirSync(booted.context.config.paths.models, { recursive: true });
    writeFileSync(modelPath, 'GLB-DATA');

    const asset = await booted.context.app.inject({ method: 'GET', url: modelUrl! });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe('model/gltf-binary');
    expect(asset.body).toBe('GLB-DATA');

    const withoutTicket = await booted.context.app.inject({
      method: 'GET',
      url: `/api/assets/${booted.doll.doll_id}/base-model`,
    });
    expect(withoutTicket.statusCode).toBe(403);
    expect(withoutTicket.json<{ error: { code: string } }>().error.code).toBe('TICKET_INVALID');
  });
});
