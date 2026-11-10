import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import FormData from 'form-data';
import { createDollWithCard } from '../../src/server/services/cards';
import { triangleGlb } from '../helpers/glb';
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
  cookie: string;
  csrf: string;
  dollId: string;
}

async function boot(): Promise<Booted> {
  const context = await makeTestApp();
  contexts.push(context);

  const host = await setupHost(context.app);
  const doll = createDollWithCard(context.db, {
    roomId: host.room.room_id,
    name: '阿黄',
  });

  return {
    context,
    roomId: host.room.room_id,
    cookie: host.cookie,
    csrf: host.csrf,
    dollId: doll.doll_id,
  };
}

function modelForm(bytes: Buffer): FormData {
  const form = new FormData();
  form.append('model', bytes, { filename: 'alt.glb', contentType: 'model/gltf-binary' });
  return form;
}

function injectUpload(booted: Booted, form: FormData) {
  return booted.context.app.inject({
    method: 'POST',
    url: `/api/dolls/${booted.dollId}/secret-asset`,
    payload: form.getBuffer(),
    headers: { ...form.getHeaders(), cookie: booted.cookie, 'x-wtm-csrf': booted.csrf },
  });
}

describe('second-form GLB upload', () => {
  it('stores the model and keeps it when the level form omits model_url', async () => {
    const booted = await boot();
    const altPath = join(booted.context.config.paths.models, `${booted.dollId}_alt.glb`);

    const upload = await injectUpload(booted, modelForm(triangleGlb(4)));
    expect(upload.statusCode).toBe(200);
    const body = upload.json<{
      doll: { secret_model_url: string | null };
      glb: { triangles: number };
    }>();
    expect(body.doll.secret_model_url).toBe(`/assets/models/${booted.dollId}_alt.glb`);
    expect(body.glb.triangles).toBe(4);
    expect(existsSync(altPath)).toBe(true);

    // Saving the E2 form (which has no model_url field) must not clear it.
    const level = await booted.context.app.inject({
      method: 'PATCH',
      url: `/api/dolls/${booted.dollId}/level`,
      payload: {
        level_type: 'bonus_quiz',
        egg_enabled: true,
        e1: { effect: 'starlight', sound: true },
        riddle: { type: 'short_answer', question: '最怕什么？', answer: '打雷' },
        secret: { story: '怕关门声。', whisper: '谢谢你。', effect: 'golden_gather', star: true },
      },
      headers: {
        'content-type': 'application/json',
        cookie: booted.cookie,
        'x-wtm-csrf': booted.csrf,
      },
    });
    expect(level.statusCode).toBe(200);
    expect(
      level.json<{ doll: { secret_model_url: string | null } }>().doll.secret_model_url,
    ).toBe(`/assets/models/${booted.dollId}_alt.glb`);
  });

  it('rejects an invalid GLB before writing anything', async () => {
    const booted = await boot();
    const altPath = join(booted.context.config.paths.models, `${booted.dollId}_alt.glb`);

    const upload = await injectUpload(booted, modelForm(Buffer.from('not a glb')));
    expect(upload.statusCode).toBe(422);
    expect(upload.json<{ error: { code: string } }>().error.code).toBe('INVALID_MODEL');
    expect(existsSync(altPath)).toBe(false);
  });

  it('requires a CSRF token and an authenticated host', async () => {
    const booted = await boot();
    const form = modelForm(triangleGlb(2));
    const noCsrf = await booted.context.app.inject({
      method: 'POST',
      url: `/api/dolls/${booted.dollId}/secret-asset`,
      payload: form.getBuffer(),
      headers: { ...form.getHeaders(), cookie: booted.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);

    const form2 = modelForm(triangleGlb(2));
    const anonymous = await booted.context.app.inject({
      method: 'POST',
      url: `/api/dolls/${booted.dollId}/secret-asset`,
      payload: form2.getBuffer(),
      headers: form2.getHeaders(),
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('removes the file and clears secret_model_url', async () => {
    const booted = await boot();
    const altPath = join(booted.context.config.paths.models, `${booted.dollId}_alt.glb`);
    expect((await injectUpload(booted, modelForm(triangleGlb(2)))).statusCode).toBe(200);

    const removed = await booted.context.app.inject({
      method: 'DELETE',
      url: `/api/dolls/${booted.dollId}/secret-asset`,
      headers: { cookie: booted.cookie, 'x-wtm-csrf': booted.csrf },
    });
    expect(removed.statusCode).toBe(200);
    expect(
      removed.json<{ doll: { secret_model_url: string | null } }>().doll.secret_model_url,
    ).toBeNull();
    expect(existsSync(altPath)).toBe(false);
  });
});
