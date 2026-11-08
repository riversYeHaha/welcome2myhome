import { rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
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
  roomId: string;
  roomCode: string;
  cookie: string;
  dolls: Array<{ doll_id: string; card_token: string }>;
}

async function boot(options: { collect?: number } = {}): Promise<Booted> {
  const context = await makeTestApp();
  contexts.push(context);

  const host = await setupHost(context.app);
  setRoomStatus(context.db, host.room.room_id, 'live');

  const dolls = ['阿黄', '阿花', '小满'].map((name) =>
    createDollWithCard(context.db, { roomId: host.room.room_id, name }),
  );

  const join = await context.app.inject({
    method: 'POST',
    url: '/api/guests/join',
    payload: { room_code: host.room.room_code, nickname: '小林' },
    headers: { 'content-type': 'application/json' },
  });
  expect(join.statusCode).toBe(200);
  const guestToken = join.json<{ guest_token: string }>().guest_token;

  for (const doll of dolls.slice(0, options.collect ?? dolls.length)) {
    const scan = await context.app.inject({
      method: 'GET',
      url: `/api/play/d/${doll.card_token}`,
      headers: { authorization: `Bearer ${guestToken}` },
    });
    expect(scan.statusCode).toBe(200);
    const discover = await context.app.inject({
      method: 'POST',
      url: '/api/play/discover',
      payload: { doll_id: doll.doll_id },
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${guestToken}`,
      },
    });
    expect(discover.statusCode).toBe(200);
  }

  context.db
    .prepare(
      `UPDATE rooms SET finale_json = ? WHERE room_id = ?`,
    )
    .run(
      JSON.stringify({
        enabled: true,
        trigger: { type: 'all_collected', value: null },
        title: '你今晚见到了我们全家',
        body: '最后这一位，是一直在厨房忙的那个人。',
        image_url: null,
        model_url: null,
        reward_note: '',
        share_caption: '今晚我认识了 3 个人',
        opened_at: null,
      }),
      host.room.room_id,
    );

  return {
    context,
    roomId: host.room.room_id,
    roomCode: host.room.room_code,
    cookie: cookieOf(join),
    dolls,
  };
}

describe('share card', () => {
  it('renders a 1080x1440 PNG with collected names only', async () => {
    const booted = await boot({ collect: 2 });
    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/share/card.png',
      headers: { cookie: booted.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(response.headers['content-disposition']).toContain('welcome-home-share.png');

    const png = response.rawPayload;
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1440);

    // Keep the artifact around for manual inspection during development.
    writeFileSync('/tmp/wtm-share-card.png', png);
  });

  it('renders the full-family variant and a single-name edge case', async () => {
    const full = await boot();
    const fullResponse = await full.context.app.inject({
      method: 'GET',
      url: '/api/share/card.png',
      headers: { cookie: full.cookie },
    });
    expect(fullResponse.statusCode).toBe(200);
    expect((await sharp(fullResponse.rawPayload).metadata()).width).toBe(1080);

    const single = await boot({ collect: 1 });
    const singleResponse = await single.context.app.inject({
      method: 'GET',
      url: '/api/share/card.png',
      headers: { cookie: single.cookie },
    });
    expect(singleResponse.statusCode).toBe(200);
    writeFileSync('/tmp/wtm-share-card-single.png', singleResponse.rawPayload);
  });

  it('asks the guest to collect someone first', async () => {
    const booted = await boot({ collect: 0 });
    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/share/card.png',
      headers: { cookie: booted.cookie },
    });
    expect(response.statusCode).toBe(409);
  });

  it('requires a guest session', async () => {
    const booted = await boot({ collect: 1 });
    const response = await booted.context.app.inject({
      method: 'GET',
      url: '/api/share/card.png',
    });
    expect(response.statusCode).toBe(401);
  });
});
