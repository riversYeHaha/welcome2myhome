import { newTaskId, nowIso } from '../../lib/ids';
import type { Db } from '../index';
import type { GenTaskRow } from '../rows';

export interface CreateGenTaskInput {
  roomId: string;
  dollId: string;
  provider?: string;
}

export function createGenTask(db: Db, input: CreateGenTaskInput): GenTaskRow {
  const taskId = newTaskId();
  const now = nowIso();

  db.prepare(
    `INSERT INTO gen_tasks
       (task_id, room_id, doll_id, status, stage, percent, provider, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 'queued', 0, ?, ?, ?)`,
  ).run(taskId, input.roomId, input.dollId, input.provider ?? '', now, now);

  return getGenTask(db, taskId)!;
}

export function getGenTask(db: Db, taskId: string): GenTaskRow | undefined {
  return db.prepare('SELECT * FROM gen_tasks WHERE task_id = ?').get(taskId) as
    | GenTaskRow
    | undefined;
}

export interface GenTaskPatch {
  status?: GenTaskRow['status'];
  stage?: string;
  percent?: number;
  error?: string | null;
  fallbackUsed?: boolean;
}

export function updateGenTask(
  db: Db,
  taskId: string,
  patch: GenTaskPatch,
): GenTaskRow | undefined {
  const current = getGenTask(db, taskId);
  if (!current) return undefined;

  db.prepare(
    `UPDATE gen_tasks SET
       status = ?, stage = ?, percent = ?, error = ?, fallback_used = ?, updated_at = ?
     WHERE task_id = ?`,
  ).run(
    patch.status ?? current.status,
    patch.stage ?? current.stage,
    patch.percent ?? current.percent,
    patch.error === undefined ? current.error : patch.error,
    patch.fallbackUsed === undefined ? current.fallback_used : patch.fallbackUsed ? 1 : 0,
    nowIso(),
    taskId,
  );

  return getGenTask(db, taskId);
}
