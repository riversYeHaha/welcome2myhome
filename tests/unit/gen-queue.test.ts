import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDoll, setDollGeneration } from '../../src/server/db/repos/dolls';
import { createGenTask, getGenTask, updateGenTask } from '../../src/server/db/repos/gen';
import { createDollWithCard } from '../../src/server/services/cards';
import { GenerationQueue } from '../../src/server/services/gen-queue';
import type { Lux3DProvider } from '../../src/server/services/generation';
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

interface FakeProvider extends Lux3DProvider {
  readonly maxActive: number;
  readonly completed: number;
}

function fakeProvider(options: { delayMs?: number; fail?: boolean } = {}): FakeProvider {
  const delay = options.delayMs ?? 15;
  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, delay));

  const enter = async (): Promise<void> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep();
  };
  const leave = (): void => {
    active -= 1;
    completed += 1;
  };

  const provider: FakeProvider = {
    get maxActive() {
      return maxActive;
    },
    get completed() {
      return completed;
    },
    async uploadImage() {
      await enter();
      if (options.fail) {
        leave();
        throw new Error('upload failed');
      }
      return 'https://example.test/photo.jpg';
    },
    async createImgTo3D() {
      return 'provider-task-1';
    },
    async waitForTask() {
      await sleep();
      return ['https://example.test/out.glb'];
    },
    glbFromOutputs() {
      return 'https://example.test/out.glb';
    },
    async download() {
      leave();
      return triangleGlb(3);
    },
  };
  return provider;
}

interface QueueFixture {
  queue: GenerationQueue;
  taskIds: string[];
  dollIds: string[];
  provider: FakeProvider;
}

async function fixture(count = 2, providerOptions = {}): Promise<{ context: TestApp; fixture: QueueFixture }> {
  const context = await makeTestApp();
  contexts.push(context);
  const host = await setupHost(context.app);

  const taskIds: string[] = [];
  const dollIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const doll = createDollWithCard(context.db, {
      roomId: host.room.room_id,
      name: `阿黄${index}`,
    });
    const photo = join(context.config.paths.photos, `${doll.doll_id}_src.jpg`);
    writeFileSync(photo, 'photo-bytes');
    const task = createGenTask(context.db, {
      roomId: host.room.room_id,
      dollId: doll.doll_id,
      provider: 'lux3d',
    });
    setDollGeneration(context.db, doll.doll_id, {
      genStatus: 'queued',
      genTaskId: task.task_id,
      sourcePhoto: photo,
    });
    taskIds.push(task.task_id);
    dollIds.push(doll.doll_id);
  }

  const provider = fakeProvider(providerOptions);
  const queue = new GenerationQueue({ db: context.db, config: context.config, provider });
  return { context, fixture: { queue, taskIds, dollIds, provider } };
}

describe('generation queue', () => {
  it('runs tasks serially and stores the resulting GLB', async () => {
    const { context, fixture: fx } = await fixture(3);
    for (const id of fx.taskIds) fx.queue.enqueue(id);
    await fx.queue.idle();

    expect(fx.provider.maxActive).toBe(1);
    for (const [index, taskId] of fx.taskIds.entries()) {
      expect(getGenTask(context.db, taskId)?.status).toBe('done');
      const model = join(context.config.paths.models, `${fx.dollIds[index]}.glb`);
      expect(existsSync(model)).toBe(true);
      expect(getDoll(context.db, fx.dollIds[index]!)?.gen_status).toBe('done');
    }
  });

  it('honours generation.concurrency when configured higher', async () => {
    const { context, fixture: fx } = await fixture(4);
    context.config.generation.concurrency = 2;
    const provider = fakeProvider();
    const queue = new GenerationQueue({
      db: context.db,
      config: context.config,
      provider,
    });
    for (const id of fx.taskIds) queue.enqueue(id);
    await queue.idle();
    expect(provider.maxActive).toBe(2);
  });

  it('re-queues a task interrupted by a restart', async () => {
    const { context, fixture: fx } = await fixture(1);
    const taskId = fx.taskIds[0]!;
    updateGenTask(context.db, taskId, {
      status: 'running',
      stage: 'generating',
      percent: 45,
      error: null,
    });

    expect(fx.queue.size).toBe(0);
    expect(fx.queue.recover()).toBe(1);
    expect(fx.queue.size).toBeGreaterThan(0);
    await fx.queue.idle();
    expect(getGenTask(context.db, taskId)?.status).toBe('done');
  });

  it('skips manual tasks that wait for a host upload', async () => {
    const { context, fixture: fx } = await fixture(1);
    updateGenTask(context.db, fx.taskIds[0]!, {
      status: 'queued',
      stage: 'awaiting_upload',
      percent: 30,
      error: null,
    });
    expect(fx.queue.recover()).toBe(0);
  });

  it('falls back when the source photo disappeared', async () => {
    const { context, fixture: fx } = await fixture(1);
    const taskId = fx.taskIds[0]!;
    context.db
      .prepare('UPDATE dolls SET source_photo = ? WHERE doll_id = ?')
      .run(join(context.dir, 'missing.jpg'), fx.dollIds[0]!);

    fx.queue.enqueue(taskId);
    await fx.queue.idle();

    const task = getGenTask(context.db, taskId);
    expect(task?.status).toBe('failed');
    expect(task?.fallback_used).toBe(1);
    expect(task?.error).toContain('照片');
  });

  it('falls back without a provider (missing API key)', async () => {
    const { context, fixture: fx } = await fixture(1);
    const queue = new GenerationQueue({ db: context.db, config: context.config, provider: null });
    queue.enqueue(fx.taskIds[0]!);
    await queue.idle();
    const task = getGenTask(context.db, fx.taskIds[0]!);
    expect(task?.status).toBe('failed');
    expect(task?.fallback_used).toBe(1);
    expect(task?.error).toContain('LUX3D_API_KEY');
  });

  it('records a failed provider run as fallback instead of throwing', async () => {
    const { context, fixture: fx } = await fixture(1, { fail: true });
    fx.queue.enqueue(fx.taskIds[0]!);
    await fx.queue.idle();
    const task = getGenTask(context.db, fx.taskIds[0]!);
    expect(task?.status).toBe('failed');
    expect(task?.fallback_used).toBe(1);
  });
});
