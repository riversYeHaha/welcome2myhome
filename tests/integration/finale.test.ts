import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FinaleConfig } from '../../src/shared/finale';
import { hashAnswer } from '../../src/server/services/judge';
import { createDollWithCard } from '../../src/server/services/cards';
import { setRoomStatus } from '../../src/server/db/repos/rooms';
import { cookieOf, makeTestApp, setupHost, type HostSetup, type TestApp } from '../helpers/test-app';

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
  host: HostSetup;
  dolls: Array<{ doll_id: string }>;
  cookie: string;
  guestId: string;
}

async function boot(): Promise<Booted> {
  const context = await makeTestApp();
  contexts.push(context);

  const host = await setupHost(context.app);
  setRoomStatus(context.db, host.room.room_id, 'live');

  const dolls = [
    createDollWithCard(context.db, { roomId: host.room.room_id, name: '阿黄' }),
    createDollWithCard(context.db, { roomId: host.room.room_id, name: '阿花' }),
  ];

  const join = await context.app.inject({
    method: 'POST',
    url: '/api/guests/join',
    payload: { room_code: host.room.room_code, nickname: '小林' },
    headers: { 'content-type': 'application/json' },
  });
  expect(join.statusCode).toBe(200);

  return {
    context,
    host,
    dolls,
    cookie: cookieOf(join),
    guestId: join.json<{ guest_id: string }>().guest_id,
  };
}

function finaleBody(overrides: Partial<FinaleConfig> = {}) {
  return {
    enabled: true,
    trigger: { type: 'all_collected', value: null },
    title: '你今晚见到了我们全家',
    body: '最后这一位，是一直在厨房忙的那个人。',
    image_url: null,
    model_url: null,
    reward_note: '拿着这一页去找主人，换一张贴纸',
    share_caption: '今晚我认识了 2 个人',
    ...overrides,
  };
}

async function patchFinale(booted: Booted, body: Record<string, unknown>, withCsrf = true) {
  return await booted.context.app.inject({
    method: 'PATCH',
    url: `/api/room/${booted.host.room.room_id}/finale`,
    payload: body,
    headers: {
      cookie: booted.host.cookie,
      ...(withCsrf ? { 'x-wtm-csrf': booted.host.csrf } : {}),
    },
  });
}

async function discover(booted: Booted, dollId: string) {
  return await booted.context.app.inject({
    method: 'POST',
    url: '/api/play/discover',
    payload: { doll_id: dollId },
    headers: { cookie: booted.cookie, 'content-type': 'application/json' },
  });
}

async function getFinale(booted: Booted) {
  return await booted.context.app.inject({
    method: 'GET',
    url: `/api/finale/${booted.host.room.room_id}`,
    headers: { cookie: booted.cookie },
  });
}

describe('finale configuration and delivery', () => {
  it('reaches all_collected and returns the host content', async () => {
    const booted = await boot();

    const patched = await patchFinale(booted, finaleBody());
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ finale: { trigger: { type: string } } }>().finale.trigger.type).toBe(
      'all_collected',
    );

    const before = await getFinale(booted);
    expect(before.statusCode).toBe(200);
    expect(before.json<{ reached: boolean }>().reached).toBe(false);
    expect(before.json<{ progress: { total: number; remaining: number } }>().progress).toMatchObject(
      { total: 2, remaining: 2 },
    );

    const first = await discover(booted, booted.dolls[0]!.doll_id);
    expect(first.json<{ finale: { reached: boolean; remaining: number } }>().finale).toEqual({
      reached: false,
      remaining: 1,
    });

    const second = await discover(booted, booted.dolls[1]!.doll_id);
    expect(second.json<{ finale: { reached: boolean; remaining: number } }>().finale).toEqual({
      reached: true,
      remaining: 0,
    });

    const reached = await getFinale(booted);
    expect(reached.statusCode).toBe(200);
    const body = reached.json<{
      reached: boolean;
      content: { title: string; reward_note: string };
    }>();
    expect(body.reached).toBe(true);
    expect(body.content.title).toContain('全家');
    expect(body.content.reward_note).toContain('贴纸');

    const guest = booted.context.db
      .prepare('SELECT finale_reached_at FROM guests WHERE guest_id = ?')
      .get(booted.guestId) as { finale_reached_at: string | null };
    expect(guest.finale_reached_at).toBeTruthy();
  });

  it('supports manual opening and rejects it for non-manual triggers', async () => {
    const booted = await boot();
    await patchFinale(booted, finaleBody({ trigger: { type: 'manual', value: null } }));

    const before = await getFinale(booted);
    expect(before.json<{ reached: boolean }>().reached).toBe(false);

    const opened = await booted.context.app.inject({
      method: 'POST',
      url: `/api/room/${booted.host.room.room_id}/finale/open`,
      headers: { cookie: booted.host.cookie, 'x-wtm-csrf': booted.host.csrf },
    });
    expect(opened.statusCode).toBe(200);
    expect(
      opened.json<{ finale: { opened_at: string | null } }>().finale.opened_at,
    ).toBeTruthy();

    const after = await getFinale(booted);
    expect(after.json<{ reached: boolean }>().reached).toBe(true);

    await patchFinale(booted, finaleBody());
    const notManual = await booted.context.app.inject({
      method: 'POST',
      url: `/api/room/${booted.host.room.room_id}/finale/open`,
      headers: { cookie: booted.host.cookie, 'x-wtm-csrf': booted.host.csrf },
    });
    expect(notManual.statusCode).toBe(409);
    expect(notManual.json<{ error: { code: string } }>().error.code).toBe('FINALE_NOT_MANUAL');
  });

  it('requires every egg to be unlocked for all_eggs', async () => {
    const booted = await boot();
    const answerHash = hashAnswer('打雷', booted.context.config.judge.scrypt);

    for (const doll of booted.dolls) {
      booted.context.db
        .prepare(
          `UPDATE dolls SET egg_enabled = 1, riddle_type = 'short_answer',
             question = '阿黄最怕什么？', answer_hash = ?, synonyms_json = '[]'
           WHERE doll_id = ?`,
        )
        .run(answerHash, doll.doll_id);
    }

    const patched = await patchFinale(
      booted,
      finaleBody({ trigger: { type: 'all_eggs', value: null } }),
    );
    expect(patched.statusCode).toBe(200);

    for (const doll of booted.dolls) await discover(booted, doll.doll_id);
    expect((await getFinale(booted)).json<{ reached: boolean }>().reached).toBe(false);

    for (const doll of booted.dolls) {
      const answer = await booted.context.app.inject({
        method: 'POST',
        url: '/api/play/answer',
        payload: { doll_id: doll.doll_id, answer_text: '打雷' },
        headers: { cookie: booted.cookie, 'content-type': 'application/json' },
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.json<{ correct: boolean }>().correct).toBe(true);
    }

    expect((await getFinale(booted)).json<{ reached: boolean }>().reached).toBe(true);
  });

  it('validates the trigger against the room and warns about empty egg mode', async () => {
    const booted = await boot();

    const tooHigh = await patchFinale(
      booted,
      finaleBody({ trigger: { type: 'count_gte', value: 5 } }),
    );
    expect(tooHigh.statusCode).toBe(422);
    expect(tooHigh.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');

    const noEggs = await patchFinale(
      booted,
      finaleBody({ trigger: { type: 'all_eggs', value: null } }),
    );
    expect(noEggs.statusCode).toBe(200);
    expect(noEggs.json<{ warning?: string }>().warning).toContain('all_collected');

    const noCsrf = await patchFinale(booted, finaleBody(), false);
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json<{ error: { code: string } }>().error.code).toBe('CSRF_INVALID');
  });
});
