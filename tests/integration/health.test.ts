import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiErrorBody, HealthResponse } from '../../src/shared/contracts';
import { buildApp } from '../../src/server/app';
import { loadConfig } from '../../src/server/config';
import { openDatabase } from '../../src/server/db';
import { migrate } from '../../src/server/db/migrate';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-app-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('GET /api/health', () => {
  it('reports the schema version and returns 200', async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'home.db');
    const db = openDatabase(dbPath);
    migrate(db, { dbPath, backupDir: join(dir, 'backups') });

    const config = loadConfig({ rootDir: repoRoot, env: {} });
    const app = await buildApp({ config, db, secret: randomBytes(32), logger: false });

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);

    const body = response.json<HealthResponse>();
    expect(body.ok).toBe(true);
    expect(body.name).toBe('welcome2myhome');
    expect(body.db.schemaVersion).toBe(1);
    expect(body.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await app.close();
    db.close();
  });

  it('returns the JSON error envelope for unknown API routes', async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'home.db');
    const db = openDatabase(dbPath);
    migrate(db, { dbPath, backupDir: join(dir, 'backups') });

    const config = loadConfig({ rootDir: repoRoot, env: {} });
    const app = await buildApp({ config, db, secret: randomBytes(32), logger: false });

    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(404);
    const body = response.json<ApiErrorBody>();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBeTruthy();

    await app.close();
    db.close();
  });
});
