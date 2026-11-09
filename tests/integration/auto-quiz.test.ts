import { rmSync } from 'node:fs';
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

interface Booted {
  context: TestApp;
  roomCode: string;
  cookie: string;
  doll: { doll_id: string; card_token: string };
}

async function boot(): Promise<Booted> {
  const context = await makeTestApp();
  contexts.push(context);

  const host = await setupHost(context.app);
  setRoomStatus(context.db, host.room.room_id, 'live');

  const doll = createDollWithCard(context.db, { roomId: host.room.room_id, name: '阿黄' });
  context.db
    .prepare(
      `UPDATE dolls SET egg_enabled = 1, riddle_type = 'single_choice',
         question = '阿黄最怕什么？', options_json = ?, answer_hash = ?
       WHERE doll_id = ?`,
    )
    .run(JSON.stringify(['吹风机', '打雷']), 'scrypt$1$2$3$4$5', doll.doll_id);

  const join = await context.app.inject({
    method: 'POST',
    url: '/api/guests/join',
    payload: { room_code: host.room.room_code, nickname: '小林' },
    headers: { 'content-type': 'application/json' },
  });

  return {
    context,
    roomCode: host.room.room_code,
    cookie: cookieOf(join),
    doll: { doll_id: doll.doll_id, card_token: doll.card_token },
  };
}

describe('effects.autoQuiz', () => {
  it('is off by default, so the quiz only opens through the button', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject({
      method: 'GET',
      url: `/d/${booted.doll.card_token}`,
      headers: { cookie: booted.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-auto-quiz="0"');
  });

  it('marks the card page when the host opts in', async () => {
    const booted = await boot();
    booted.context.config.effects.autoQuiz = true;

    const response = await booted.context.app.inject({
      method: 'GET',
      url: `/d/${booted.doll.card_token}`,
      headers: { cookie: booted.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-auto-quiz="1"');
  });

  it('never auto-opens in host preview', async () => {
    const booted = await boot();
    booted.context.config.effects.autoQuiz = true;
    const login = await booted.context.app.inject({
      method: 'POST',
      url: '/api/host/login',
      payload: { pin: '1234' },
      headers: { 'content-type': 'application/json' },
    });
    const cookie = cookieOf(login);

    const response = await booted.context.app.inject({
      method: 'GET',
      url: `/d/${booted.doll.card_token}?preview=1`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-auto-quiz="0"');
  });
});
