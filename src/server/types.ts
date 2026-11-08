import type Database from 'better-sqlite3';
import type { AppConfig } from './config';

declare module 'fastify' {
  interface FastifyInstance {
    /** Validated application config (paths included). */
    config: AppConfig;
    /** Shared SQLite handle; repositories receive it explicitly. */
    db: Database.Database;
  }
}

export {};
