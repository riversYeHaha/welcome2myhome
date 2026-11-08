import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Open the SQLite file with the pragmas required by the tech design (§8.5):
 * WAL for concurrent readers, foreign keys on, 5s busy timeout.
 */
export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}
