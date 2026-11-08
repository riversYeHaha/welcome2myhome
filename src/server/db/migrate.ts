import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './index';
import { SCHEMA_SQL } from './schema';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Additive migrations only: append here, never edit a shipped entry. */
const MIGRATIONS: readonly Migration[] = [{ version: 1, name: 'init', sql: SCHEMA_SQL }];

export interface MigrateOptions {
  dbPath: string;
  backupDir: string;
  keepBackups?: number;
}

export interface MigrateResult {
  version: number;
  applied: number[];
}

function readVersion(db: Db): number {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/**
 * Copy the live database into `backupDir` and keep the newest `keep` files.
 * Returns the backup path, or null for an in-memory database.
 */
export function backupDatabase(
  db: Db,
  dbPath: string,
  backupDir: string,
  keep = 5,
): string | null {
  if (dbPath === ':memory:') return null;

  mkdirSync(backupDir, { recursive: true });
  // Flush the WAL so the copied file is self-contained.
  db.pragma('wal_checkpoint(TRUNCATE)');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(backupDir, `home-${stamp}.db`);
  copyFileSync(dbPath, dest);

  const backups = readdirSync(backupDir)
    .filter((name) => name.endsWith('.db'))
    .sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
    unlinkSync(join(backupDir, stale));
  }
  return dest;
}

/**
 * Apply every migration newer than the recorded `schema_version`, each inside a
 * transaction. Backs up the database before any upgrade of an existing schema.
 */
export function migrate(db: Db, options: MigrateOptions): MigrateResult {
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const current = readVersion(db);
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    if (current > 0) {
      backupDatabase(db, options.dbPath, options.backupDir, options.keepBackups ?? 5);
    }

    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(String(migration.version));
    })();

    applied.push(migration.version);
  }

  return { version: readVersion(db), applied };
}
