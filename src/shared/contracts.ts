/**
 * Shared wire contracts between server and web clients.
 * Keep this file dependency-free: it is imported by both Node and browser builds.
 */

/** Uniform error envelope returned by every JSON API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    requestId?: string;
  };
}

/** `GET /api/health` — public, carries no room or guest information. */
export interface HealthResponse {
  ok: boolean;
  name: 'welcome2myhome';
  version: string;
  uptimeSec: number;
  db: {
    ok: boolean;
    schemaVersion: number | null;
  };
  time: string;
}

/** Room lifecycle, mirrored in `rooms.status` (PRD v3 §13). */
export type RoomStatus = 'draft' | 'live' | 'paused' | 'ended';
