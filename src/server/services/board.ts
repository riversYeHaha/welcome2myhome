import type {
  BoardDollStats,
  BoardEventView,
  BoardGuest,
  BoardSnapshot,
} from '../../shared/board';
import type { ProgressState } from '../../shared/levels';
import type { Db } from '../db';
import { listGuests } from '../db/repos/guests';
import { listEvents } from '../db/repos/events';
import type { RoomRow } from '../db/rows';
import { nowIso } from '../lib/ids';
import { sanitizeEventPayload } from '../lib/events';

/** A guest counts as "online" when seen within this window. */
export const ONLINE_WINDOW_SEC = 120;
/** How many recent analytics rows the board shows / exports inline. */
export const RECENT_EVENT_LIMIT = 40;

const COLLECTED_STATES: ReadonlySet<ProgressState> = new Set<ProgressState>([
  'collected',
  'egg_answering',
  'egg_unlocked',
]);

const EGG_STATES: ReadonlySet<ProgressState> = new Set<ProgressState>(['egg_answering', 'egg_unlocked']);

interface ProgressRowLite {
  guest_id: string;
  doll_id: string;
  state: ProgressState;
  attempts: number;
  egg_skipped: number;
}

interface DollRowLite {
  doll_id: string;
  name: string;
  short_code: string;
}

function parsePayload(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? sanitizeEventPayload(parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Aggregate one room for the host board. Everything is derived from the
 * database so a reconnect after a dropped SSE stream shows the same numbers.
 */
export function boardSnapshot(db: Db, room: RoomRow): BoardSnapshot {
  const dolls = db
    .prepare(
      `SELECT doll_id, name, short_code FROM dolls WHERE room_id = ? ORDER BY sort_order, created_at`,
    )
    .all(room.room_id) as DollRowLite[];

  const guests = listGuests(db, room.room_id);

  const rows = db
    .prepare(
      `SELECT guest_id, doll_id, state, attempts, egg_skipped
         FROM progress WHERE room_id = ?`,
    )
    .all(room.room_id) as ProgressRowLite[];

  const byGuest = new Map<string, Map<string, ProgressRowLite>>();
  for (const row of rows) {
    const inner = byGuest.get(row.guest_id) ?? new Map<string, ProgressRowLite>();
    inner.set(row.doll_id, row);
    byGuest.set(row.guest_id, inner);
  }

  const now = Date.now();
  const totals = {
    guests: guests.length,
    online: 0,
    dolls: dolls.length,
    discovered: rows.filter((row) => row.state !== 'locked').length,
    collected: rows.filter((row) => COLLECTED_STATES.has(row.state)).length,
    eggs: rows.filter((row) => row.state === 'egg_unlocked').length,
    finale: guests.filter((guest) => Boolean(guest.finale_reached_at)).length,
    wrong_attempts: rows.reduce((sum, row) => sum + (row.attempts ?? 0), 0),
  };

  const dollStats = new Map<string, BoardDollStats>();
  for (const doll of dolls) {
    dollStats.set(doll.doll_id, {
      doll_id: doll.doll_id,
      name: doll.name,
      short_code: doll.short_code,
      discovered: 0,
      collected: 0,
      egg_started: 0,
      egg_unlocked: 0,
      wrong_attempts: 0,
      guests_wrong: 0,
    });
  }

  for (const row of rows) {
    const stats = dollStats.get(row.doll_id);
    if (!stats) continue;
    if (row.state !== 'locked') stats.discovered += 1;
    if (COLLECTED_STATES.has(row.state)) stats.collected += 1;
    if (EGG_STATES.has(row.state)) stats.egg_started += 1;
    if (row.state === 'egg_unlocked') stats.egg_unlocked += 1;
    if (row.attempts > 0) {
      stats.wrong_attempts += row.attempts;
      stats.guests_wrong += 1;
    }
  }

  const guestViews: BoardGuest[] = guests.map((guest) => {
    const inner = byGuest.get(guest.guest_id);
    const progress = dolls.map((doll) => {
      const row = inner?.get(doll.doll_id);
      return {
        doll_id: doll.doll_id,
        state: row?.state ?? ('locked' as ProgressState),
        attempts: row?.attempts ?? 0,
        egg_skipped: row?.egg_skipped === 1,
      };
    });

    const discovered = progress.filter((item) => item.state !== 'locked').length;
    const collected = progress.filter((item) => COLLECTED_STATES.has(item.state)).length;
    const eggs = progress.filter((item) => item.state === 'egg_unlocked').length;
    const lastSeen = Date.parse(guest.last_seen_at);
    const online = Number.isFinite(lastSeen) && now - lastSeen <= ONLINE_WINDOW_SEC * 1000;
    if (online) totals.online += 1;

    return {
      guest_id: guest.guest_id,
      nickname: guest.nickname,
      device_hint: guest.device_hint,
      online,
      last_seen_at: guest.last_seen_at,
      finale_reached_at: guest.finale_reached_at,
      discovered,
      collected,
      eggs,
      wrong_attempts: progress.reduce((sum, item) => sum + item.attempts, 0),
      progress,
    };
  });

  const guestNames = new Map(guests.map((guest) => [guest.guest_id, guest.nickname]));
  const dollNames = new Map(dolls.map((doll) => [doll.doll_id, doll.name]));

  const recent: BoardEventView[] = listEvents(db, room.room_id, RECENT_EVENT_LIMIT).map((row) => ({
    seq: row.seq,
    type: row.type,
    guest_id: row.guest_id,
    guest_name: row.guest_id ? (guestNames.get(row.guest_id) ?? null) : null,
    doll_id: row.doll_id,
    doll_name: row.doll_id ? (dollNames.get(row.doll_id) ?? null) : null,
    at: row.created_at,
    payload: parsePayload(row.payload_json),
  }));

  return {
    room: {
      room_id: room.room_id,
      room_code: room.room_code,
      title: room.title,
      status: room.status,
    },
    generated_at: nowIso(),
    online_window_sec: ONLINE_WINDOW_SEC,
    totals,
    dolls: dolls.map((doll) => dollStats.get(doll.doll_id)!),
    guests: guestViews,
    recent_events: recent,
  };
}
