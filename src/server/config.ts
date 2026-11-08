import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const LevelTypeSchema = z.enum([
  'discovery',
  'bonus_quiz',
  'clue_chain',
  'duo_scan',
  'timed',
]);

const ConfigSchema = z
  .object({
    server: z
      .object({
        port: z.number().int().min(1).max(65535),
        host: z.string().min(1),
        allowLanAdmin: z.boolean(),
        /** Exact origins allowed to call the API cross-origin; empty = closed. */
        corsAllowlist: z.array(z.string().url()).default([]),
        /** Per-IP sliding-window limits for the public guest entry points. */
        rateLimit: z
          .object({
            joinPerMin: z.number().int().positive().default(30),
            shortcodePerMin: z.number().int().positive().default(30),
            cardPerMin: z.number().int().positive().default(30),
          })
          .strict()
          .default({ joinPerMin: 30, shortcodePerMin: 30, cardPerMin: 30 }),
      })
      .strict(),
    room: z
      .object({
        defaultGameMode: z.enum(['solo', 'race', 'coop']),
        defaultLevelType: LevelTypeSchema,
      })
      .strict(),
    ticket: z
      .object({
        ttlSec: z.number().int().positive(),
        secretFile: z.string().min(1),
      })
      .strict(),
    judge: z
      .object({
        scrypt: z
          .object({
            N: z.number().int().positive(),
            r: z.number().int().positive(),
            p: z.number().int().positive(),
          })
          .strict(),
        burstPer30s: z.number().int().positive(),
        perGuestPerMin: z.number().int().positive(),
      })
      .strict(),
    effects: z
      .object({
        particleTiers: z.array(z.number().int().positive()).length(3),
        watchdogMs: z.number().int().positive(),
      })
      .strict(),
    generation: z
      .object({
        provider: z.enum(['manual', 'lux3d']),
        endpoint: z.string().min(1),
        /** Env-only secret (`LUX3D_API_KEY`); never written to config files or logs. */
        apiKey: z.string().optional(),
        version: z.enum(['G1', 'G1-Turbo']).default('G1'),
        faceCount: z.number().int().min(10_000).max(300_000).default(300_000),
        enablePbr: z.boolean().default(true),
        pollIntervalMs: z.number().int().min(200).max(10_000).default(2_000),
        blenderEnabled: z.boolean(),
        blenderPath: z.string(),
        timeoutSec: z.number().int().positive(),
      })
      .strict(),
    cards: z
      .object({
        page: z.literal('A4'),
        cardWidthMm: z.number().positive(),
        cardHeightMm: z.number().positive(),
        perPage: z.number().int().positive(),
      })
      .strict(),
    logging: z
      .object({
        level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
        retainDays: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type AppConfigData = z.infer<typeof ConfigSchema>;

export interface AppPaths {
  root: string;
  data: string;
  photos: string;
  models: string;
  silhouettes: string;
  exports: string;
  logs: string;
  backups: string;
  gen: string;
  web: string;
}

export type AppConfig = AppConfigData & { paths: AppPaths };

/** Directories created on boot; `web` is build output and is not created here. */
const DATA_DIR_KEYS = [
  'data',
  'photos',
  'models',
  'silhouettes',
  'exports',
  'logs',
  'backups',
  'gen',
] as const;

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** Works both from `src/server` (tsx) and `dist/server` (bundled server). */
const DEFAULT_ROOT = resolve(MODULE_DIR, '../..');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Arrays replace; plain objects merge recursively. */
function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) {
    return override === undefined ? base : override;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge(merged[key], value);
  }
  return merged;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const server: Record<string, unknown> = {};
  if (env.PORT !== undefined) server.port = Number(env.PORT);
  if (env.HOST !== undefined) server.host = env.HOST;
  if (Object.keys(server).length > 0) out.server = server;

  if (env.LOG_LEVEL !== undefined) out.logging = { level: env.LOG_LEVEL };

  const generation: Record<string, unknown> = {};
  if (env.LUX3D_ENDPOINT !== undefined) generation.endpoint = env.LUX3D_ENDPOINT;
  if (env.LUX3D_API_KEY !== undefined) generation.apiKey = env.LUX3D_API_KEY;
  if (env.BLENDER_PATH !== undefined) generation.blenderPath = env.BLENDER_PATH;
  if (env.BLENDER_ENABLED !== undefined) generation.blenderEnabled = env.BLENDER_ENABLED === 'true';
  if (Object.keys(generation).length > 0) out.generation = generation;

  return out;
}

function buildPaths(root: string): AppPaths {
  const data = join(root, 'data');
  return {
    root,
    data,
    photos: join(data, 'photos'),
    models: join(data, 'models'),
    silhouettes: join(data, 'silhouettes'),
    exports: join(data, 'exports'),
    logs: join(data, 'logs'),
    backups: join(data, 'backups'),
    gen: join(data, 'gen'),
    web: join(root, 'dist/web'),
  };
}

export interface LoadConfigOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Load `config/default.json`, merge optional `config/local.json`, then apply
 * env overrides, and validate with zod. Throws with the offending field path.
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const rootDir = resolve(options.rootDir ?? process.env.WTM_ROOT ?? DEFAULT_ROOT);
  const env = options.env ?? process.env;

  const defaultPath = join(rootDir, 'config/default.json');
  if (!existsSync(defaultPath)) {
    throw new Error(`Configuration file not found: ${defaultPath}`);
  }
  const localPath = join(rootDir, 'config/local.json');
  const merged = deepMerge(
    deepMerge(readJson(defaultPath), existsSync(localPath) ? readJson(localPath) : {}),
    envOverrides(env),
  );

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration (${defaultPath}): ${detail}`);
  }

  return { ...parsed.data, paths: buildPaths(rootDir) };
}

/** Create `data/` subdirectories. Safe to call on every boot. */
export function ensureDataDirs(paths: AppPaths): void {
  for (const key of DATA_DIR_KEYS) {
    mkdirSync(paths[key], { recursive: true });
  }
}
