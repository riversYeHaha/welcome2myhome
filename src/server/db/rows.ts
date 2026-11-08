import type { RoomStatus } from '../../shared/contracts';
import type { E1Effect, GameMode, LevelType, ProgressState } from '../../shared/levels';

export interface RoomRow {
  room_id: string;
  room_code: string;
  title: string;
  host_pin_hash: string | null;
  lan_ip: string;
  port: number;
  game_mode: GameMode;
  default_level_type: LevelType;
  status: RoomStatus;
  finale_json: string;
  created_at: string;
  updated_at: string;
}

export interface DollRow {
  doll_id: string;
  room_id: string;
  name: string;
  tagline: string;
  sort_order: number;
  card_token: string;
  card_token_backup: string | null;
  short_code: string;
  clue: string;
  hide_hint: string;
  silhouette_url: string;
  level_type: LevelType;
  next_clue: string | null;
  egg_enabled: number;
  e1_effect: E1Effect;
  e1_sound: number;
  riddle_type: 'single_choice' | 'short_answer' | null;
  question: string;
  options_json: string;
  hint: string;
  wrong_text: string;
  max_attempts: number;
  answer_hash: string;
  synonyms_json: string;
  base_story: string;
  base_caption: string;
  base_model_url: string;
  base_photo_url: string;
  secret_model_url: string | null;
  secret_story: string;
  secret_whisper: string;
  secret_effect: string;
  secret_star: number;
  source_photo: string | null;
  gen_status: 'preset' | 'queued' | 'running' | 'done' | 'failed';
  gen_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GuestRow {
  guest_id: string;
  room_id: string;
  nickname: string;
  device_hint: string;
  created_at: string;
  last_seen_at: string;
  finale_reached_at: string | null;
}

export interface ProgressRow {
  room_id: string;
  guest_id: string;
  doll_id: string;
  state: ProgressState;
  attempts: number;
  egg_skipped: number;
  discovered_at: string | null;
  collected_at: string | null;
  egg_unlocked_at: string | null;
  updated_at: string;
}

export interface EventRow {
  seq: number;
  room_id: string;
  guest_id: string | null;
  doll_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface GenTaskRow {
  task_id: string;
  room_id: string;
  doll_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  stage: string;
  percent: number;
  provider: string;
  error: string | null;
  fallback_used: number;
  created_at: string;
  updated_at: string;
}
