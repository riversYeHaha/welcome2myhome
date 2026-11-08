import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getGenTask } from '../../src/server/db/repos/gen';
import { createGenTask } from '../../src/server/db/repos/gen';
import { createDollWithCard } from '../../src/server/services/cards';
import { createRoom } from '../../src/server/db/repos/rooms';
import { runLux3DGeneration, type Lux3DProvider } from '../../src/server/services/generation';
import { makeTestApp, type TestApp } from '../helpers/test-app';
import { triangleGlb } from '../helpers/glb';

const contexts: TestApp[] = [];

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.app.close();
    context.db.close();
    rmSync(context.dir, { recursive: true, force: true });
  }
});

function fakeProvider(overrides: Partial<Lux3DProvider> = {}): Lux3DProvider {
  return {
    uploadImage: async () => 'https://img.test/photo.jpg',
    createImgTo3D: async () => '42',
    waitForTask: async () => ['https://cdn/model.glb'],
    download: async () => triangleGlb(2),
    glbFromOutputs: (outputs) => outputs[0]!,
    ...overrides,
  };
}

describe('Lux3D generation runner', () => {
  it('stores the generated GLB and completes the task', async () => {
    const context = await makeTestApp();
    contexts.push(context);

    const room = createRoom(context.db, { title: '测试房间', roomCode: '426918' });
    const doll = createDollWithCard(context.db, { roomId: room.room_id, name: '阿黄' });
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
      fakeProvider(),
    );

    const done = getGenTask(context.db, task.task_id);
    expect(done).toMatchObject({ status: 'done', stage: 'done', percent: 100 });
    expect(existsSync(join(context.config.paths.models, `${doll.doll_id}.glb`))).toBe(true);

    const updated = context.db
      .prepare('SELECT gen_status, base_model_url FROM dolls WHERE doll_id = ?')
      .get(doll.doll_id) as { gen_status: string; base_model_url: string };
    expect(updated.gen_status).toBe('done');
    expect(updated.base_model_url).toBe(`/assets/models/${doll.doll_id}.glb`);
  });

  it('marks the task and doll as failed when the provider errors', async () => {
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
      fakeProvider({ uploadImage: async () => Promise.reject(new Error('上传失败')) }),
    );

    expect(getGenTask(context.db, task.task_id)).toMatchObject({
      status: 'failed',
      percent: 100,
      error: '上传失败',
    });

    const updated = context.db
      .prepare('SELECT gen_status FROM dolls WHERE doll_id = ?')
      .get(doll.doll_id) as { gen_status: string };
    expect(updated.gen_status).toBe('failed');
  });
});
