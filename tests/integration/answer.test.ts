import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getProgress } from '../../src/server/db/repos/progress';
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
  dollId: string;
  cardToken: string;
  cookie: string;
  guestId: string;
}

async function boot(options?: {
  riddleType?: 'single_choice' | 'short_answer';
  eggEnabled?: boolean;
}): Promise<Booted> {
  const context = await makeTestApp();
  contexts.push(context);

  const setup = await setupHost(context.app);
  setRoomStatus(context.db, setup.room.room_id, 'live');

  const doll = createDollWithCard(context.db, {
    roomId: setup.room.room_id,
    name: '阿黄',
  });

  const answerHash = hashAnswer('打雷', context.config.judge.scrypt);
  context.db
    .prepare(
      `UPDATE dolls SET
         egg_enabled = ?, riddle_type = ?, question = ?, options_json = ?,
         hint = ?, wrong_text = ?, answer_hash = ?, synonyms_json = ?,
         max_attempts = 0, secret_story = ?, secret_whisper = ?,
         secret_effect = 'golden_gather', secret_star = 1
       WHERE doll_id = ?`,
    )
    .run(
      options?.eggEnabled === false ? 0 : 1,
      options?.riddleType ?? 'single_choice',
      '阿黄最怕的东西是什么？',
      JSON.stringify(['吹风机', '黄瓜', '打雷', '拖鞋']),
      '每逢下雨天它就会钻到沙发底下',
      '还差一点点，再想想那天……',
      answerHash,
      JSON.stringify(['雷声', '打雷']),
      '其实它最怕的不是雷，是我们出门时关门的那一下。',
      '谢谢你今晚找到我。',
      doll.doll_id,
    );

  const join = await context.app.inject({
    method: 'POST',
    url: '/api/guests/join',
    payload: { room_code: setup.room.room_code, nickname: '小林' },
    headers: { 'content-type': 'application/json' },
  });
  expect(join.statusCode).toBe(200);
  const guestId = join.json<{ guest_id: string }>().guest_id;
  const cookie = cookieOf(join);

  const discover = await context.app.inject({
    method: 'POST',
    url: '/api/play/discover',
    payload: { doll_id: doll.doll_id },
    headers: { cookie, 'content-type': 'application/json' },
  });
  expect(discover.statusCode).toBe(200);

  return { context, dollId: doll.doll_id, cardToken: doll.card_token, cookie, guestId };
}

async function startEgg(booted: Booted) {
  return booted.context.app.inject({
    method: 'POST',
    url: '/api/play/egg/start',
    payload: { doll_id: booted.dollId },
    headers: { cookie: booted.cookie, 'content-type': 'application/json' },
  });
}

describe('egg quiz', () => {
  it('walks collected → egg_answering → wrong → correct → egg_unlocked', async () => {
    const booted = await boot();

    const started = await startEgg(booted);
    expect(started.statusCode).toBe(200);
    expect(started.json<{ state: string }>().state).toBe('egg_answering');

    const wrong = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.dollId, choice_index: 0 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(wrong.statusCode).toBe(200);
    const wrongBody = wrong.json<{
      correct: boolean;
      wrong_text: string;
      hint: string;
      attempts: number;
      max_attempts: number;
      can_retry: boolean;
      can_skip: boolean;
    }>();
    expect(wrongBody.correct).toBe(false);
    expect(wrongBody.wrong_text).toContain('还差一点点');
    expect(wrongBody.hint).toContain('沙发');
    expect(wrongBody.attempts).toBe(1);
    expect(wrongBody.max_attempts).toBe(0);
    expect(wrongBody.can_retry).toBe(true);
    expect(wrongBody.can_skip).toBe(true);
    expect(wrong.body).not.toContain('locked');
    expect(wrong.body).not.toContain('cooldown');

    const correct = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.dollId, choice_index: 2 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(correct.statusCode).toBe(200);
    const correctBody = correct.json<{
      correct: boolean;
      secret_ticket: string;
      secret: { story: string; whisper: string; star: boolean };
      collection: { eggs: number };
    }>();
    expect(correctBody.correct).toBe(true);
    expect(correctBody.secret_ticket).toMatch(/^t1\./);
    expect(correctBody.secret.story).toContain('关门');
    expect(correctBody.secret.star).toBe(true);
    expect(correctBody.collection.eggs).toBe(1);

    const progress = getProgress(
      booted.context.db,
      (await booted.context.db.prepare('SELECT room_id FROM dolls WHERE doll_id = ?').get(booted.dollId) as { room_id: string }).room_id,
      booted.guestId,
      booted.dollId,
    );
    expect(progress?.state).toBe('egg_unlocked');

    // Re-answering is idempotent and does not consume another attempt.
    const again = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.dollId, choice_index: 2 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ correct: boolean }>().correct).toBe(true);
  });

  it('accepts a short answer through synonyms', async () => {
    const booted = await boot({ riddleType: 'short_answer' });
    await startEgg(booted);

    const response = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.dollId, answer_text: ' 雷 声 ' },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ correct: boolean }>().correct).toBe(true);
  });

  it('skips back to collected and keeps the card', async () => {
    const booted = await boot();
    await startEgg(booted);

    const skipped = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/egg/skip',
      payload: { doll_id: booted.dollId },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(skipped.statusCode).toBe(200);
    expect(skipped.json<{ state: string; egg_skipped: boolean }>()).toMatchObject({
      state: 'collected',
      egg_skipped: true,
    });
  });

  it('refuses the quiz when the host disabled it or the card is not collected', async () => {
    const disabled = await boot({ eggEnabled: false });
    const start = await startEgg(disabled);
    expect(start.statusCode).toBe(409);
    expect(start.json<{ error: { code: string } }>().error.code).toBe('EGG_DISABLED');

    const booted = await boot();
    const early = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.dollId, choice_index: 2 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    // The guest has collected in boot(); use a second doll that is still locked.
    const lockedDoll = createDollWithCard(booted.context.db, {
      roomId: (await booted.context.db.prepare('SELECT room_id FROM dolls WHERE doll_id = ?').get(booted.dollId) as { room_id: string }).room_id,
      name: '未发现的人偶',
    });
    const locked = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: lockedDoll.doll_id, choice_index: 2 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json<{ error: { code: string } }>().error.code).toBe('EGG_DISABLED');
    expect(early.statusCode).toBe(200);
  });

  it('rate-limits a scripted burst without locking the quiz', async () => {
    const booted = await boot();
    await startEgg(booted);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await booted.context.app.inject({
        method: 'POST',
        url: '/api/play/answer',
        payload: { doll_id: booted.dollId, choice_index: 0 },
        headers: { cookie: booted.cookie, 'content-type': 'application/json' },
      });
      expect(response.statusCode).toBe(200);
    }

    const blocked = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.dollId, choice_index: 0 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
  });

  it('serves the secret model only with a secret-scope ticket', async () => {
    const booted = await boot();
    booted.context.db
      .prepare('UPDATE dolls SET base_model_url = ?, secret_model_url = ? WHERE doll_id = ?')
      .run('/assets/models/base.glb', '/assets/models/secret.glb', booted.dollId);

    const e1 = await booted.context.app.inject({
      method: 'GET',
      url: `/api/play/d/${booted.cardToken}`,
      headers: { cookie: booted.cookie },
    });
    const baseTicketUrl = e1.json<{ base: { model_url: string | null } }>().base.model_url;
    const baseTicket = new URL(baseTicketUrl!, 'http://localhost').searchParams.get('t')!;

    await startEgg(booted);
    const correct = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.dollId, choice_index: 2 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    const secretModelUrl = correct.json<{ secret: { model_url: string | null } }>().secret
      .model_url!;

    mkdirSync(booted.context.config.paths.models, { recursive: true });
    writeFileSync(
      join(booted.context.config.paths.models, `${booted.dollId}_alt.glb`),
      'SECRET-GLB',
    );

    const allowed = await booted.context.app.inject({ method: 'GET', url: secretModelUrl });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).toBe('SECRET-GLB');

    const baseOnSecret = await booted.context.app.inject({
      method: 'GET',
      url: `/api/assets/${booted.dollId}/secret-model?t=${encodeURIComponent(baseTicket)}`,
    });
    expect(baseOnSecret.statusCode).toBe(403);
    expect(baseOnSecret.json<{ error: { code: string } }>().error.code).toBe(
      'TICKET_SCOPE_MISMATCH',
    );
  });
});

describe('secret content and E2 entry', () => {
  it('locks the secret endpoint until the egg is unlocked', async () => {
    const booted = await boot();

    const locked = await booted.context.app.inject({
      method: 'GET',
      url: `/api/play/secret/${booted.dollId}`,
      headers: { cookie: booted.cookie },
    });
    expect(locked.statusCode).toBe(403);
    expect(locked.json<{ error: { code: string } }>().error.code).toBe('EGG_LOCKED');

    await startEgg(booted);
    const answer = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.dollId, choice_index: 2 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });
    expect(answer.statusCode).toBe(200);

    const unlocked = await booted.context.app.inject({
      method: 'GET',
      url: `/api/play/secret/${booted.dollId}`,
      headers: { cookie: booted.cookie },
    });
    expect(unlocked.statusCode).toBe(200);
    const body = unlocked.json<{
      secret_ticket: string;
      secret: { story: string; whisper: string; star: boolean };
    }>();
    expect(body.secret_ticket).toMatch(/^t1\./);
    expect(body.secret.story).toContain('关门');
    expect(body.secret.whisper).toContain('谢谢你');
    expect(body.secret.star).toBe(true);
  });

  it('renders a quiz entry but never the secret story in the card HTML', async () => {
    const booted = await boot();

    const before = await booted.context.app.inject({
      method: 'GET',
      url: `/d/${booted.cardToken}`,
      headers: { cookie: booted.cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(before.body).toContain('data-mode="quiz"');
    expect(before.body).toContain('再听听 TA 的故事');
    expect(before.body).not.toContain('其实它最怕的不是雷');

    await startEgg(booted);
    await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.dollId, choice_index: 2 },
      headers: { cookie: booted.cookie, 'content-type': 'application/json' },
    });

    const after = await booted.context.app.inject({
      method: 'GET',
      url: `/d/${booted.cardToken}`,
      headers: { cookie: booted.cookie },
    });
    expect(after.body).toContain('data-mode="secret"');
    expect(after.body).toContain('看 TA 的秘密');
    expect(after.body).not.toContain('其实它最怕的不是雷');
  });
});
