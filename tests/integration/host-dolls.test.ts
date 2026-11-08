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

async function boot() {
  const context = await makeTestApp();
  contexts.push(context);
  const host = await setupHost(context.app);
  return { context, host };
}

function auth(host: { cookie: string; csrf: string }) {
  return { cookie: host.cookie, 'x-wtm-csrf': host.csrf };
}

describe('host doll management', () => {
  it('creates, edits, configures and deletes a doll', async () => {
    const { context, host } = await boot();

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/dolls',
      payload: { name: '阿黄', tagline: '家里的第一位成员' },
      headers: auth(host),
    });
    expect(created.statusCode).toBe(200);
    const doll = created.json<{ doll: { doll_id: string; card_token: string; short_code: string } }>()
      .doll;
    expect(doll.card_token).toHaveLength(10);
    expect(doll.short_code).toHaveLength(6);

    const edited = await context.app.inject({
      method: 'PATCH',
      url: `/api/dolls/${doll.doll_id}`,
      payload: { baseStory: '2015 年冬天捡到的', baseCaption: '它陪了我们十一年' },
      headers: auth(host),
    });
    expect(edited.statusCode).toBe(200);

    const levelled = await context.app.inject({
      method: 'PATCH',
      url: `/api/dolls/${doll.doll_id}/level`,
      payload: {
        level_type: 'bonus_quiz',
        egg_enabled: true,
        e1: { effect: 'starlight', sound: true },
        riddle: {
          type: 'single_choice',
          question: '阿黄最怕什么？',
          options: ['吹风机', '黄瓜', '打雷'],
          answer: '打雷',
          hint: '下雨天它会躲起来',
          wrong_text: '还差一点点',
          max_attempts: 0,
          synonyms: ['雷声'],
        },
        secret: { story: '其实它怕关门声', whisper: '谢谢你找到我', star: true },
      },
      headers: auth(host),
    });
    expect(levelled.statusCode).toBe(200);
    const configured = levelled.json<{
      doll: {
        egg_enabled: boolean;
        answer_configured: boolean;
        options: string[];
        synonyms: string[];
        secret_story: string;
      };
    }>().doll;
    expect(configured.egg_enabled).toBe(true);
    expect(configured.answer_configured).toBe(true);
    expect(configured.options).toEqual(['吹风机', '黄瓜', '打雷']);
    expect(configured.synonyms).toEqual(['雷声']);

    const room = await context.app.inject({
      method: 'GET',
      url: `/api/room/${host.room.room_id}`,
      headers: { cookie: host.cookie },
    });
    expect(room.statusCode).toBe(200);
    const roomBody = room.json<{
      dolls: Array<Record<string, unknown>>;
      room: { finale: { trigger: { type: string } } };
    }>();
    expect(roomBody.dolls).toHaveLength(1);
    expect(roomBody.dolls[0]).not.toHaveProperty('answer_hash');
    expect(roomBody.dolls[0]).not.toHaveProperty('card_token_backup');
    expect(roomBody.room.finale.trigger.type).toBe('all_collected');

    const removed = await context.app.inject({
      method: 'DELETE',
      url: `/api/dolls/${doll.doll_id}`,
      headers: auth(host),
    });
    expect(removed.statusCode).toBe(204);

    const empty = await context.app.inject({
      method: 'GET',
      url: `/api/room/${host.room.room_id}`,
      headers: { cookie: host.cookie },
    });
    expect(empty.json<{ dolls: unknown[] }>().dolls).toHaveLength(0);
  });

  it('forces discovery cards to have no riddle and rejects P2 / invalid options', async () => {
    const { context, host } = await boot();
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/dolls',
      payload: { name: '阿花' },
      headers: auth(host),
    });
    const dollId = created.json<{ doll: { doll_id: string } }>().doll.doll_id;

    const discovery = await context.app.inject({
      method: 'PATCH',
      url: `/api/dolls/${dollId}/level`,
      payload: {
        level_type: 'discovery',
        egg_enabled: true,
        e1: { effect: 'confetti', sound: false },
        riddle: { question: '会被清掉', answer: 'x', options: ['a', 'b'] },
      },
      headers: auth(host),
    });
    expect(discovery.statusCode).toBe(200);
    const discovered = discovery.json<{
      doll: { egg_enabled: boolean; question: string; riddle_type: string | null };
    }>().doll;
    expect(discovered.egg_enabled).toBe(false);
    expect(discovered.question).toBe('');
    expect(discovered.riddle_type).toBeNull();

    const p2 = await context.app.inject({
      method: 'PATCH',
      url: `/api/dolls/${dollId}/level`,
      payload: {
        level_type: 'timed',
        egg_enabled: false,
        e1: { effect: 'sparks', sound: true },
      },
      headers: auth(host),
    });
    expect(p2.statusCode).toBe(422);
    expect(p2.json<{ error: { code: string } }>().error.code).toBe('LEVEL_TYPE_NOT_AVAILABLE');

    const badAnswer = await context.app.inject({
      method: 'PATCH',
      url: `/api/dolls/${dollId}/level`,
      payload: {
        level_type: 'bonus_quiz',
        egg_enabled: true,
        e1: { effect: 'bubbles', sound: true },
        riddle: {
          type: 'single_choice',
          question: '题',
          options: ['甲', '乙'],
          answer: '丙',
        },
      },
      headers: auth(host),
    });
    expect(badAnswer.statusCode).toBe(422);
    expect(badAnswer.json<{ error: { message: string } }>().error.message).toContain('选项');
  });

  it('requires host authentication and CSRF', async () => {
    const { context, host } = await boot();

    const anonymous = await context.app.inject({
      method: 'POST',
      url: '/api/dolls',
      payload: { name: '阿黄' },
      headers: { 'content-type': 'application/json' },
    });
    expect(anonymous.statusCode).toBe(401);

    const noCsrf = await context.app.inject({
      method: 'POST',
      url: '/api/dolls',
      payload: { name: '阿黄' },
      headers: { cookie: host.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('host preview', () => {
  it('renders the card page without writing guest progress', async () => {
    const { context, host } = await boot();
    const created = await context.app.inject({
      method: 'POST',
      url: '/api/dolls',
      payload: { name: '阿黄' },
      headers: auth(host),
    });
    const doll = created.json<{ doll: { doll_id: string; card_token: string } }>().doll;

    const preview = await context.app.inject({
      method: 'GET',
      url: `/d/${doll.card_token}?preview=1`,
      headers: { cookie: host.cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain('预览模式');
    expect(preview.body).toContain('阿黄');

    const progress = context.db
      .prepare('SELECT COUNT(*) AS n FROM progress WHERE doll_id = ?')
      .get(doll.doll_id) as { n: number };
    expect(progress.n).toBe(0);

    const anonymous = await context.app.inject({
      method: 'GET',
      url: `/d/${doll.card_token}?preview=1`,
    });
    expect(anonymous.statusCode).toBe(403);
  });
});
