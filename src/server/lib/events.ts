import type { BoardSignal, BoardStreamMessage } from '../../shared/board';
import type { Db } from '../db';
import { appendEvent } from '../db/repos/events';
import type { EventRow } from '../db/rows';
import { nowIso } from './ids';

export const MAX_BOARD_STREAMS = 8;
export const BOARD_HEARTBEAT_MS = 15_000;

/**
 * Event types written to the `events` table (PRD 17 / tech design §5.10).
 * `password`, answer text, tickets, photos and full card tokens must never be
 * part of a payload: keep the whitelist in `sanitizeEventPayload` strict.
 */
export const SERVER_EVENT_TYPES = [
  'guest_join',
  'card_scanned',
  'egg_challenge_started',
  'answer_submit',
  'egg2_unlocked',
  'finale_reached',
  'progress',
  'room_status',
] as const;

/** Events the guest page reports from the browser (effects, offline, finish). */
export const CLIENT_EVENT_TYPES = [
  'egg1_played',
  'egg1_replayed',
  'session_complete',
  'network_error',
] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

const PAYLOAD_DENYLIST =
  /(answer|hash|token|ticket|password|pin|photo|secret|path|url|nickname_?raw)/i;

const MAX_PAYLOAD_STRING = 160;

/** Shallow, defensive copy: no secrets, no long strings, primitives only. */
export function sanitizeEventPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!payload) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (PAYLOAD_DENYLIST.test(key)) continue;
    if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_PAYLOAD_STRING);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    }
  }
  return out;
}

export function signalForType(type: string): BoardSignal {
  if (type === 'guest_join' || type === 'card_scanned') return 'guest_online';
  if (type === 'finale_reached' || type === 'room_status') return 'finale';
  return 'progress';
}

export type BoardListener = (message: BoardStreamMessage) => void;

/**
 * In-process fan-out for the host board. The database stays the source of
 * truth: a reconnect always re-reads the aggregate snapshot, the stream only
 * nudges the client.
 */
export class BoardHub {
  private readonly listeners = new Map<string, Set<BoardListener>>();

  subscribe(roomId: string, listener: BoardListener): () => void {
    const set = this.listeners.get(roomId) ?? new Set<BoardListener>();
    set.add(listener);
    this.listeners.set(roomId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(roomId);
    };
  }

  connectionCount(roomId: string): number {
    return this.listeners.get(roomId)?.size ?? 0;
  }

  publish(roomId: string, message: Omit<BoardStreamMessage, 'at' | 'payload'> & {
    payload?: Record<string, unknown>;
  }): void {
    const full: BoardStreamMessage = {
      ...message,
      payload: sanitizeEventPayload(message.payload),
      at: nowIso(),
    };
    for (const listener of [...(this.listeners.get(roomId) ?? [])]) {
      try {
        listener(full);
      } catch {
        // A broken stream must never break a guest request.
      }
    }
  }
}

export function createBoardHub(): BoardHub {
  return new BoardHub();
}

export interface EmitEventInput {
  roomId: string;
  type: string;
  guestId?: string | null;
  dollId?: string | null;
  payload?: Record<string, unknown>;
}

/** Persist an event and nudge the live board in one call. */
export function emitEvent(db: Db, hub: BoardHub, input: EmitEventInput): EventRow {
  const payload = sanitizeEventPayload(input.payload);
  const row = appendEvent(db, {
    roomId: input.roomId,
    type: input.type,
    guestId: input.guestId,
    dollId: input.dollId,
    payload,
  });

  hub.publish(input.roomId, {
    signal: signalForType(input.type),
    type: input.type,
    seq: row.seq,
    guest_id: row.guest_id,
    doll_id: row.doll_id,
    payload,
  });

  return row;
}

/** Broadcast a state change without writing an analytics row. */
export function emitSignal(
  hub: BoardHub,
  roomId: string,
  type: string,
  payload?: Record<string, unknown>,
): void {
  hub.publish(roomId, {
    signal: signalForType(type),
    type,
    seq: 0,
    guest_id: null,
    doll_id: null,
    payload,
  });
}
