import { z } from 'zod';
import {
  DEFAULT_FINALE,
  type FinaleConfig,
  type FinaleTrigger,
} from '../../shared/finale';
import type { Db } from '../db';
import type { RoomRow } from '../db/rows';
import { collectionSummary, type CollectionSummary } from './play';

const TriggerSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('all_collected'), value: z.number().nullable().optional() })
    .strict(),
  z
    .object({ type: z.literal('count_gte'), value: z.number().int().min(1) })
    .strict(),
  z
    .object({ type: z.literal('all_eggs'), value: z.number().nullable().optional() })
    .strict(),
  z.object({ type: z.literal('manual'), value: z.number().nullable().optional() }).strict(),
]);

const ConfigSchema = z
  .object({
    enabled: z.boolean(),
    trigger: TriggerSchema,
    title: z.string().max(80),
    body: z.string().max(1000),
    image_url: z.string().max(300).nullable(),
    model_url: z.string().max(300).nullable(),
    reward_note: z.string().max(200),
    share_caption: z.string().max(200),
    opened_at: z.string().nullable(),
  })
  .strict();

export const FinaleInputSchema = ConfigSchema.omit({ opened_at: true });

type TriggerInput = z.infer<typeof TriggerSchema>;

function normalizeTrigger(trigger: TriggerInput): FinaleTrigger {
  return {
    type: trigger.type,
    value: trigger.type === 'count_gte' ? Number(trigger.value) : null,
  };
}

function normalizeConfig(config: z.infer<typeof ConfigSchema>): FinaleConfig {
  return {
    ...config,
    trigger: normalizeTrigger(config.trigger),
  };
}

/** Parse stored JSON; any malformed value falls back to the friendly default. */
export function parseFinaleConfig(json: string): FinaleConfig {
  try {
    const raw = JSON.parse(json) as unknown;
    const base = isRecord(raw) ? raw : {};
    const merged = {
      ...DEFAULT_FINALE,
      ...base,
      trigger: isRecord(base.trigger) ? base.trigger : DEFAULT_FINALE.trigger,
    };
    const parsed = ConfigSchema.safeParse(merged);
    return parsed.success ? normalizeConfig(parsed.data) : DEFAULT_FINALE;
  } catch {
    return DEFAULT_FINALE;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface FinaleEvaluation {
  reached: boolean;
  progress: CollectionSummary & { remaining: number };
  config: FinaleConfig;
}

interface EggStats {
  total: number;
  unlocked: number;
}

function eggStats(db: Db, roomId: string, guestId: string): EggStats {
  const row = db
    .prepare(
      `SELECT
         COUNT(d.doll_id) AS total,
         COALESCE(SUM(CASE WHEN p.state = 'egg_unlocked' THEN 1 ELSE 0 END), 0) AS unlocked
       FROM dolls d
       LEFT JOIN progress p
         ON p.doll_id = d.doll_id AND p.room_id = d.room_id AND p.guest_id = ?
       WHERE d.room_id = ? AND d.egg_enabled = 1 AND d.question <> ''`,
    )
    .get(guestId, roomId) as { total: number; unlocked: number };

  return { total: row.total, unlocked: row.unlocked };
}

/**
 * Evaluate the host-configured finale for one guest. Single-player semantics:
 * never reads another guest's progress.
 */
export function evaluateFinale(
  db: Db,
  room: RoomRow,
  guestId: string,
): FinaleEvaluation {
  const config = parseFinaleConfig(room.finale_json);
  const summary = collectionSummary(db, room.room_id, guestId);
  const progress = { ...summary, remaining: summary.remaining };

  if (!config.enabled) return { reached: false, progress, config };

  const allCollected = summary.total > 0 && summary.collected >= summary.total;
  let reached = false;

  switch (config.trigger.type) {
    case 'all_collected':
      reached = allCollected;
      break;
    case 'count_gte':
      reached = summary.collected >= (config.trigger.value ?? Number.POSITIVE_INFINITY);
      break;
    case 'all_eggs': {
      const eggs = eggStats(db, room.room_id, guestId);
      // With no egg quizzes configured, hard mode degrades to all_collected.
      reached = allCollected && (eggs.total === 0 || eggs.unlocked >= eggs.total);
      break;
    }
    case 'manual':
      reached = Boolean(config.opened_at);
      break;
  }

  return { reached, progress, config };
}

export function finaleContent(config: FinaleConfig) {
  return {
    title: config.title,
    body: config.body,
    image_url: config.image_url,
    model_url: config.model_url,
    reward_note: config.reward_note,
    share_caption: config.share_caption,
  };
}

/** Number of dolls in a room; used to validate `count_gte`. */
export function dollCount(db: Db, roomId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM dolls WHERE room_id = ?').get(roomId) as {
      n: number;
    }
  ).n;
}

/** Number of cards that actually carry an egg quiz. */
export function eggQuizDollCount(db: Db, roomId: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM dolls WHERE room_id = ? AND egg_enabled = 1 AND question <> ''",
      )
      .get(roomId) as { n: number }
  ).n;
}
