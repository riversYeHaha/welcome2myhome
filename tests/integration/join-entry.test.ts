import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoom, setRoomStatus } from '../../src/server/db/repos/rooms';
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
  roomId: string;
  roomCode: string;
  cookie: string;
  csrf: string;
  doll: { doll_id: string; card_token: string; short_code: string };
}

async function boot(options: { live?: boolean } = {}): Promise<Booted> {
  const context = await makeTestApp();
  contexts.push(context);

  const host = await setupHost(context.app);
  if (options.live !== false) setRoomStatus(context.db, host.room.room_id, 'live');

  const doll = createDollWithCard(context.db, {
    roomId: host.room.room_id,
    name: '阿黄',
  });

  return {
    context,
    roomId: host.room.room_id,
    roomCode: host.room.room_code,
    cookie: host.cookie,
    csrf: host.csrf,
    doll: {
      doll_id: doll.doll_id,
      card_token: doll.card_token,
      short_code: doll.short_code,
    },
  };
}

interface JoinInject {
  method: 'POST';
  url: string;
  headers: { 'content-type': string };
  payload: string;
}

function joinForm(booted: Booted, fields: Record<string, string>): JoinInject {
  const params = new URLSearchParams({
    room_code: booted.roomCode,
    nickname: '小林',
    ...fields,
  });
  return {
    method: 'POST',
    url: '/join',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: params.toString(),
  };
}

describe('welcome-code landing', () => {
  it('sends a guest without a session to the join page', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`/join?r=${booted.roomCode}`);
  });

  it('sends a returning guest to the collection', async () => {
    const booted = await boot();
    const join = await booted.context.app.inject({
      method: 'POST',
      url: '/api/guests/join',
      payload: { room_code: booted.roomCode, nickname: '小林' },
      headers: { 'content-type': 'application/json' },
    });
    const guestCookie = cookieOf(join);

    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/',
      headers: { cookie: guestCookie },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/collection');
  });

  it('explains what to do before a room exists', async () => {
    const context = await makeTestApp();
    contexts.push(context);

    const response = await context.app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('房间还没有创建');
  });
});

describe('FR-23 short-code entry', () => {
  it('shows the optional short-code field on the join page', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject({
      method: 'GET',
      url: `/join?r=${booted.roomCode}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('name="short_code"');
    expect(response.body).toContain('6 位短码');
  });

  it('joins and lands directly on the card from a 6-character code', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject(
      joinForm(booted, { short_code: booted.doll.short_code }),
    );

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/d/${booted.doll.card_token}`);
    expect(cookieOf(response)).toContain('wtm_guest=');
  });

  it('accepts lowercase input by normalising it', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject(
      joinForm(booted, { short_code: booted.doll.short_code.toLowerCase() }),
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/d/${booted.doll.card_token}`);
  });

  it('redirects to the next path when no short code is given', async () => {
    const booted = await boot();
    const response = await booted.context.app.inject(
      joinForm(booted, { next: `/d/${booted.doll.card_token}` }),
    );
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`/d/${booted.doll.card_token}`);
  });

  it('renders a helpful error for a wrong or malformed code', async () => {
    const booted = await boot();

    const wrong = await booted.context.app.inject(joinForm(booted, { short_code: 'ZZZZZZ' }));
    expect(wrong.statusCode).toBe(422);
    expect(wrong.body).toContain('短码不对');

    const malformed = await booted.context.app.inject(joinForm(booted, { short_code: 'O0' }));
    expect(malformed.statusCode).toBe(422);
    expect(malformed.body).toContain('6 位字母或数字');
  });

  it('refuses a short code from another household', async () => {
    const booted = await boot();
    const foreignRoom = createRoom(booted.context.db, { title: '别家' });
    const other = createDollWithCard(booted.context.db, {
      roomId: foreignRoom.room_id,
      name: '别家',
    });

    const response = await booted.context.app.inject(
      joinForm(booted, { short_code: other.short_code }),
    );
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain('短码不对');
  });
});
