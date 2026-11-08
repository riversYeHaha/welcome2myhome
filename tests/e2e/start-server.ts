/**
 * E2E server: same composition as production, but with a throwaway data dir and
 * an in-memory secret so `playwright test` never touches the real `data/`.
 *
 * Started by `playwright.config.ts` via tsx; listens on 127.0.0.1 only because
 * the host admin API is local-only.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app';
import { ensureDataDirs, loadConfig, type AppConfig } from '../../src/server/config';
import { openDatabase } from '../../src/server/db';
import { migrate } from '../../src/server/db/migrate';

const PORT = Number(process.env.WTM_E2E_PORT ?? 4173);
const HOST = '127.0.0.1';

async function main(): Promise<void> {
  const dataDir =
    process.env.WTM_E2E_DATA ?? mkdtempSync(join(tmpdir(), 'wtm-e2e-'));
  rmSync(dataDir, { recursive: true, force: true });

  const base = loadConfig({ rootDir: process.cwd(), env: {} });
  const config: AppConfig = {
    ...base,
    paths: {
      ...base.paths,
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

  const dbPath = join(dataDir, 'home.db');
  const db = openDatabase(dbPath);
  migrate(db, { dbPath, backupDir: join(dataDir, 'backups') });

  const app = await buildApp({
    config,
    db,
    secret: randomBytes(32),
    logger: { level: 'warn' },
  });

  await app.listen({ port: PORT, host: HOST });
  console.log(`[e2e] listening on http://${HOST}:${PORT} (data: ${dataDir})`);

  const shutdown = async (): Promise<void> => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error('[e2e] failed to start:', error);
  process.exit(1);
});
