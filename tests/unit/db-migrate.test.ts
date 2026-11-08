import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db';
import { backupDatabase, migrate } from '../../src/server/db/migrate';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-db-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('sqlite bootstrap', () => {
  it('applies the v1 schema and is idempotent', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'home.db');
    const backupDir = join(dir, 'backups');
    const db = openDatabase(dbPath);

    const first = migrate(db, { dbPath, backupDir });
    expect(first.applied).toEqual([1]);
    expect(first.version).toBe(1);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'schema_meta',
        'rooms',
        'dolls',
        'guests',
        'progress',
        'assets',
        'gen_tasks',
        'events',
      ]),
    );

    const second = migrate(db, { dbPath, backupDir });
    expect(second.applied).toEqual([]);
    expect(second.version).toBe(1);

    db.close();
  });

  it('writes a backup that can be opened again', () => {
    const dir = makeTempDir();
    const dbPath = join(dir, 'home.db');
    const backupDir = join(dir, 'backups');
    const db = openDatabase(dbPath);
    migrate(db, { dbPath, backupDir });

    const backupPath = backupDatabase(db, dbPath, backupDir);
    expect(backupPath).not.toBeNull();
    expect(existsSync(backupPath!)).toBe(true);

    const restored = openDatabase(backupPath!);
    const row = restored
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(row.value).toBe('1');
    restored.close();
    db.close();
  });
});
