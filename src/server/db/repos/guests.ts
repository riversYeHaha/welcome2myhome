import { newGuestId, nowIso } from '../../lib/ids';
import type { Db } from '../index';
import type { GuestRow } from '../rows';

export interface CreateGuestInput {
  roomId: string;
  nickname: string;
  deviceHint?: string;
}

export function createGuest(db: Db, input: CreateGuestInput): GuestRow {
  const guestId = newGuestId();
  const now = nowIso();

  db.prepare(
    `INSERT INTO guests (guest_id, room_id, nickname, device_hint, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(guestId, input.roomId, input.nickname, input.deviceHint ?? '', now, now);

  return getGuest(db, guestId)!;
}

export function getGuest(db: Db, guestId: string): GuestRow | undefined {
  return db.prepare('SELECT * FROM guests WHERE guest_id = ?').get(guestId) as GuestRow | undefined;
}

export function touchGuest(db: Db, guestId: string): void {
  db.prepare('UPDATE guests SET last_seen_at = ? WHERE guest_id = ?').run(nowIso(), guestId);
}

export function listGuests(db: Db, roomId: string): GuestRow[] {
  return db
    .prepare('SELECT * FROM guests WHERE room_id = ? ORDER BY last_seen_at DESC')
    .all(roomId) as GuestRow[];
}

export function markFinaleReached(db: Db, guestId: string): void {
  const now = nowIso();
  db.prepare(
    'UPDATE guests SET finale_reached_at = COALESCE(finale_reached_at, ?), last_seen_at = ? WHERE guest_id = ?',
  ).run(now, now, guestId);
}
