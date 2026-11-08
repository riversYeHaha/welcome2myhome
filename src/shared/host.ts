import type { RoomStatus } from './contracts';
import type { FinaleConfig } from './finale';
import type { E1Effect, GameMode, LevelType } from './levels';

/** Sanitized doll shape returned to the host SPA (never includes answer_hash). */
export interface HostDoll {
  doll_id: string;
  room_id: string;
  name: string;
  tagline: string;
  sort_order: number;
  card_token: string;
  short_code: string;
  clue: string;
  hide_hint: string;
  silhouette_url: string;
  level_type: LevelType;
  next_clue: string | null;
  egg_enabled: boolean;
  e1_effect: E1Effect;
  e1_sound: boolean;
  riddle_type: 'single_choice' | 'short_answer' | null;
  question: string;
  options: string[];
  hint: string;
  wrong_text: string;
  max_attempts: number;
  answer_configured: boolean;
  synonyms: string[];
  base_story: string;
  base_caption: string;
  base_model_url: string;
  base_photo_url: string;
  secret_model_url: string | null;
  secret_story: string;
  secret_whisper: string;
  secret_effect: string;
  secret_star: boolean;
  gen_status: 'preset' | 'queued' | 'running' | 'done' | 'failed';
}

export interface HostRoom {
  room_id: string;
  room_code: string;
  title: string;
  status: RoomStatus;
  game_mode: GameMode;
  default_level_type: LevelType;
  lan_ip: string;
  port: number;
  finale: FinaleConfig;
}

export interface HostRoomDetail {
  room: HostRoom;
  dolls: HostDoll[];
}

/** Host self check (FR-01/FR-21): LAN reachability and configuration readiness. */
export interface SelfCheckItem {
  id: string;
  label: string;
  ok: boolean;
  hint?: string;
}

export interface SelfCheckResult {
  room: {
    room_id: string;
    room_code: string;
    title: string;
    status: string;
    lan_ip: string;
    port: number;
  };
  server: {
    node: string;
    platform: string;
    uptime_sec: number;
    port: number;
    host: string;
  };
  network: {
    lan_ip: string;
    detected_ip: string | null;
    urls: Array<{ label: string; url: string }>;
    hint: string;
  };
  data: {
    db_bytes: number;
    photos_bytes: number;
    models_bytes: number;
    dolls: number;
    guests: number;
    events: number;
    missing_assets: number;
  };
  checks: SelfCheckItem[];
}

export interface ClearSummary {
  progress: number;
  guests: number;
  events: number;
  gen_tasks: number;
  assets: number;
  files: number;
  bytes: number;
}
