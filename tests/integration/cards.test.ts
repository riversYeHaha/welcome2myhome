import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDollWithCard } from '../../src/server/services/cards';
import {
  createRoom,
  setRoomLanIp,
  setRoomStatus,
} from '../../src/server/db/repos/rooms';
import { makeTestApp, setupHost, type TestApp } from '../helpers/test-app';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const contexts: TestApp[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

async function withApp(): Promise<TestApp> {
  const context = await makeTestApp();
  contexts.push(context);
  return context;
}

async function seedLiveRoom(context: TestApp) {
  const room = createRoom(context.db, { title: '我的家', roomCode: '426918' });
  setRoomStatus(context.db, room.room_id, 'live');
  setRoomLanIp(context.db, room.room_id, '192.168.1.50', 8080);
  const doll = createDollWithCard(context.db, { roomId: room.room_id, name: '阿黄' });
  return { room, doll };
}

describe('QR endpoints', () => {
  it('serves a card QR and the welcome QR as PNGs', async () => {
    const context = await withApp();
    const { doll } = await seedLiveRoom(context);

    const card = await context.app.inject({
      method: 'GET',
      url: `/api/cards/${doll.doll_id}/qr.png`,
    });
    expect(card.statusCode).toBe(200);
    expect(card.headers['content-type']).toContain('image/png');
    expect(card.rawPayload.subarray(0, 8)).toEqual(PNG_MAGIC);

    const welcome = await context.app.inject({
      method: 'GET',
      url: '/api/cards/welcome.png',
    });
    expect(welcome.statusCode).toBe(200);
    expect(welcome.headers['content-type']).toContain('image/png');
    expect(welcome.rawPayload.subarray(0, 8)).toEqual(PNG_MAGIC);
  });

  it('returns 404 for an unknown doll', async () => {
    const context = await withApp();
    await seedLiveRoom(context);

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/cards/d_missing/qr.png',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/play/shortcode', () => {
  it('resolves a typed short code to the card URL', async () => {
    const context = await withApp();
    const { doll } = await seedLiveRoom(context);

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/play/shortcode',
      payload: { room_code: '426918', short_code: doll.short_code.toLowerCase() },
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ doll_id: string; card_url: string }>();
    expect(body.doll_id).toBe(doll.doll_id);
    expect(body.card_url).toBe(
      `http://192.168.1.50:8080/d/${doll.card_token}?r=426918`,
    );
  });

  it('rejects ambiguous characters, closed rooms and unknown rooms', async () => {
    const context = await withApp();
    const { room, doll } = await seedLiveRoom(context);

    const ambiguous = await context.app.inject({
      method: 'POST',
      url: '/api/play/shortcode',
      payload: {
        room_code: '426918',
        short_code: `${doll.short_code.slice(0, 5)}0`,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(ambiguous.statusCode).toBe(404);
    expect(ambiguous.json<{ error: { code: string } }>().error.code).toBe('SHORTCODE_INVALID');

    setRoomStatus(context.db, room.room_id, 'ended');
    const closed = await context.app.inject({
      method: 'POST',
      url: '/api/play/shortcode',
      payload: { room_code: '426918', short_code: doll.short_code },
      headers: { 'content-type': 'application/json' },
    });
    expect(closed.statusCode).toBe(403);
    expect(closed.json<{ error: { code: string } }>().error.code).toBe('ROOM_NOT_LIVE');

    const unknown = await context.app.inject({
      method: 'POST',
      url: '/api/play/shortcode',
      payload: { room_code: '000000', short_code: doll.short_code },
      headers: { 'content-type': 'application/json' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json<{ error: { code: string } }>().error.code).toBe('ROOM_NOT_FOUND');
  });
});

describe('host card management', () => {
  it('sets the LAN address and issues a backup token', async () => {
    const context = await withApp();
    const { cookie, csrf, room } = await setupHost(context.app);
    const doll = createDollWithCard(context.db, { roomId: room.room_id, name: '阿黄' });

    const network = await context.app.inject({
      method: 'PATCH',
      url: `/api/room/${room.room_id}/network`,
      payload: { lan_ip: '192.168.1.50', port: 8080 },
      headers: { cookie, 'x-wtm-csrf': csrf },
    });
    expect(network.statusCode).toBe(200);
    expect(network.json<{ room: { lan_ip: string } }>().room.lan_ip).toBe('192.168.1.50');

    const backup = await context.app.inject({
      method: 'POST',
      url: `/api/dolls/${doll.doll_id}/backup-token`,
      headers: { cookie, 'x-wtm-csrf': csrf },
    });
    expect(backup.statusCode).toBe(200);
    const body = backup.json<{ backup_token: string }>();
    expect(body.backup_token).toHaveLength(10);
    expect(body.backup_token).not.toBe(doll.card_token);
  });
});
