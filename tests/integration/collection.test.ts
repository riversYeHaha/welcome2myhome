import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { GuestCollection } from '../../src/shared/guest';
import { setRoomStatus } from '../../src/server/db/repos/rooms';
import { createDollWithCard } from '../../src/server/services/cards';
import { hashAnswer } from '../../src/server/services/judge';
import { cookieOf, makeTestApp, setupHost, type TestApp } from '../helpers/test-app';

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
  first: { doll_id: string; card_token: string };
  second: { doll_id: string; card_token: string };
  cookie: string;
  guestId: string;
}

async function boot(): Promise<Booted> {
  const context = await makeTestApp();
  contexts.push(context);

  const host = await setupHost(context.app);
  setRoomStatus(context.db, host.room.room_id, 'live');

  const first = createDollWithCard(context.db, {
    roomId: host.room.room_id,
    name: '阿黄',
    tagline: '家里的第一位成员',
  });
  const second = createDollWithCard(context.db, {
    roomId: host.room.room_id,
    name: '阿花',
  });

  const answerHash = hashAnswer('打雷', context.config.judge.scrypt);
  context.db
    .prepare(
      `UPDATE dolls SET
         base_story = '2015 年冬天在楼下纸箱里捡到的。',
         base_caption = '它陪了我们十一年',
         base_model_url = '/assets/models/placeholder.glb',
         egg_enabled = 1, riddle_type = 'single_choice',
         question = '阿黄最怕什么？',
         options_json = ?,
         answer_hash = ?, synonyms_json = '[]',
         hint = '下雨天它会躲起来',
         wrong_text = '还差一点点',
         secret_story = '其实它怕关门声。',
         secret_whisper = '谢谢你找到我。',
         secret_model_url = '/assets/models/secret.glb',
         secret_star = 1
       WHERE doll_id = ?`,
    )
    .run(JSON.stringify(['吹风机', '打雷', '黄瓜']), answerHash, first.doll_id);

  const join = await context.app.inject({
    method: 'POST',
    url: '/api/guests/join',
    payload: { room_code: host.room.room_code, nickname: '小林' },
    headers: { 'content-type': 'application/json' },
  });
  expect(join.statusCode).toBe(200);

  return {
    context,
    roomId: host.room.room_id,
    roomCode: host.room.room_code,
    first,
    second,
    cookie: cookieOf(join),
    guestId: join.json<{ guest_id: string }>().guest_id,
  };
}

async function discover(booted: Booted, dollId: string): Promise<void> {
  const response = await booted.context.app.inject({
    method: 'POST',
    url: '/api/play/discover',
    payload: { doll_id: dollId },
    headers: { cookie: booted.cookie, 'content-type': 'application/json' },
  });
  expect(response.statusCode).toBe(200);
}

describe('collection API', () => {
  it('hides locked names and returns fresh asset URLs for collected dolls', async () => {
    const booted = await boot();
    await discover(booted, booted.first.doll_id);

    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/collection',
      headers: { cookie: booted.cookie },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<GuestCollection>();
    expect(body.summary).toEqual({ found: 1, total: 2, eggs: 0 });
    expect(body.finale.reached).toBe(false);
    expect(body.finale.remaining).toBe(1);

    const first = body.items.find((item) => item.doll_id === booted.first.doll_id)!;
    expect(first.name).toBe('阿黄');
    expect(first.story).toContain('2015');
    expect(first.egg).toBe('locked');
    expect(first.star).toBe(false);
    expect(first.model_url).toMatch(/\/api\/assets\/.+\/base-model\?t=t1\./);

    const second = body.items.find((item) => item.doll_id === booted.second.doll_id)!;
    expect(second.name).toBeNull();
    expect(second.story).toBeNull();
    expect(second.state).toBe('locked');
  });

  it('marks the egg and star after a correct answer, then reaches the finale', async () => {
    const booted = await boot();
    await discover(booted, booted.first.doll_id);

    const start = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/egg/start',
      payload: { doll_id: booted.first.doll_id },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(start.statusCode).toBe(200);

    const answer = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.first.doll_id, choice_index: 1 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json<{ correct: boolean }>().correct).toBe(true);

    const afterEgg = await booted.context.app.inject({
      method: 'GET',
      url: '/api/collection',
      headers: { cookie: booted.cookie },
    });
    const eggBody = afterEgg.json<GuestCollection>();
    expect(eggBody.summary.eggs).toBe(1);
    const first = eggBody.items.find((item) => item.doll_id === booted.first.doll_id)!;
    expect(first.egg).toBe('unlocked');
    expect(first.star).toBe(true);
    expect(first.secret_model_url).toMatch(/secret-model\?t=t1\./);

    await discover(booted, booted.second.doll_id);
    const complete = await booted.context.app.inject({
      method: 'GET',
      url: '/api/collection',
      headers: { cookie: booted.cookie },
    });
    const completeBody = complete.json<GuestCollection>();
    expect(completeBody.finale.reached).toBe(true);
    expect(completeBody.finale.content?.title).toContain('全家');
    expect(completeBody.summary.found).toBe(2);
  });
});

describe('collection and finale pages', () => {
  it('redirects to join without a guest session', async () => {
    const booted = await boot();

    const collection = await booted.context.app.inject({
      method: 'GET',
      url: '/collection',
    });
    expect(collection.statusCode).toBe(302);
    expect(collection.headers.location).toContain(`/join?r=${booted.roomCode}`);
    expect(collection.headers.location).toContain('%2Fcollection');

    const finale = await booted.context.app.inject({ method: 'GET', url: '/finale' });
    expect(finale.statusCode).toBe(302);
  });

  it('renders the collection wall and finale progress/content', async () => {
    const booted = await boot();
    await discover(booted, booted.first.doll_id);

    const collection = await booted.context.app.inject({
      method: 'GET',
      url: '/collection',
      headers: { cookie: booted.cookie },
    });
    expect(collection.statusCode).toBe(200);
    expect(collection.headers['content-type']).toContain('text/html');
    expect(collection.body).toContain('收藏册');
    expect(collection.body).toContain('阿黄');
    expect(collection.body).toContain('还没见到');
    expect(collection.body).toContain('/viewer.js');
    expect(collection.body).toContain('class="view-doll"');
    expect(collection.body).not.toContain('answer_hash');

    const before = await booted.context.app.inject({
      method: 'GET',
      url: '/finale',
      headers: { cookie: booted.cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.body).toContain('还差 1 位');

    await discover(booted, booted.second.doll_id);
    const after = await booted.context.app.inject({
      method: 'GET',
      url: '/finale',
      headers: { cookie: booted.cookie },
    });
    expect(after.body).toContain('你今晚见到了我们全家');
  });
});
