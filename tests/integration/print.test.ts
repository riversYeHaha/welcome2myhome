import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, setupHost, type TestApp } from '../helpers/test-app';

const contexts: TestApp[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

function auth(host: { cookie: string; csrf: string }) {
  return { cookie: host.cookie, 'x-wtm-csrf': host.csrf };
}

describe('card print sheet', () => {
  it('requires a host session', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    await setupHost(context.app);

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/cards/print',
    });
    expect(response.statusCode).toBe(401);
  });

  it('renders A4 cards with QR URLs, short codes and the welcome card', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const host = await setupHost(context.app);

    const first = await context.app.inject({
      method: 'POST',
      url: '/api/dolls',
      payload: { name: '阿黄' },
      headers: auth(host),
    });
    const second = await context.app.inject({
      method: 'POST',
      url: '/api/dolls',
      payload: { name: '阿花' },
      headers: auth(host),
    });
    const firstDoll = first.json<{ doll: { doll_id: string; short_code: string } }>().doll;
    const secondDoll = second.json<{ doll: { doll_id: string; short_code: string } }>().doll;

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/cards/print',
      headers: { cookie: host.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('@page');
    expect(response.body).toContain('/print.js');
    expect(response.body).toContain('/api/cards/welcome.png');
    expect(response.body).toContain(`/api/cards/${firstDoll.doll_id}/qr.png`);
    expect(response.body).toContain(`/api/cards/${secondDoll.doll_id}/qr.png`);
    expect(response.body).toContain(firstDoll.short_code);
    expect(response.body).toContain(secondDoll.short_code);
    expect(response.body).toContain('尚未设置局域网地址');
    // Names are not printed on the card face (silhouette only).
    expect(response.body).not.toContain('阿黄');
  });

  it('writes the configured LAN address into the print header', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const host = await setupHost(context.app);

    await context.app.inject({
      method: 'PATCH',
      url: `/api/room/${host.room.room_id}/network`,
      payload: { lan_ip: '192.168.1.50', port: 8080 },
      headers: auth(host),
    });

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/cards/print',
      headers: { cookie: host.cookie },
    });
    expect(response.body).toContain('http://192.168.1.50:8080');
  });
});
