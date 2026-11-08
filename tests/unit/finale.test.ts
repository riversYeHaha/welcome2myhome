import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db';
import { migrate } from '../../src/server/db/migrate';
import { createDollWithCard } from '../../src/server/services/cards';
import { createGuest } from '../../src/server/db/repos/guests';
import { markCollected, unlockEgg } from '../../src/server/db/repos/progress';
import { createRoom, getRoomById, setRoomFinaleJson } from '../../src/server/db/repos/rooms';
import { DEFAULT_FINALE, type FinaleConfig } from '../../src/shared/finale';
import { evaluateFinale, parseFinaleConfig } from '../../src/server/services/finale';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtm-finale-'));
  const dbPath = join(dir, 'home.db');
  db = openDatabase(dbPath);
  migrate(db, { dbPath, backupDir: join(dir, 'backups') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(trigger: FinaleConfig['trigger'], enabled = true) {
  const room = createRoom(db, { title: '测试房间', roomCode: '426918' });
  const dollA = createDollWithCard(db, { roomId: room.room_id, name: 'A' });
  const dollB = createDollWithCard(db, { roomId: room.room_id, name: 'B' });
  const guest = createGuest(db, { roomId: room.room_id, nickname: '小林' });

  const config: FinaleConfig = { ...DEFAULT_FINALE, enabled, trigger };
  setRoomFinaleJson(db, room.room_id, JSON.stringify(config));

  return { room, dollA, dollB, guest };
}

function currentRoom(roomId: string) {
  return getRoomById(db, roomId)!;
}

describe('finale config parsing', () => {
  it('falls back to the friendly default for missing or malformed JSON', () => {
    expect(parseFinaleConfig('{}')).toMatchObject({
      enabled: true,
      trigger: { type: 'all_collected' },
    });
    expect(parseFinaleConfig('not-json')).toEqual(DEFAULT_FINALE);
    expect(parseFinaleConfig(JSON.stringify({ trigger: { type: 'count_gte', value: 2 } }))).toMatchObject(
      {
        trigger: { type: 'count_gte', value: 2 },
      },
    );
  });
});

describe('finale triggers', () => {
  it('reaches all_collected only after every doll is collected', () => {
    const { room, dollA, dollB, guest } = seed({ type: 'all_collected', value: null });

    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(false);
    markCollected(db, room.room_id, guest.guest_id, dollA.doll_id);
    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(false);
    markCollected(db, room.room_id, guest.guest_id, dollB.doll_id);

    const evaluation = evaluateFinale(db, currentRoom(room.room_id), guest.guest_id);
    expect(evaluation.reached).toBe(true);
    expect(evaluation.progress.total).toBe(2);
    expect(evaluation.progress.remaining).toBe(0);
  });

  it('reaches count_gte at the configured count', () => {
    const { room, dollA, guest } = seed({ type: 'count_gte', value: 1 });
    markCollected(db, room.room_id, guest.guest_id, dollA.doll_id);
    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(true);
  });

  it('reaches all_eggs only after every quiz is unlocked', () => {
    const { room, dollA, dollB, guest } = seed({ type: 'all_eggs', value: null });
    db.prepare("UPDATE dolls SET egg_enabled = 1, question = '题', answer_hash = 'hash' WHERE room_id = ?").run(
      room.room_id,
    );

    markCollected(db, room.room_id, guest.guest_id, dollA.doll_id);
    markCollected(db, room.room_id, guest.guest_id, dollB.doll_id);
    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(false);

    unlockEgg(db, room.room_id, guest.guest_id, dollA.doll_id);
    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(false);

    unlockEgg(db, room.room_id, guest.guest_id, dollB.doll_id);
    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(true);
  });

  it('treats all_eggs as all_collected when no quiz exists', () => {
    const { room, dollA, dollB, guest } = seed({ type: 'all_eggs', value: null });
    markCollected(db, room.room_id, guest.guest_id, dollA.doll_id);
    markCollected(db, room.room_id, guest.guest_id, dollB.doll_id);
    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(true);
  });

  it('manual requires the host to open the finale', () => {
    const { room, guest } = seed({ type: 'manual', value: null });
    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(false);

    const config = parseFinaleConfig(currentRoom(room.room_id).finale_json);
    setRoomFinaleJson(
      db,
      room.room_id,
      JSON.stringify({ ...config, opened_at: new Date().toISOString() }),
    );
    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(true);
  });

  it('never reaches a disabled finale', () => {
    const { room, dollA, dollB, guest } = seed({ type: 'all_collected', value: null }, false);
    markCollected(db, room.room_id, guest.guest_id, dollA.doll_id);
    markCollected(db, room.room_id, guest.guest_id, dollB.doll_id);
    expect(evaluateFinale(db, currentRoom(room.room_id), guest.guest_id).reached).toBe(false);
  });
});
