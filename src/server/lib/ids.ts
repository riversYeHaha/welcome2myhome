import { randomInt } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Random base62 string, used for opaque ids and (later) card tokens. */
export function randomBase62(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += BASE62[randomInt(0, BASE62.length)];
  }
  return out;
}

/** Six-digit numeric room code (PRD v3 §5.1). Never starts with 0. */
export function generateRoomCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

export function newRoomId(): string {
  return `r_${randomBase62(8)}`;
}

export function newGuestId(): string {
  return `g_${randomBase62(12)}`;
}

export function newDollId(): string {
  return `d_${randomBase62(8)}`;
}

export function newAssetId(): string {
  return `a_${randomBase62(12)}`;
}

export function newTaskId(): string {
  return `t_${randomBase62(12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
