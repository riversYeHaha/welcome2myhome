/**
 * Canonical schema, version 1 (tech design §8.3).
 *
 * Keep this SQL in sync with the migrations array in `migrate.ts`: once v1 has
 * shipped, changes must be additive migrations, never edits to this string.
 */
export const SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  room_id            TEXT PRIMARY KEY,
  room_code          TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  host_pin_hash      TEXT,
  lan_ip             TEXT NOT NULL DEFAULT '',
  port               INTEGER NOT NULL DEFAULT 8080,
  game_mode          TEXT NOT NULL DEFAULT 'solo'
                     CHECK (game_mode IN ('solo','race','coop')),
  default_level_type TEXT NOT NULL DEFAULT 'bonus_quiz'
                     CHECK (default_level_type IN ('discovery','bonus_quiz','clue_chain','duo_scan','timed')),
  status             TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','live','paused','ended')),
  finale_json        TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dolls (
  doll_id          TEXT PRIMARY KEY,
  room_id          TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  tagline          TEXT NOT NULL DEFAULT '',
  sort_order       INTEGER NOT NULL DEFAULT 0,

  card_token        TEXT NOT NULL UNIQUE,
  card_token_backup TEXT UNIQUE,
  short_code        TEXT NOT NULL UNIQUE,
  clue              TEXT NOT NULL DEFAULT '',
  hide_hint         TEXT NOT NULL DEFAULT '',
  silhouette_url    TEXT NOT NULL DEFAULT '',

  level_type   TEXT NOT NULL DEFAULT 'bonus_quiz'
               CHECK (level_type IN ('discovery','bonus_quiz','clue_chain','duo_scan','timed')),
  next_clue    TEXT,
  egg_enabled  INTEGER NOT NULL DEFAULT 0,
  e1_effect    TEXT NOT NULL DEFAULT 'starlight'
               CHECK (e1_effect IN ('starlight','confetti','bubbles','sparks')),
  e1_sound     INTEGER NOT NULL DEFAULT 1,

  riddle_type   TEXT CHECK (riddle_type IN ('single_choice','short_answer')),
  question      TEXT NOT NULL DEFAULT '',
  options_json  TEXT NOT NULL DEFAULT '[]',
  hint          TEXT NOT NULL DEFAULT '',
  wrong_text    TEXT NOT NULL DEFAULT '',
  max_attempts  INTEGER NOT NULL DEFAULT 0,
  answer_hash   TEXT NOT NULL DEFAULT '',
  synonyms_json TEXT NOT NULL DEFAULT '[]',

  base_story      TEXT NOT NULL DEFAULT '',
  base_caption    TEXT NOT NULL DEFAULT '',
  base_model_url  TEXT NOT NULL DEFAULT '',
  base_photo_url  TEXT NOT NULL DEFAULT '',

  secret_model_url TEXT,
  secret_story     TEXT NOT NULL DEFAULT '',
  secret_whisper   TEXT NOT NULL DEFAULT '',
  secret_effect    TEXT NOT NULL DEFAULT 'golden_gather',
  secret_star      INTEGER NOT NULL DEFAULT 1,

  source_photo TEXT,
  gen_status   TEXT NOT NULL DEFAULT 'preset'
               CHECK (gen_status IN ('preset','queued','running','done','failed')),
  gen_task_id  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dolls_room ON dolls(room_id, sort_order);

CREATE TABLE IF NOT EXISTS guests (
  guest_id          TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  nickname          TEXT NOT NULL,
  device_hint       TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  finale_reached_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_guests_room ON guests(room_id, last_seen_at);

CREATE TABLE IF NOT EXISTS progress (
  room_id         TEXT NOT NULL,
  guest_id        TEXT NOT NULL REFERENCES guests(guest_id) ON DELETE CASCADE,
  doll_id         TEXT NOT NULL REFERENCES dolls(doll_id) ON DELETE CASCADE,
  state           TEXT NOT NULL DEFAULT 'locked'
                  CHECK (state IN ('locked','discovered','collected','egg_answering','egg_unlocked')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  egg_skipped     INTEGER NOT NULL DEFAULT 0,
  discovered_at   TEXT,
  collected_at    TEXT,
  egg_unlocked_at TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (room_id, guest_id, doll_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_doll ON progress(room_id, doll_id, state);

CREATE TABLE IF NOT EXISTS assets (
  asset_id   TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL,
  doll_id    TEXT REFERENCES dolls(doll_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL
             CHECK (kind IN ('base_model','secret_model','silhouette','photo','finale_image','card_qr','preset_model')),
  path       TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  checksum   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gen_tasks (
  task_id        TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL,
  doll_id        TEXT NOT NULL REFERENCES dolls(doll_id) ON DELETE CASCADE,
  status         TEXT NOT NULL
                 CHECK (status IN ('queued','running','done','failed')),
  stage          TEXT NOT NULL DEFAULT 'queued',
  percent        INTEGER NOT NULL DEFAULT 0,
  provider       TEXT NOT NULL DEFAULT '',
  error          TEXT,
  fallback_used  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      TEXT NOT NULL,
  guest_id     TEXT,
  doll_id      TEXT,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_room ON events(room_id, seq);
`;
