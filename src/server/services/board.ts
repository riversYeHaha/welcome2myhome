import type {
  BoardDollStats,
  BoardEventView,
  BoardGuest,
  BoardSnapshot,
  BoardTimelineBucket,
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

/** Live activity chart: the last hour, five-minute buckets (FR-11 / board UI). */
export const TIMELINE_WINDOW_MIN = 60;
export const TIMELINE_BUCKET_MIN = 5;

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
    hint_requests: 0,
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
      hint_requests: 0,
      hint_guests: 0,
    });
  }

  // FR-31: guests asking for a hint are counted per card for the host.
  const hintRows = db
    .prepare(
      `SELECT doll_id, guest_id, COUNT(*) AS n
         FROM events
        WHERE room_id = ? AND type = 'hint_used'
        GROUP BY doll_id, guest_id`,
    )
    .all(room.room_id) as Array<{ doll_id: string | null; guest_id: string | null; n: number }>;
  for (const hint of hintRows) {
    totals.hint_requests += hint.n;
    if (!hint.doll_id) continue;
    const stats = dollStats.get(hint.doll_id);
    if (!stats) continue;
    stats.hint_requests += hint.n;
    stats.hint_guests += 1;
  }

  const timeline = buildTimeline(db, room.room_id);

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
    timeline,
    dolls: dolls.map((doll) => dollStats.get(doll.doll_id)!),
    guests: guestViews,
    recent_events: recent,
  };
}

function timelineLabel(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Event counts per five-minute bucket. Derived from `events` so a reconnect
 * rebuilds the same chart without storing any extra state.
 */
function buildTimeline(db: Db, roomId: string): BoardTimelineBucket[] {
  const bucketMs = TIMELINE_BUCKET_MIN * 60_000;
  const buckets = Math.ceil(TIMELINE_WINDOW_MIN / TIMELINE_BUCKET_MIN);
  const now = Date.now();
  const lastStart = Math.floor(now / bucketMs) * bucketMs;
  const firstStart = lastStart - (buckets - 1) * bucketMs;

  const empty = (): BoardTimelineBucket => ({
    start: '',
    label: '',
    scanned: 0,
    collected: 0,
    eggs: 0,
    finale: 0,
  });

  const result: BoardTimelineBucket[] = Array.from({ length: buckets }, (_unused, index) => {
    const start = new Date(firstStart + index * bucketMs);
    return {
      ...empty(),
      start: start.toISOString(),
      label: timelineLabel(start),
    };
  });

  const since = new Date(firstStart).toISOString();
  const rows = db
    .prepare(
      `SELECT type, created_at FROM events
        WHERE room_id = ?
          AND type IN ('card_scanned', 'progress', 'egg2_unlocked', 'finale_reached')
          AND created_at >= ?`,
    )
    .all(roomId, since) as Array<{ type: string; created_at: string }>;

  for (const row of rows) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at)) continue;
    const index = Math.floor((at - firstStart) / bucketMs);
    const bucket = result[index];
    if (!bucket) continue;
    if (row.type === 'card_scanned') bucket.scanned += 1;
    else if (row.type === 'progress') bucket.collected += 1;
    else if (row.type === 'egg2_unlocked') bucket.eggs += 1;
    else if (row.type === 'finale_reached') bucket.finale += 1;
  }

  return result;
}
