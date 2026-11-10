import type { ProgressState } from './levels';

/** Aggregated live-board payload (tech design §5.6). Never contains answers. */
export interface BoardSnapshot {
  room: {
    room_id: string;
    room_code: string;
    title: string;
    status: 'draft' | 'live' | 'paused' | 'ended';
  };
  generated_at: string;
  online_window_sec: number;
  totals: {
    guests: number;
    online: number;
    dolls: number;
    discovered: number;
    collected: number;
    eggs: number;
    finale: number;
    wrong_attempts: number;
    hint_requests: number;
  };
  /** Last hour in 5-minute buckets, for the live activity chart. */
  timeline: BoardTimelineBucket[];
  dolls: BoardDollStats[];
  guests: BoardGuest[];
  recent_events: BoardEventView[];
}

export interface BoardDollStats {
  doll_id: string;
  name: string;
  short_code: string;
  /** Guests who opened this card at least once. */
  discovered: number;
  /** Guests who finished E1. */
  collected: number;
  /** Guests who entered the optional quiz. */
  egg_started: number;
  /** Guests who unlocked the secret. */
  egg_unlocked: number;
  wrong_attempts: number;
  guests_wrong: number;
  /** FR-31: guests asking for a hint on this card. */
  hint_requests: number;
  hint_guests: number;
}

export interface BoardGuestProgress {
  doll_id: string;
  state: ProgressState;
  attempts: number;
  egg_skipped: boolean;
}

export interface BoardGuest {
  guest_id: string;
  nickname: string;
  device_hint: string;
  online: boolean;
  last_seen_at: string;
  finale_reached_at: string | null;
  discovered: number;
  collected: number;
  eggs: number;
  wrong_attempts: number;
  progress: BoardGuestProgress[];
}

export interface BoardTimelineBucket {
  /** Bucket start, ISO (local server time labels below). */
  start: string;
  label: string;
  scanned: number;
  collected: number;
  eggs: number;
  finale: number;
}

export interface BoardEventView {
  seq: number;
  type: string;
  guest_id: string | null;
  guest_name: string | null;
  doll_id: string | null;
  doll_name: string | null;
  at: string;
  payload: Record<string, unknown>;
}

/** Real-time nudge pushed over SSE; the client re-fetches the snapshot. */
export type BoardSignal = 'progress' | 'guest_online' | 'finale';

export interface BoardStreamMessage {
  signal: BoardSignal;
  type: string;
  seq: number;
  at: string;
  guest_id: string | null;
  doll_id: string | null;
  payload: Record<string, unknown>;
}
