import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app';
import { ensureDataDirs, loadConfig, type AppConfig } from '../../src/server/config';
import { openDatabase, type Db } from '../../src/server/db';
import { migrate } from '../../src/server/db/migrate';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  dir: string;
  config: AppConfig;
}

export async function makeTestApp(): Promise<TestApp> {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-test-'));
  const dbPath = join(dir, 'home.db');
  const db = openDatabase(dbPath);
  migrate(db, { dbPath, backupDir: join(dir, 'backups') });

  const baseConfig = loadConfig({ rootDir: repoRoot, env: {} });
  const dataDir = join(dir, 'data');
  const config: AppConfig = {
    ...baseConfig,
    paths: {
      ...baseConfig.paths,
      root: dir,
      data: dataDir,
      photos: join(dataDir, 'photos'),
      models: join(dataDir, 'models'),
      silhouettes: join(dataDir, 'silhouettes'),
      exports: join(dataDir, 'exports'),
      logs: join(dataDir, 'logs'),
      backups: join(dataDir, 'backups'),
      gen: join(dataDir, 'gen'),
    },
  };
  ensureDataDirs(config.paths);
  const app = await buildApp({ config, db, secret: randomBytes(32), logger: false });

  return { app, db, dir, config };
}

export function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') throw new Error('missing set-cookie header');
  return value.split(';')[0]!;
}

export interface HostSetup {
  cookie: string;
  csrf: string;
  room: { room_id: string; room_code: string; status: string };
}

export async function setupHost(app: FastifyInstance): Promise<HostSetup> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/host/setup',
    payload: { pin: '1234' },
    headers: { 'content-type': 'application/json' },
  });
  if (response.statusCode !== 200) {
    throw new Error(`setup failed: ${response.statusCode} ${response.body}`);
  }

  const body = response.json<{ room: HostSetup['room']; csrfToken: string }>();
  return { cookie: cookieOf(response), csrf: body.csrfToken, room: body.room };
}
