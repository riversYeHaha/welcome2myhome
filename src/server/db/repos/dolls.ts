import type { E1Effect, LevelType } from '../../../shared/levels';
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
  baseStory?: string;
  baseCaption?: string;
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
       name = ?, tagline = ?, silhouette_url = ?, clue = ?, hide_hint = ?,
       base_story = ?, base_caption = ?, updated_at = ?
     WHERE doll_id = ?`,
  ).run(
    patch.name ?? current.name,
    patch.tagline ?? current.tagline,
    patch.silhouetteUrl ?? current.silhouette_url,
    patch.clue ?? current.clue,
    patch.hideHint ?? current.hide_hint,
    patch.baseStory ?? current.base_story,
    patch.baseCaption ?? current.base_caption,
    nowIso(),
    dollId,
  );

  return getDoll(db, dollId);
}

export interface DollLevelUpdate {
  levelType: LevelType;
  nextClue: string | null;
  eggEnabled: boolean;
  e1Effect: E1Effect;
  e1Sound: boolean;
  riddleType: 'single_choice' | 'short_answer' | null;
  question: string;
  optionsJson: string;
  hint: string;
  wrongText: string;
  maxAttempts: number;
  answerHash: string;
  synonymsJson: string;
  secretModelUrl: string | null;
  secretStory: string;
  secretWhisper: string;
  secretEffect: string;
  secretStar: boolean;
}

/** Persist the full level/riddle/secret configuration (T904). */
export function updateDollLevel(
  db: Db,
  dollId: string,
  update: DollLevelUpdate,
): DollRow | undefined {
  const current = getDoll(db, dollId);
  if (!current) return undefined;

  db.prepare(
    `UPDATE dolls SET
       level_type = ?, next_clue = ?, egg_enabled = ?, e1_effect = ?, e1_sound = ?,
       riddle_type = ?, question = ?, options_json = ?, hint = ?, wrong_text = ?,
       max_attempts = ?, answer_hash = ?, synonyms_json = ?,
       secret_model_url = ?, secret_story = ?, secret_whisper = ?,
       secret_effect = ?, secret_star = ?, updated_at = ?
     WHERE doll_id = ?`,
  ).run(
    update.levelType,
    update.nextClue,
    update.eggEnabled ? 1 : 0,
    update.e1Effect,
    update.e1Sound ? 1 : 0,
    update.riddleType,
    update.question,
    update.optionsJson,
    update.hint,
    update.wrongText,
    update.maxAttempts,
    update.answerHash,
    update.synonymsJson,
    update.secretModelUrl,
    update.secretStory,
    update.secretWhisper,
    update.secretEffect,
    update.secretStar ? 1 : 0,
    nowIso(),
    dollId,
  );

  return getDoll(db, dollId);
}

export interface DollGenerationPatch {
  genStatus?: DollRow['gen_status'];
  genTaskId?: string | null;
  sourcePhoto?: string | null;
  baseModelUrl?: string;
  silhouetteUrl?: string;
}

/** Persist generation bookkeeping fields without touching level content. */
export function setDollGeneration(
  db: Db,
  dollId: string,
  patch: DollGenerationPatch,
): DollRow | undefined {
  const current = getDoll(db, dollId);
  if (!current) return undefined;

  db.prepare(
    `UPDATE dolls SET
       gen_status = ?, gen_task_id = ?, source_photo = ?,
       base_model_url = ?, silhouette_url = ?, updated_at = ?
     WHERE doll_id = ?`,
  ).run(
    patch.genStatus ?? current.gen_status,
    patch.genTaskId === undefined ? current.gen_task_id : patch.genTaskId,
    patch.sourcePhoto === undefined ? current.source_photo : patch.sourcePhoto,
    patch.baseModelUrl ?? current.base_model_url,
    patch.silhouetteUrl ?? current.silhouette_url,
    nowIso(),
    dollId,
  );

  return getDoll(db, dollId);
}
