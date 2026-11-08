import type { LevelType } from '../../../shared/levels';
import { newDollId, nowIso } from '../../lib/ids';
import type { Db } from '../index';
import type { DollRow } from '../rows';

export interface CreateDollInput {
  roomId: string;
  name: string;
  /** Produced by the card service (T301); unique per room. */
  cardToken: string;
  shortCode: string;
  tagline?: string;
  silhouetteUrl?: string;
  levelType?: LevelType;
}

export function createDoll(db: Db, input: CreateDollInput): DollRow {
  const dollId = newDollId();
  const now = nowIso();
  const { next } = db
    .prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM dolls WHERE room_id = ?',
    )
    .get(input.roomId) as { next: number };

  db.prepare(
    `INSERT INTO dolls
       (doll_id, room_id, name, tagline, sort_order, card_token, short_code,
        silhouette_url, level_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    dollId,
    input.roomId,
    input.name,
    input.tagline ?? '',
    next,
    input.cardToken,
    input.shortCode,
    input.silhouetteUrl ?? '',
    input.levelType ?? 'bonus_quiz',
    now,
    now,
  );

  return getDoll(db, dollId)!;
}

export function getDoll(db: Db, dollId: string): DollRow | undefined {
  return db.prepare('SELECT * FROM dolls WHERE doll_id = ?').get(dollId) as DollRow | undefined;
}

export function getDollByToken(db: Db, cardToken: string): DollRow | undefined {
  return db.prepare('SELECT * FROM dolls WHERE card_token = ?').get(cardToken) as
    | DollRow
    | undefined;
}

export function getDollByShortCode(db: Db, shortCode: string): DollRow | undefined {
  return db.prepare('SELECT * FROM dolls WHERE short_code = ?').get(shortCode) as
    | DollRow
    | undefined;
}

/** Resolve either the primary or the backup card token (T303). */
export function getDollByAnyToken(db: Db, token: string): DollRow | undefined {
  return db
    .prepare('SELECT * FROM dolls WHERE card_token = ? OR card_token_backup = ?')
    .get(token, token) as DollRow | undefined;
}

export function setDollBackupToken(
  db: Db,
  dollId: string,
  token: string,
): DollRow | undefined {
  db.prepare('UPDATE dolls SET card_token_backup = ?, updated_at = ? WHERE doll_id = ?').run(
    token,
    nowIso(),
    dollId,
  );
  return getDoll(db, dollId);
}

export function listDolls(db: Db, roomId: string): DollRow[] {
  return db
    .prepare('SELECT * FROM dolls WHERE room_id = ? ORDER BY sort_order ASC, created_at ASC')
    .all(roomId) as DollRow[];
}

export function deleteDoll(db: Db, dollId: string): boolean {
  const result = db.prepare('DELETE FROM dolls WHERE doll_id = ?').run(dollId);
  return result.changes > 0;
}

export interface DollBasicsPatch {
  name?: string;
  tagline?: string;
  silhouetteUrl?: string;
  clue?: string;
  hideHint?: string;
}

/** Edits the host-facing base fields; level/riddle edits land in T904. */
export function updateDollBasics(
  db: Db,
  dollId: string,
  patch: DollBasicsPatch,
): DollRow | undefined {
  const current = getDoll(db, dollId);
  if (!current) return undefined;

  db.prepare(
    `UPDATE dolls SET
       name = ?, tagline = ?, silhouette_url = ?, clue = ?, hide_hint = ?, updated_at = ?
     WHERE doll_id = ?`,
  ).run(
    patch.name ?? current.name,
    patch.tagline ?? current.tagline,
    patch.silhouetteUrl ?? current.silhouette_url,
    patch.clue ?? current.clue,
    patch.hideHint ?? current.hide_hint,
    nowIso(),
    dollId,
  );

  return getDoll(db, dollId);
}
