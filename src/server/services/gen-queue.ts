import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { getDoll } from '../db/repos/dolls';
import { getGenTask, updateGenTask } from '../db/repos/gen';
import { applyFallbackModel, runLux3DGeneration, type Lux3DProvider } from './generation';
import { createLux3DClient } from './lux3d';

export interface GenerationQueueOptions {
  db: Db;
  config: AppConfig;
  /**
   * Injected in tests. `undefined` uses the configured Lux3D client (which is
   * `null` when no API key is present), `null` forces the no-provider path.
   */
  provider?: Lux3DProvider | null;
  log?: { info?: (obj: unknown, msg?: string) => void; warn?: (obj: unknown, msg?: string) => void };
}

/**
 * Serial in-process generation queue (tech design §5.7).
 *
 * The SQLite `gen_tasks` rows stay the source of truth: {@link recover} resets
 * tasks interrupted by a restart (`running`) or never started (`queued`) and
 * re-enqueues them, so a host restart no longer loses an in-flight Lux3D job.
 * Concurrency is configured (`generation.concurrency`, default 1) because the
 * home server only generates one doll at a time on site.
 */
export class GenerationQueue {
  private readonly pending: string[] = [];
  private readonly active = new Set<string>();
  private readonly concurrency: number;
  private readonly provider: Lux3DProvider | null;

  constructor(private readonly options: GenerationQueueOptions) {
    this.concurrency = Math.max(1, Math.min(4, options.config.generation.concurrency));
    this.provider =
      options.provider === undefined ? createLux3DClient(options.config) : options.provider;
  }

  get size(): number {
    return this.pending.length + this.active.size;
  }

  /** Put a persisted task on the queue (idempotent per task id). */
  enqueue(taskId: string): void {
    if (this.active.has(taskId) || this.pending.includes(taskId)) return;
    this.pending.push(taskId);
    this.pump();
  }

  /**
   * Re-queue tasks a previous process left behind. Manual-provider tasks that
   * wait for a host upload (`awaiting_upload`) are intentionally skipped.
   */
  recover(): number {
    const rows = this.options.db
      .prepare(
        `SELECT task_id FROM gen_tasks
          WHERE provider = 'lux3d'
            AND status IN ('running', 'queued')
            AND stage <> 'awaiting_upload'
          ORDER BY created_at ASC`,
      )
      .all() as Array<{ task_id: string }>;

    for (const row of rows) {
      updateGenTask(this.options.db, row.task_id, {
        status: 'queued',
        stage: 'requeued',
        percent: 5,
        error: null,
      });
      this.enqueue(row.task_id);
    }

    if (rows.length > 0) {
      this.options.log?.info?.({ count: rows.length }, 'requeued generation tasks after restart');
    }
    return rows.length;
  }

  /** Await the queue draining; used by tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async drain(): Promise<void> {
    await this.idle();
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const taskId = this.pending.shift()!;
      this.active.add(taskId);
      void this.run(taskId)
        .catch((error: unknown) => {
          this.options.log?.warn?.({ err: error, taskId }, 'generation queue run failed');
        })
        .finally(() => {
          this.active.delete(taskId);
          this.pump();
        });
    }
  }

  private async run(taskId: string): Promise<void> {
    const { db, config } = this.options;
    const task = getGenTask(db, taskId);
    if (!task || task.status === 'done' || task.status === 'failed') return;

    const doll = getDoll(db, task.doll_id);
    if (!doll) {
      updateGenTask(db, taskId, {
        status: 'failed',
        stage: 'failed',
        percent: 100,
        error: '人偶已删除',
        fallbackUsed: true,
      });
      return;
    }

    if (!this.provider) {
      applyFallbackModel(db, config, doll.doll_id, 'LUX3D_API_KEY 未配置，已回退预置模型', taskId);
      return;
    }

    const photoPath = doll.source_photo ?? join(config.paths.photos, `${doll.doll_id}_src.jpg`);
    if (!existsSync(photoPath)) {
      applyFallbackModel(db, config, doll.doll_id, '原始照片已丢失，请重新上传照片', taskId);
      return;
    }

    const running = updateGenTask(db, taskId, {
      status: 'running',
      stage: 'queued',
      percent: 5,
      error: null,
    });
    await runLux3DGeneration(
      db,
      config,
      doll,
      running ?? task,
      readFileSync(photoPath),
      this.provider,
    );
  }
}

export function createGenerationQueue(options: GenerationQueueOptions): GenerationQueue {
  return new GenerationQueue(options);
}
