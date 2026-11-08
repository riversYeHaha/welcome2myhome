import type { AppConfig } from '../config';
import type { Db } from '../db';
import { countProgressStates, getProgress } from '../db/repos/progress';
import type { DollRow } from '../db/rows';
import type { GuestSession } from './guest-auth';
import { signTicket } from './ticket';

export interface E1RiddleView {
  type: 'single_choice' | 'short_answer';
  question: string;
  options: string[];
  hint: string;
  wrong_text: string;
  max_attempts: number;
}

export interface E1View {
  doll_id: string;
  name: string;
  tagline: string;
  silhouette_url: string;
  level: {
    type: DollRow['level_type'];
    egg_enabled: boolean;
    e1: { effect: DollRow['e1_effect']; sound: boolean };
    next_clue: string | null;
    riddle: E1RiddleView | null;
  };
  base: {
    caption: string;
    story: string;
    model_url: string | null;
    photo_url: string | null;
  };
  progress: {
    state: 'locked' | 'discovered' | 'collected' | 'egg_answering' | 'egg_unlocked';
    attempts: number;
    egg_skipped: boolean;
  };
  ticket_ttl: number;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Build the strict E1 payload shared by the JSON API and the SSR card page.
 * Never add answer hashes, synonyms, secret content, hide hints or backup tokens.
 */
export function buildE1View(
  db: Db,
  config: AppConfig,
  secret: Buffer,
  session: GuestSession,
  doll: DollRow,
): E1View {
  const ticket = signTicket(secret, {
    scope: 'base',
    dollId: doll.doll_id,
    guestId: session.guestId,
    ttlSec: config.ticket.ttlSec,
  });

  const progress = getProgress(db, doll.room_id, session.guestId, doll.doll_id);
  const options = parseStringArray(doll.options_json);
  const riddleEnabled =
    doll.egg_enabled === 1 && doll.question.trim().length > 0 && doll.riddle_type !== null;

  const assetUrl = (kind: 'base-model' | 'photo'): string | null => {
    const exists = kind === 'base-model' ? doll.base_model_url : doll.base_photo_url;
    if (!exists) return null;
    return `/api/assets/${encodeURIComponent(doll.doll_id)}/${kind}?t=${encodeURIComponent(ticket)}`;
  };

  return {
    doll_id: doll.doll_id,
    name: doll.name,
    tagline: doll.tagline,
    silhouette_url: doll.silhouette_url,
    level: {
      type: doll.level_type,
      egg_enabled: riddleEnabled,
      e1: { effect: doll.e1_effect, sound: doll.e1_sound === 1 },
      next_clue: doll.next_clue,
      riddle: riddleEnabled
        ? {
            type: doll.riddle_type ?? 'short_answer',
            question: doll.question,
            options,
            hint: doll.hint,
            wrong_text: doll.wrong_text,
            max_attempts: doll.max_attempts,
          }
        : null,
    },
    base: {
      caption: doll.base_caption,
      story: doll.base_story,
      model_url: assetUrl('base-model'),
      photo_url: assetUrl('photo'),
    },
    progress: {
      state: progress?.state ?? 'locked',
      attempts: progress?.attempts ?? 0,
      egg_skipped: progress?.egg_skipped === 1,
    },
    ticket_ttl: config.ticket.ttlSec,
  };
}

export interface CollectionSummary {
  total: number;
  found: number;
  collected: number;
  eggs: number;
  remaining: number;
}

/** Counts for one guest; `found` includes discovered-but-not-collected cards. */
export function collectionSummary(
  db: Db,
  roomId: string,
  guestId: string,
): CollectionSummary {
  const { n: total } = db
    .prepare('SELECT COUNT(*) AS n FROM dolls WHERE room_id = ?')
    .get(roomId) as { n: number };

  const counts = countProgressStates(db, roomId, guestId);
  const collected = counts.collected + counts.egg_answering + counts.egg_unlocked;
  const found = collected + counts.discovered;

  return {
    total,
    found,
    collected,
    eggs: counts.egg_unlocked,
    remaining: Math.max(0, total - collected),
  };
}
