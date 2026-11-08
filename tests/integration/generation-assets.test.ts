import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import FormData from 'form-data';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { createGenTask } from '../../src/server/db/repos/gen';
import { createRoom } from '../../src/server/db/repos/rooms';
import { createDollWithCard } from '../../src/server/services/cards';
import {
  runLux3DGeneration,
  type Lux3DProvider,
} from '../../src/server/services/generation';
import { makeTestApp, setupHost, type TestApp } from '../helpers/test-app';
import { dracoGlb, meshoptGlb, triangleGlb } from '../helpers/glb';

const contexts: TestApp[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

interface UploadedDoll {
  dollId: string;
  taskId: string;
}

async function photo(): Promise<Buffer> {
  return sharp({
    create: { width: 640, height: 480, channels: 3, background: '#446688' },
  })
    .jpeg()
    .toBuffer();
}

function multipart(
  form: FormData,
  cookie: string,
  csrf: string,
): { payload: Buffer; headers: Record<string, string> } {
  return {
    payload: form.getBuffer(),
    headers: { ...form.getHeaders(), cookie, 'x-wtm-csrf': csrf },
  };
}

async function uploadPhoto(
  context: TestApp,
  host: { cookie: string; csrf: string },
): Promise<UploadedDoll> {
  const form = new FormData();
  form.append('name', '阿黄');
  form.append('photo', await photo(), { filename: 'photo.jpg', contentType: 'image/jpeg' });

  const uploaded = await context.app.inject({
    method: 'POST',
    url: '/api/dolls/upload',
    ...multipart(form, host.cookie, host.csrf),
  });
  expect(uploaded.statusCode).toBe(200);
  const body = uploaded.json<{ doll: { doll_id: string }; task: { task_id: string } }>();
  return { dollId: body.doll.doll_id, taskId: body.task.task_id };
}

async function uploadModel(
  context: TestApp,
  host: { cookie: string; csrf: string },
  dollId: string,
  bytes: Buffer,
) {
  const form = new FormData();
  form.append('model', bytes, { filename: 'doll.glb', contentType: 'model/gltf-binary' });
  return context.app.inject({
    method: 'POST',
    url: `/api/dolls/${dollId}/asset`,
    ...multipart(form, host.cookie, host.csrf),
  });
}

async function taskOf(context: TestApp, host: { cookie: string }, taskId: string) {
  const response = await context.app.inject({
    method: 'GET',
    url: `/api/gen/${taskId}`,
    headers: { cookie: host.cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    task: { status: string; stage: string; percent: number; fallback_used: boolean };
  }>().task;
}

async function dollOf(context: TestApp, host: { cookie: string }, roomId: string, dollId: string) {
  const response = await context.app.inject({
    method: 'GET',
    url: `/api/room/${roomId}`,
    headers: { cookie: host.cookie },
  });
  return response
    .json<{
      dolls: Array<{ doll_id: string; gen_status: string; base_model_url: string }>;
    }>()
    .dolls.find((doll) => doll.doll_id === dollId)!;
}

function assetKinds(context: TestApp, dollId: string): string[] {
  return (
    context.db
      .prepare('SELECT kind FROM assets WHERE doll_id = ? ORDER BY created_at ASC')
      .all(dollId) as Array<{ kind: string }>
  ).map((row) => row.kind);
}

describe('GLB ingestion and fallback marking', () => {
  it('stores a valid GLB, records assets and leaves fallback unset', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const host = await setupHost(context.app);
    const { dollId, taskId } = await uploadPhoto(context, host);

    const response = await uploadModel(context, host, dollId, triangleGlb(6));
    expect(response.statusCode).toBe(200);

    const modelPath = join(context.config.paths.models, `${dollId}.glb`);
    const rawPath = join(context.config.paths.models, `${dollId}_raw.glb`);
    expect(existsSync(modelPath)).toBe(true);
    expect(existsSync(rawPath)).toBe(true);

    const task = await taskOf(context, host, taskId);
    expect(task).toMatchObject({ status: 'done', stage: 'done', percent: 100 });
    expect(task.fallback_used).toBe(false);

    const doll = await dollOf(context, host, host.room.room_id, dollId);
    expect(doll.gen_status).toBe('done');
    expect(doll.base_model_url).toBe(`/assets/models/${dollId}.glb`);
    expect(assetKinds(context, dollId)).toContain('base_model');
  });

  it('rejects an invalid GLB, keeps it out of storage and marks fallback', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const host = await setupHost(context.app);
    const { dollId, taskId } = await uploadPhoto(context, host);

    const response = await uploadModel(context, host, dollId, Buffer.from('nope'));
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_MODEL');

    expect(existsSync(join(context.config.paths.models, `${dollId}.glb`))).toBe(false);

    const task = await taskOf(context, host, taskId);
    expect(task.status).toBe('failed');
    expect(task.fallback_used).toBe(true);

    const doll = await dollOf(context, host, host.room.room_id, dollId);
    expect(doll.gen_status).toBe('failed');
    expect(doll.base_model_url).toBe('');
  });

  it('rejects an over-complex GLB with an actionable message', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const host = await setupHost(context.app);
    const { dollId, taskId } = await uploadPhoto(context, host);

    const response = await uploadModel(context, host, dollId, triangleGlb(300_001, { withBinary: false }));
    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('MODEL_TOO_COMPLEX');
    expect(body.error.message).toContain('300000');
    expect((await taskOf(context, host, taskId)).fallback_used).toBe(true);
    expect(existsSync(join(context.config.paths.models, `${dollId}.glb`))).toBe(false);
  });

  it('rejects meshopt-compressed GLBs with a re-export hint', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const host = await setupHost(context.app);
    const { dollId } = await uploadPhoto(context, host);

    const response = await uploadModel(context, host, dollId, meshoptGlb(2));
    expect(response.statusCode).toBe(422);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('INVALID_MODEL');
    expect(body.error.message).toContain('EXT_meshopt_compression');
    expect(body.error.message).toContain('重新导出');
  });

  it('accepts Draco-compressed GLBs (viewer decodes them locally)', async () => {
    const context = await makeTestApp();
    contexts.push(context);
    const host = await setupHost(context.app);
    const { dollId, taskId } = await uploadPhoto(context, host);

    const response = await uploadModel(context, host, dollId, dracoGlb(4));
    expect(response.statusCode).toBe(200);
    expect(existsSync(join(context.config.paths.models, `${dollId}.glb`))).toBe(true);
    expect((await taskOf(context, host, taskId)).status).toBe('done');
  });

  it('copies a bundled preset model when fallback has no generated GLB', async () => {
    const context = await makeTestApp();
    contexts.push(context);

    // Simulate `assets/presets/` shipping with the repo (§7.5).
    const presetDir = join(context.config.paths.root, 'assets/presets');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'preset-01.glb'), triangleGlb(3));

    const host = await setupHost(context.app);
    const { dollId, taskId } = await uploadPhoto(context, host);

    const response = await uploadModel(context, host, dollId, Buffer.from('broken'));
    expect(response.statusCode).toBe(422);

    const modelPath = join(context.config.paths.models, `${dollId}.glb`);
    expect(existsSync(modelPath)).toBe(true);

    const task = await taskOf(context, host, taskId);
    expect(task.status).toBe('failed');
    expect(task.stage).toBe('fallback');
    expect(task.fallback_used).toBe(true);

    const doll = await dollOf(context, host, host.room.room_id, dollId);
    expect(doll.gen_status).toBe('done');
    expect(doll.base_model_url).toBe(`/assets/models/${dollId}.glb`);
    expect(assetKinds(context, dollId)).toEqual(
      expect.arrayContaining(['preset_model', 'base_model']),
    );
  });
});

describe('public silhouette assets', () => {
  it('serves silhouettes with public cache headers and blocks traversal', async () => {
    const context = await makeTestApp();
    contexts.push(context);

    const name = 'd_abcdefgh_silhouette.png';
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    mkdirSync(context.config.paths.silhouettes, { recursive: true });
    writeFileSync(join(context.config.paths.silhouettes, name), png);

    const ok = await context.app.inject({
      method: 'GET',
      url: `/assets/silhouettes/${name}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('image/png');
    expect(ok.headers['cache-control']).toBe('public, max-age=604800');
    expect(ok.headers.etag).toBeTruthy();
    expect(ok.rawPayload.equals(png)).toBe(true);

    const cached = await context.app.inject({
      method: 'GET',
      url: `/assets/silhouettes/${name}`,
      headers: { 'if-none-match': String(ok.headers.etag) },
    });
    expect(cached.statusCode).toBe(304);

    const partial = await context.app.inject({
      method: 'GET',
      url: `/assets/silhouettes/${name}`,
      headers: { range: 'bytes=0-3' },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe(`bytes 0-3/${png.length}`);
    expect(partial.rawPayload.equals(png.subarray(0, 4))).toBe(true);

    const unsatisfiable = await context.app.inject({
      method: 'GET',
      url: `/assets/silhouettes/${name}`,
      headers: { range: `bytes=${png.length + 10}-` },
    });
    expect(unsatisfiable.statusCode).toBe(416);

    const traversal = await context.app.inject({
      method: 'GET',
      url: '/assets/silhouettes/..%2Fhome.db',
    });
    expect(traversal.statusCode).toBe(404);
  });
});

describe('Lux3D pipeline fallback', () => {
  function failingProvider(): Lux3DProvider {
    return {
      uploadImage: async () => 'https://img.test/photo.jpg',
      createImgTo3D: async () => '42',
      waitForTask: async () => ['https://cdn/model.glb'],
      download: async () => Buffer.from('not-a-glb'),
      glbFromOutputs: (outputs) => outputs[0]!,
    };
  }

  it('marks fallback_used when the downloaded model is invalid', async () => {
    const context = await makeTestApp();
    contexts.push(context);

    const room = createRoom(context.db, { title: '测试房间', roomCode: '426918' });
    const doll = createDollWithCard(context.db, { roomId: room.room_id, name: '阿花' });
    const task = createGenTask(context.db, {
      roomId: room.room_id,
      dollId: doll.doll_id,
      provider: 'lux3d',
    });

    const config = {
      ...context.config,
      generation: { ...context.config.generation, provider: 'lux3d' as const },
    };

    await runLux3DGeneration(
      context.db,
      config,
      doll,
      task,
      Buffer.from('photo'),
      failingProvider(),
    );

    const stored = context.db
      .prepare('SELECT status, percent, fallback_used FROM gen_tasks WHERE task_id = ?')
      .get(task.task_id) as { status: string; percent: number; fallback_used: number };
    expect(stored).toMatchObject({ status: 'failed', percent: 100, fallback_used: 1 });

    const updated = context.db
      .prepare('SELECT gen_status FROM dolls WHERE doll_id = ?')
      .get(doll.doll_id) as { gen_status: string };
    expect(updated.gen_status).toBe('failed');
    expect(existsSync(join(context.config.paths.models, `${doll.doll_id}.glb`))).toBe(false);
  });
});
