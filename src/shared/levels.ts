/**
 * Level / room enumerations from PRD v3 §7.
 * Values are persisted in SQLite `CHECK` constraints — never rename without a migration.
 */

export const GAME_MODES = ['solo', 'race', 'coop'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export const LEVEL_TYPES = [
  'discovery',
  'bonus_quiz',
  'clue_chain',
  'duo_scan',
  'timed',
] as const;
export type LevelType = (typeof LEVEL_TYPES)[number];

/** Only these are selectable for P0; the rest are reserved (greyed out in the host UI). */
export const P0_LEVEL_TYPES = ['discovery', 'bonus_quiz'] as const satisfies readonly LevelType[];

export const E1_EFFECTS = ['starlight', 'confetti', 'bubbles', 'sparks'] as const;
export type E1Effect = (typeof E1_EFFECTS)[number];

/** Progress states per guest × doll (PRD v3 §13). */
export const PROGRESS_STATES = [
  'locked',
  'discovered',
  'collected',
  'egg_answering',
  'egg_unlocked',
] as const;
export type ProgressState = (typeof PROGRESS_STATES)[number];

/**
 * P0 validation: `discovery` has no riddle and no egg; `bonus_quiz` may still
 * disable its egg (card only plays E1). P2 types are rejected on interactive
 * submit and downgraded to `discovery` when read from stored/imported config.
 */
export function isLevelTypeAvailableForP0(level: LevelType): boolean {
  return level === 'discovery' || level === 'bonus_quiz';
}
