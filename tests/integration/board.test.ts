import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardSnapshot } from '../../src/shared/board';
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
  guestToken?: string;
}

async function boot(join = true): Promise<Booted> {
  const context = await makeTestApp();
  contexts.push(context);

  const host = await setupHost(context.app);
  setRoomStatus(context.db, host.room.room_id, 'live');

  const doll = createDollWithCard(context.db, { roomId: host.room.room_id, name: '阿黄' });
  context.db
    .prepare(
      `UPDATE dolls SET base_story = '楼下纸箱里捡到的。',
         egg_enabled = 1, riddle_type = 'single_choice',
         question = '阿黄最怕什么？', options_json = ?,
         answer_hash = ?, secret_story = '怕关门声。'
       WHERE doll_id = ?`,
    )
    .run(JSON.stringify(['吹风机', '打雷']), hashAnswer('打雷', context.config.judge.scrypt), doll.doll_id);

  let guestToken: string | undefined;
  if (join) {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/guests/join',
      payload: { room_code: host.room.room_code, nickname: '小林' },
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
    guestToken = response.json<{ guest_token: string }>().guest_token;
  }

  return {
    context,
    roomId: host.room.room_id,
    roomCode: host.room.room_code,
    cookie: host.cookie,
    csrf: host.csrf,
    doll,
    guestToken,
  };
}

async function readBoard(booted: Booted): Promise<BoardSnapshot> {
  const response = await booted.context.app.inject({
    method: 'GET',
    url: `/api/board/${booted.roomId}`,
    headers: { cookie: booted.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ board: BoardSnapshot }>().board;
}

function scan(booted: Booted, token: string) {
  return booted.context.app.inject({
    method: 'GET',
    url: `/api/play/d/${token}`,
    headers: { authorization: `Bearer ${booted.guestToken}` },
  });
}

function progress(booted: Booted, dollId: string) {
  return booted.context.app.inject({
    method: 'POST',
    url: '/api/play/discover',
    payload: { doll_id: dollId },
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${booted.guestToken}`,
    },
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  matcher: (text: string) => boolean,
  timeoutMs = 4000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  while (!matcher(buffer)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`SSE timed out, buffer tail: ${buffer.slice(-400)}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((resolve) => {
        setTimeout(() => resolve({ done: true }), remaining);
      }),
    ]);
    if (result.done) {
      if (buffer.length > 0) continue;
      throw new Error('SSE stream closed early');
    }
    if (result.value) buffer += decoder.decode(result.value, { stream: true });
  }
  return buffer;
}

describe('host board', () => {
  it('requires a host session and refuses another room id', async () => {
    const booted = await boot();
    const anonymous = await booted.context.app.inject({
      method: 'GET',
      url: `/api/board/${booted.roomId}`,
    });
    expect(anonymous.statusCode).toBe(401);

    const foreign = await booted.context.app.inject({
      method: 'GET',
      url: '/api/board/room_other',
      headers: { cookie: booted.cookie },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('aggregates guests, progress, per-doll mistakes and never leaks answers', async () => {
    const booted = await boot();

    const initial = await readBoard(booted);
    expect(initial.totals.guests).toBe(1);
    expect(initial.totals.online).toBe(1);
    expect(initial.totals.dolls).toBe(1);
    expect(initial.totals.discovered).toBe(0);
    expect(initial.guests[0]!.progress[0]!.state).toBe('locked');
    expect(initial.recent_events.some((event) => event.type === 'guest_join')).toBe(true);

    expect((await scan(booted, booted.doll.card_token)).statusCode).toBe(200);
    expect((await progress(booted, booted.doll.doll_id)).statusCode).toBe(200);

    // Wrong answer first, so the mistake counter is exercised.
    const wrong = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/answer',
      payload: { doll_id: booted.doll.doll_id, choice_index: 0 },
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${booted.guestToken}`,
      },
    });
    expect(wrong.json<{ correct: boolean }>().correct).toBe(false);

    const board = await readBoard(booted);
    expect(board.totals.discovered).toBe(1);
    expect(board.totals.collected).toBe(1);
    expect(board.totals.eggs).toBe(0);
    expect(board.totals.wrong_attempts).toBe(1);
    expect(board.guests[0]!.collected).toBe(1);
    expect(board.guests[0]!.online).toBe(true);
    expect(board.guests[0]!.progress[0]!.state).toBe('egg_answering');
    expect(board.guests[0]!.progress[0]!.attempts).toBe(1);
    expect(board.dolls[0]!.wrong_attempts).toBe(1);
    expect(board.dolls[0]!.guests_wrong).toBe(1);
    expect(board.recent_events.some((event) => event.type === 'answer_submit')).toBe(true);

    const serialized = JSON.stringify(board);
    expect(serialized).not.toContain(booted.doll.card_token);
    expect(serialized).not.toContain('打雷');
    expect(serialized).not.toContain('answer_hash');
    expect(serialized).not.toContain('"answer"');
  });

  it('accepts whitelisted browser telemetry and strips secrets from the payload', async () => {
    const booted = await boot();

    const response = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/telemetry',
      payload: {
        type: 'egg1_played',
        doll_id: booted.doll.doll_id,
        payload: {
          effect: 'confetti',
          replay: false,
          answer: '打雷',
          token: booted.doll.card_token,
          first_frame_ms: 420,
        },
      },
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${booted.guestToken}`,
      },
    });
    expect(response.statusCode).toBe(204);

    const board = await readBoard(booted);
    const played = board.recent_events.find((event) => event.type === 'egg1_played');
    expect(played).toBeDefined();
    expect(played!.payload.effect).toBe('confetti');
    expect(played!.payload.first_frame_ms).toBe(420);
    expect(played!.payload.answer).toBeUndefined();
    expect(played!.payload.token).toBeUndefined();

    const rejected = await booted.context.app.inject({
      method: 'POST',
      url: '/api/play/telemetry',
      payload: { type: 'not_a_real_event' },
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${booted.guestToken}`,
      },
    });
    expect(rejected.statusCode).toBe(422);
  });

  it('exports events as redacted JSONL', async () => {
    const booted = await boot();
    await scan(booted, booted.doll.card_token);

    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/host/logs/export',
      headers: { cookie: booted.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(String(response.headers['content-disposition'])).toContain('attachment');

    const lines = response.body.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.every((row) => typeof row.seq === 'number')).toBe(true);
    expect(parsed.some((row) => row.type === 'guest_join')).toBe(true);
    expect(parsed.some((row) => row.type === 'card_scanned')).toBe(true);
    expect(response.body).not.toContain(booted.doll.card_token);
    expect(response.body).not.toContain('打雷');
  });

  it('streams live nudges over SSE and closes when the room ends', async () => {
    const booted = await boot();
    const address = await booted.context.app.listen({ port: 0, host: '127.0.0.1' });
    const base = address.replace(/\/$/, '');

    const controller = new AbortController();
    try {
      const response = await fetch(`${base}/api/board/${booted.roomId}/stream`, {
        headers: { cookie: booted.cookie },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const reader = response.body!.getReader();
      try {
        await readUntil(reader, (text) => text.includes('event: ready'));

        await scan(booted, booted.doll.card_token);
        const first = await readUntil(reader, (text) => text.includes('event: guest_online'));
        expect(first).toContain('card_scanned');

        const ended = await booted.context.app.inject({
          method: 'PATCH',
          url: `/api/room/${booted.roomId}/status`,
          payload: { status: 'ended' },
          headers: {
            'content-type': 'application/json',
            cookie: booted.cookie,
            'x-wtm-csrf': booted.csrf,
          },
        });
        expect(ended.statusCode).toBe(200);

        const closed = await readUntil(reader, (text) => text.includes('event: closed'));
        expect(closed).toContain('event: closed');
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      controller.abort();
    }
  });

  it('answers 401 on the stream without a host cookie', async () => {
    const booted = await boot();
    const address = await booted.context.app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(
      `${address.replace(/\/$/, '')}/api/board/${booted.roomId}/stream`,
    );
    expect(response.status).toBe(401);
    await response.body?.cancel();
  });
});
