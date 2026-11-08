import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db';
import { migrate } from '../../src/server/db/migrate';
import { createDoll, getDollByToken, listDolls } from '../../src/server/db/repos/dolls';
import { appendEvent, listEvents } from '../../src/server/db/repos/events';
import { createGenTask, updateGenTask } from '../../src/server/db/repos/gen';
import { createGuest } from '../../src/server/db/repos/guests';
import {
  countProgressStates,
  markCollected,
  recordAttempt,
  skipEgg,
  startEgg,
  unlockEgg,
  upsertDiscovered,
} from '../../src/server/db/repos/progress';
import { createRoom, getRoomByCode, setRoomStatus } from '../../src/server/db/repos/rooms';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtm-repos-'));
  const dbPath = join(dir, 'home.db');
  db = openDatabase(dbPath);
  migrate(db, { dbPath, backupDir: join(dir, 'backups') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRoom() {
  return createRoom(db, { title: '测试房间', roomCode: '426918' });
}

describe('room repository', () => {
  it('creates a room with a unique six-digit code and updates status', () => {
    const room = seedRoom();
    expect(room.status).toBe('draft');
    expect(room.room_code).toBe('426918');
    expect(getRoomByCode(db, '426918')?.room_id).toBe(room.room_id);

    expect(() => createRoom(db, { title: '重复房间码', roomCode: '426918' })).toThrow(/UNIQUE/);

    setRoomStatus(db, room.room_id, 'live');
    expect(getRoomByCode(db, '426918')?.status).toBe('live');
  });
});

describe('doll repository', () => {
  it('creates dolls with unique tokens and stable sort order', () => {
    const room = seedRoom();
    const first = createDoll(db, {
      roomId: room.room_id,
      name: '阿黄',
      cardToken: 'K7mQ2vR9dL',
      shortCode: 'HUANG7',
    });
    const second = createDoll(db, {
      roomId: room.room_id,
      name: '阿花',
      cardToken: 'T4pW8xN1aB',
      shortCode: 'HUA8',
    });

    expect(first.sort_order).toBe(0);
    expect(second.sort_order).toBe(1);
    expect(getDollByToken(db, 'K7mQ2vR9dL')?.doll_id).toBe(first.doll_id);
    expect(listDolls(db, room.room_id).map((doll) => doll.doll_id)).toEqual([
      first.doll_id,
      second.doll_id,
    ]);

    expect(() =>
      createDoll(db, {
        roomId: room.room_id,
        name: '重复 token',
        cardToken: 'K7mQ2vR9dL',
        shortCode: 'DUP1',
      }),
    ).toThrow(/UNIQUE/);
  });
});

describe('progress state machine', () => {
  it('walks locked → discovered → collected → egg states without downgrading', () => {
    const room = seedRoom();
    const doll = createDoll(db, {
      roomId: room.room_id,
      name: '阿黄',
      cardToken: 'K7mQ2vR9dL',
      shortCode: 'HUANG7',
    });
    const guest = createGuest(db, { roomId: room.room_id, nickname: '小林' });

    expect(upsertDiscovered(db, room.room_id, guest.guest_id, doll.doll_id).state).toBe(
      'discovered',
    );
    expect(upsertDiscovered(db, room.room_id, guest.guest_id, doll.doll_id).state).toBe(
      'discovered',
    );

    expect(markCollected(db, room.room_id, guest.guest_id, doll.doll_id).state).toBe('collected');
    expect(startEgg(db, room.room_id, guest.guest_id, doll.doll_id)?.state).toBe('egg_answering');

    expect(recordAttempt(db, room.room_id, guest.guest_id, doll.doll_id)?.attempts).toBe(1);
    expect(recordAttempt(db, room.room_id, guest.guest_id, doll.doll_id)?.attempts).toBe(2);

    const unlocked = unlockEgg(db, room.room_id, guest.guest_id, doll.doll_id);
    expect(unlocked?.state).toBe('egg_unlocked');
    expect(unlocked?.egg_unlocked_at).toBeTruthy();

    // A late duplicate E1 report must not roll the egg back.
    expect(markCollected(db, room.room_id, guest.guest_id, doll.doll_id).state).toBe(
      'egg_unlocked',
    );

    const counts = countProgressStates(db, room.room_id, guest.guest_id);
    expect(counts.egg_unlocked).toBe(1);
    expect(counts.collected).toBe(0);
  });

  it('skipping the quiz returns the card to collected and remembers the skip', () => {
    const room = seedRoom();
    const doll = createDoll(db, {
      roomId: room.room_id,
      name: '阿花',
      cardToken: 'T4pW8xN1aB',
      shortCode: 'HUA8',
    });
    const guest = createGuest(db, { roomId: room.room_id, nickname: '同学' });

    upsertDiscovered(db, room.room_id, guest.guest_id, doll.doll_id);
    markCollected(db, room.room_id, guest.guest_id, doll.doll_id);
    startEgg(db, room.room_id, guest.guest_id, doll.doll_id);

    const skipped = skipEgg(db, room.room_id, guest.guest_id, doll.doll_id);
    expect(skipped?.state).toBe('collected');
    expect(skipped?.egg_skipped).toBe(1);
    expect(skipped?.egg_unlocked_at).toBeNull();
  });
});

describe('events and generation tasks', () => {
  it('appends events in order and stores JSON payloads', () => {
    const room = seedRoom();
    appendEvent(db, { roomId: room.room_id, type: 'guest_join', payload: { device: 'ios' } });
    appendEvent(db, { roomId: room.room_id, type: 'card_scanned', payload: { source: 'qr' } });

    const events = listEvents(db, room.room_id);
    expect(events).toHaveLength(2);
    expect(events[0]!.seq).toBeGreaterThan(events[1]!.seq);
    expect(events[0]!.type).toBe('card_scanned');
    expect(JSON.parse(events[0]!.payload_json)).toEqual({ source: 'qr' });
  });

  it('tracks generation task progress', () => {
    const room = seedRoom();
    const doll = createDoll(db, {
      roomId: room.room_id,
      name: '阿黄',
      cardToken: 'K7mQ2vR9dL',
      shortCode: 'HUANG7',
    });

    const task = createGenTask(db, { roomId: room.room_id, dollId: doll.doll_id });
    expect(task.status).toBe('queued');

    const updated = updateGenTask(db, task.task_id, {
      status: 'running',
      stage: 'lux3d',
      percent: 40,
    });
    expect(updated?.status).toBe('running');
    expect(updated?.stage).toBe('lux3d');
    expect(updated?.percent).toBe(40);
  });
});
