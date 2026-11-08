import type { AppConfig } from '../config';
import type { Db } from '../db';
import { markFinaleReached } from '../db/repos/guests';
import { listDolls } from '../db/repos/dolls';
import { getProgress } from '../db/repos/progress';
import { getRoomById } from '../db/repos/rooms';
import { evaluateFinale, finaleContent, parseFinaleConfig } from './finale';
import { collectionSummary } from './play';
import { signTicket } from './ticket';
import type { GuestSession } from './guest-auth';
import type { GuestCollection, GuestCollectionItem } from '../../shared/guest';

/**
 * Build the per-guest collection. Locked slots intentionally expose only the
 * doll id and a silhouette placeholder; names/stories stay hidden.
 */
export function buildCollection(
  db: Db,
  config: AppConfig,
  secret: Buffer,
  session: GuestSession,
): GuestCollection {
  const room = getRoomById(db, session.roomId);
  if (!room) throw new Error('room missing for guest session');

  const items: GuestCollectionItem[] = listDolls(db, room.room_id).map((doll) => {
    const progress = getProgress(db, room.room_id, session.guestId, doll.doll_id);
    const state = progress?.state ?? 'locked';

    if (state === 'locked') {
      return {
        doll_id: doll.doll_id,
        name: null,
        tagline: null,
        state,
        egg: 'none',
        star: false,
        discovered_at: null,
        story: null,
        thumbnail_url: null,
        model_url: null,
        secret_model_url: null,
      };
    }

    const baseTicket = signTicket(secret, {
      scope: 'base',
      dollId: doll.doll_id,
      guestId: session.guestId,
      ttlSec: config.ticket.ttlSec,
    });

    const eggEnabled = doll.egg_enabled === 1 && doll.question !== '';
    const egg: GuestCollectionItem['egg'] = !eggEnabled
      ? 'none'
      : state === 'egg_unlocked'
        ? 'unlocked'
        : 'locked';

    let secretModelUrl: string | null = null;
    if (egg === 'unlocked' && doll.secret_model_url) {
      const secretTicket = signTicket(secret, {
        scope: 'secret',
        dollId: doll.doll_id,
        guestId: session.guestId,
        ttlSec: config.ticket.ttlSec,
      });
      secretModelUrl = `/api/assets/${encodeURIComponent(doll.doll_id)}/secret-model?t=${encodeURIComponent(secretTicket)}`;
    }

    return {
      doll_id: doll.doll_id,
      name: doll.name,
      tagline: doll.tagline,
      state,
      egg,
      star: egg === 'unlocked' && doll.secret_star === 1,
      discovered_at: progress?.discovered_at ?? null,
      story: doll.base_story,
      thumbnail_url: doll.silhouette_url || null,
      model_url: doll.base_model_url
        ? `/api/assets/${encodeURIComponent(doll.doll_id)}/base-model?t=${encodeURIComponent(baseTicket)}`
        : null,
      secret_model_url: secretModelUrl,
    };
  });

  const summary = collectionSummary(db, room.room_id, session.guestId);
  const evaluation = evaluateFinale(db, room, session.guestId);
  if (evaluation.reached) markFinaleReached(db, session.guestId);

  const finaleConfig = parseFinaleConfig(room.finale_json);

  return {
    room: { title: room.title, status: room.status },
    summary: {
      found: summary.found,
      total: summary.total,
      eggs: summary.eggs,
    },
    finale: {
      enabled: finaleConfig.enabled,
      reached: evaluation.reached,
      remaining: evaluation.progress.remaining,
      content: evaluation.reached ? finaleContent(finaleConfig) : null,
    },
    items,
  };
}
