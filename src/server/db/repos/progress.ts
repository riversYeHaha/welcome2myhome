import type { ProgressState } from '../../../shared/levels';
import { nowIso } from '../../lib/ids';
import type { Db } from '../index';
import type { ProgressRow } from '../rows';

function row(
  db: Db,
  roomId: string,
  guestId: string,
  dollId: string,
): ProgressRow | undefined {
  return db
    .prepare('SELECT * FROM progress WHERE room_id = ? AND guest_id = ? AND doll_id = ?')
    .get(roomId, guestId, dollId) as ProgressRow | undefined;
}

/**
 * Mark a card as discovered. Idempotent: never downgrades a later state, and
 * keeps the first `discovered_at` timestamp.
 */
export function upsertDiscovered(
  db: Db,
  roomId: string,
  guestId: string,
  dollId: string,
): ProgressRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO progress (room_id, guest_id, doll_id, state, discovered_at, updated_at)
     VALUES (?, ?, ?, 'discovered', ?, ?)
     ON CONFLICT(room_id, guest_id, doll_id) DO UPDATE SET
       state = CASE WHEN progress.state = 'locked' THEN 'discovered' ELSE progress.state END,
       discovered_at = COALESCE(progress.discovered_at, excluded.discovered_at),
       updated_at = excluded.updated_at`,
  ).run(roomId, guestId, dollId, now, now);

  return row(db, roomId, guestId, dollId)!;
}

/** E1 finished (or skipped): locked/discovered → collected. Never downgrades. */
export function markCollected(
  db: Db,
  roomId: string,
  guestId: string,
  dollId: string,
): ProgressRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO progress
       (room_id, guest_id, doll_id, state, discovered_at, collected_at, updated_at)
     VALUES (?, ?, ?, 'collected', ?, ?, ?)
     ON CONFLICT(room_id, guest_id, doll_id) DO UPDATE SET
       state = CASE
         WHEN progress.state IN ('locked', 'discovered') THEN 'collected'
         ELSE progress.state
       END,
       discovered_at = COALESCE(progress.discovered_at, excluded.discovered_at),
       collected_at = COALESCE(progress.collected_at, excluded.collected_at),
       updated_at = excluded.updated_at`,
  ).run(roomId, guestId, dollId, now, now, now);

  return row(db, roomId, guestId, dollId)!;
}

/** Enter the optional egg quiz; only valid from `collected`. */
export function startEgg(
  db: Db,
  roomId: string,
  guestId: string,
  dollId: string,
): ProgressRow | undefined {
  db.prepare(
    `UPDATE progress SET state = 'egg_answering', updated_at = ?
     WHERE room_id = ? AND guest_id = ? AND doll_id = ? AND state = 'collected'`,
  ).run(nowIso(), roomId, guestId, dollId);
  return row(db, roomId, guestId, dollId);
}

export function recordAttempt(
  db: Db,
  roomId: string,
  guestId: string,
  dollId: string,
): ProgressRow | undefined {
  db.prepare(
    `UPDATE progress SET attempts = attempts + 1, updated_at = ?
     WHERE room_id = ? AND guest_id = ? AND doll_id = ?`,
  ).run(nowIso(), roomId, guestId, dollId);
  return row(db, roomId, guestId, dollId);
}

/** Correct answer: collected/egg_answering → egg_unlocked (idempotent). */
export function unlockEgg(
  db: Db,
  roomId: string,
  guestId: string,
  dollId: string,
): ProgressRow | undefined {
  const now = nowIso();
  db.prepare(
    `UPDATE progress SET
       state = 'egg_unlocked',
       egg_unlocked_at = COALESCE(egg_unlocked_at, ?),
       updated_at = ?
     WHERE room_id = ? AND guest_id = ? AND doll_id = ?
       AND state IN ('collected', 'egg_answering')`,
  ).run(now, now, roomId, guestId, dollId);
  return row(db, roomId, guestId, dollId);
}

/** Skip the quiz: keep the card, remember the skip, return to `collected`. */
export function skipEgg(
  db: Db,
  roomId: string,
  guestId: string,
  dollId: string,
): ProgressRow | undefined {
  db.prepare(
    `UPDATE progress SET
       egg_skipped = 1,
       state = CASE WHEN state = 'egg_answering' THEN 'collected' ELSE state END,
       updated_at = ?
     WHERE room_id = ? AND guest_id = ? AND doll_id = ?`,
  ).run(nowIso(), roomId, guestId, dollId);
  return row(db, roomId, guestId, dollId);
}

export function getProgress(
  db: Db,
  roomId: string,
  guestId: string,
  dollId: string,
): ProgressRow | undefined {
  return row(db, roomId, guestId, dollId);
}

export function listProgressForGuest(db: Db, roomId: string, guestId: string): ProgressRow[] {
  return db
    .prepare('SELECT * FROM progress WHERE room_id = ? AND guest_id = ?')
    .all(roomId, guestId) as ProgressRow[];
}

export type ProgressCounts = Record<ProgressState, number>;

const EMPTY_COUNTS: ProgressCounts = {
  locked: 0,
  discovered: 0,
  collected: 0,
  egg_answering: 0,
  egg_unlocked: 0,
};

export function countProgressStates(db: Db, roomId: string, guestId: string): ProgressCounts {
  const rows = db
    .prepare(
      'SELECT state, COUNT(*) AS n FROM progress WHERE room_id = ? AND guest_id = ? GROUP BY state',
    )
    .all(roomId, guestId) as Array<{ state: ProgressState; n: number }>;

  const counts: ProgressCounts = { ...EMPTY_COUNTS };
  for (const item of rows) counts[item.state] = item.n;
  return counts;
}
