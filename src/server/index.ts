import { isAbsolute, join } from 'node:path';
import { APP_VERSION, buildApp } from './app';
import { ensureDataDirs, loadConfig } from './config';
import { openDatabase } from './db';
import { loadOrCreateSecret } from './lib/crypto';
import { detectLanIp } from './lib/network';
import { listRooms, setRoomLanIp } from './db/repos/rooms';
import { migrate } from './db/migrate';

async function main(): Promise<void> {
  const config = loadConfig();
  ensureDataDirs(config.paths);

  const dbPath = join(config.paths.data, 'home.db');
  const db = openDatabase(dbPath);
  const { version, applied } = migrate(db, {
    dbPath,
    backupDir: config.paths.backups,
  });

  const lanIp = detectLanIp();
  if (lanIp) {
    for (const room of listRooms(db)) {
      if (!room.lan_ip) {
        setRoomLanIp(db, room.room_id, lanIp, config.server.port);
      }
    }
  }

  const secretPath = isAbsolute(config.ticket.secretFile)
    ? config.ticket.secretFile
    : join(config.paths.root, config.ticket.secretFile);
  const secret = loadOrCreateSecret(secretPath);

  const app = await buildApp({ config, db, secret, version: APP_VERSION });

  app.log.info(
    {
      root: config.paths.root,
      dbPath,
      schemaVersion: version,
      appliedMigrations: applied,
      webRoot: config.paths.web,
      lanIp: lanIp ?? null,
    },
    'welcome2myhome starting',
  );

  const address = await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info({ address }, 'listening');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    db.close();
    process.exit(0);
  };

  process.once('SIGINT', (signal) => void shutdown(signal));
  process.once('SIGTERM', (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  console.error('[fatal] failed to start server:', error);
  process.exit(1);
});
