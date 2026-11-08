import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import FormData from 'form-data';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, setupHost, type TestApp } from '../helpers/test-app';
import { triangleGlb } from '../helpers/glb';

const contexts: TestApp[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

async function photo(): Promise<Buffer> {
  return sharp({
    create: { width: 1200, height: 900, channels: 3, background: '#336699' },
  })
    .jpeg()
    .toBuffer();
}

function multipart(
  form: FormData,
  headers: Record<string, string>,
  cookie: string,
  csrf: string,
) {
  return {
    payload: form.getBuffer(),
    headers: {
      ...form.getHeaders(),
      ...headers,
      cookie,
      'x-wtm-csrf': csrf,
    },
  };
}

describe('photo upload → manual GLB generation', () => {
  it('normalizes the photo, opens a task, then completes with a GLB', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const host = await setupHost(context.app);

    const form = new FormData();
    form.append('name', '阿黄');
    form.append('photo', await photo(), { filename: 'photo.jpg', contentType: 'image/jpeg' });

    const uploaded = await context.app.inject({
      method: 'POST',
      url: '/api/dolls/upload',
      ...multipart(form, {}, host.cookie, host.csrf),
    });

    expect(uploaded.statusCode).toBe(200);
    const body = uploaded.json<{
      doll: { doll_id: string; gen_status: string };
      task: { task_id: string; status: string; stage: string; percent: number };
    }>();
    expect(body.doll.gen_status).toBe('queued');
    expect(body.task.stage).toBe('awaiting_upload');
    expect(body.task.status).toBe('queued');
    expect(existsSync(join(context.config.paths.photos, `${body.doll.doll_id}_src.jpg`))).toBe(true);

    const task = await context.app.inject({
      method: 'GET',
      url: `/api/gen/${body.task.task_id}`,
      headers: { cookie: host.cookie },
    });
    expect(task.statusCode).toBe(200);
    expect(task.json<{ task: { stage: string } }>().task.stage).toBe('awaiting_upload');

    const glb = triangleGlb(2);
    const modelForm = new FormData();
    modelForm.append('model', glb, { filename: 'doll.glb', contentType: 'model/gltf-binary' });

    const model = await context.app.inject({
      method: 'POST',
      url: `/api/dolls/${body.doll.doll_id}/asset`,
      ...multipart(modelForm, {}, host.cookie, host.csrf),
    });
    expect(model.statusCode).toBe(200);

    expect(existsSync(join(context.config.paths.models, `${body.doll.doll_id}.glb`))).toBe(true);

    const room = await context.app.inject({
      method: 'GET',
      url: `/api/room/${host.room.room_id}`,
      headers: { cookie: host.cookie },
    });
    const doll = room.json<{
      dolls: Array<{ doll_id: string; gen_status: string; base_model_url: string }>;
    }>().dolls.find((item) => item.doll_id === body.doll.doll_id)!;
    expect(doll.gen_status).toBe('done');
    expect(doll.base_model_url).toBe(`/assets/models/${body.doll.doll_id}.glb`);

    const doneTask = await context.app.inject({
      method: 'GET',
      url: `/api/gen/${body.task.task_id}`,
      headers: { cookie: host.cookie },
    });
    expect(doneTask.json<{ task: { status: string; percent: number } }>().task).toMatchObject({
      status: 'done',
      percent: 100,
    });
  });

  it('rejects invalid photos, invalid GLBs and unauthenticated uploads', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const host = await setupHost(context.app);

    const badForm = new FormData();
    badForm.append('name', '阿黄');
    badForm.append('photo', Buffer.from('not an image'), {
      filename: 'bad.jpg',
      contentType: 'image/jpeg',
    });
    const badPhoto = await context.app.inject({
      method: 'POST',
      url: '/api/dolls/upload',
      ...multipart(badForm, {}, host.cookie, host.csrf),
    });
    expect(badPhoto.statusCode).toBe(422);
    expect(badPhoto.json<{ error: { code: string } }>().error.code).toBe('INVALID_PHOTO');

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/dolls',
      payload: { name: '阿花' },
      headers: { cookie: host.cookie, 'x-wtm-csrf': host.csrf },
    });
    const dollId = created.json<{ doll: { doll_id: string } }>().doll.doll_id;

    const badModelForm = new FormData();
    badModelForm.append('model', Buffer.from('nope'), {
      filename: 'bad.glb',
      contentType: 'model/gltf-binary',
    });
    const badModel = await context.app.inject({
      method: 'POST',
      url: `/api/dolls/${dollId}/asset`,
      ...multipart(badModelForm, {}, host.cookie, host.csrf),
    });
    expect(badModel.statusCode).toBe(422);
    expect(badModel.json<{ error: { code: string } }>().error.code).toBe('INVALID_MODEL');

    const form = new FormData();
    form.append('name', '未登录');
    form.append('photo', await photo(), { filename: 'photo.jpg', contentType: 'image/jpeg' });
    const anonymous = await context.app.inject({
      method: 'POST',
      url: '/api/dolls/upload',
      payload: form.getBuffer(),
      headers: form.getHeaders(),
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
