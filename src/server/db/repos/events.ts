import { nowIso } from '../../lib/ids';
import type { Db } from '../index';
import type { EventRow } from '../rows';

export interface AppendEventInput {
  roomId: string;
  type: string;
  guestId?: string | null;
  dollId?: string | null;
  payload?: Record<string, unknown>;
}

/** Local analytics only; never log answer text, photos or full tokens here. */
export function appendEvent(db: Db, input: AppendEventInput): EventRow {
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO events (room_id, guest_id, doll_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.roomId,
      input.guestId ?? null,
      input.dollId ?? null,
      input.type,
      JSON.stringify(input.payload ?? {}),
      now,
    );

  return db.prepare('SELECT * FROM events WHERE seq = ?').get(result.lastInsertRowid) as EventRow;
}

export function listEvents(db: Db, roomId: string, limit = 100): EventRow[] {
  return db
    .prepare('SELECT * FROM events WHERE room_id = ? ORDER BY seq DESC LIMIT ?')
    .all(roomId, limit) as EventRow[];
}

/** Full history for the JSONL replay export (host-only, local). */
export function listAllEvents(db: Db, roomId: string, limit = 50_000): EventRow[] {
  return db
    .prepare('SELECT * FROM events WHERE room_id = ? ORDER BY seq ASC LIMIT ?')
    .all(roomId, limit) as EventRow[];
}
