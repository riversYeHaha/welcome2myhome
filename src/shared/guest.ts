import type { RoomStatus } from './contracts';
import type { ProgressState } from './levels';

export type CollectionEggState = 'none' | 'locked' | 'unlocked';

export interface GuestCollectionItem {
  doll_id: string;
  /** Hidden until discovered — locked slots must not leak names. */
  name: string | null;
  tagline: string | null;
  state: ProgressState;
  egg: CollectionEggState;
  star: boolean;
  discovered_at: string | null;
  story: string | null;
  thumbnail_url: string | null;
  model_url: string | null;
  secret_model_url: string | null;
}

export interface FinaleContent {
  title: string;
  body: string;
  image_url: string | null;
  model_url: string | null;
  reward_note: string;
  share_caption: string;
}

export interface GuestCollectionFinale {
  enabled: boolean;
  reached: boolean;
  remaining: number;
  content: FinaleContent | null;
}

export interface GuestCollection {
  room: {
    title: string;
    status: RoomStatus;
  };
  summary: {
    found: number;
    total: number;
    eggs: number;
  };
  finale: GuestCollectionFinale;
  items: GuestCollectionItem[];
}
