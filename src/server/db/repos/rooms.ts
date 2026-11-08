import { DEFAULT_FINALE_JSON } from '../../../shared/finale';
import type { RoomStatus } from '../../../shared/contracts';
import type { GameMode, LevelType } from '../../../shared/levels';
import { generateRoomCode, newRoomId, nowIso } from '../../lib/ids';
import type { Db } from '../index';
import type { RoomRow } from '../rows';

export interface CreateRoomInput {
  title: string;
  /** Pre-generated room code; when omitted a random six-digit code is used. */
  roomCode?: string;
  gameMode?: GameMode;
  defaultLevelType?: LevelType;
}

export function createRoom(db: Db, input: CreateRoomInput): RoomRow {
  const roomId = newRoomId();
  const now = nowIso();

  db.prepare(
    `INSERT INTO rooms
       (room_id, room_code, title, game_mode, default_level_type, status, finale_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).run(
    roomId,
    input.roomCode ?? generateRoomCode(),
    input.title,
    input.gameMode ?? 'solo',
    input.defaultLevelType ?? 'bonus_quiz',
    DEFAULT_FINALE_JSON,
    now,
    now,
  );

  return getRoomById(db, roomId)!;
}

export function getRoomById(db: Db, roomId: string): RoomRow | undefined {
  return db.prepare('SELECT * FROM rooms WHERE room_id = ?').get(roomId) as RoomRow | undefined;
}

export function getRoomByCode(db: Db, roomCode: string): RoomRow | undefined {
  return db.prepare('SELECT * FROM rooms WHERE room_code = ?').get(roomCode) as RoomRow | undefined;
}

export function listRooms(db: Db): RoomRow[] {
  return db.prepare('SELECT * FROM rooms ORDER BY created_at DESC').all() as RoomRow[];
}

/** Single-home product: the first-created room is the active one. */
export function getPrimaryRoom(db: Db): RoomRow | undefined {
  return db.prepare('SELECT * FROM rooms ORDER BY created_at ASC LIMIT 1').get() as
    | RoomRow
    | undefined;
}

export function setRoomStatus(db: Db, roomId: string, status: RoomStatus): RoomRow | undefined {
  db.prepare('UPDATE rooms SET status = ?, updated_at = ? WHERE room_id = ?').run(
    status,
    nowIso(),
    roomId,
  );
  return getRoomById(db, roomId);
}

export function setRoomTitle(db: Db, roomId: string, title: string): RoomRow | undefined {
  db.prepare('UPDATE rooms SET title = ?, updated_at = ? WHERE room_id = ?').run(
    title,
    nowIso(),
    roomId,
  );
  return getRoomById(db, roomId);
}

export function setRoomLanIp(db: Db, roomId: string, lanIp: string, port?: number): RoomRow | undefined {
  const now = nowIso();
  if (port === undefined) {
    db.prepare('UPDATE rooms SET lan_ip = ?, updated_at = ? WHERE room_id = ?').run(
      lanIp,
      now,
      roomId,
    );
  } else {
    db.prepare('UPDATE rooms SET lan_ip = ?, port = ?, updated_at = ? WHERE room_id = ?').run(
      lanIp,
      port,
      now,
      roomId,
    );
  }
  return getRoomById(db, roomId);
}

export function setRoomHostPinHash(
  db: Db,
  roomId: string,
  hostPinHash: string,
): RoomRow | undefined {
  db.prepare('UPDATE rooms SET host_pin_hash = ?, updated_at = ? WHERE room_id = ?').run(
    hostPinHash,
    nowIso(),
    roomId,
  );
  return getRoomById(db, roomId);
}

/** Stored as JSON text; the finale shape is validated by the finale service (T801). */
export function setRoomFinaleJson(
  db: Db,
  roomId: string,
  finaleJson: string,
): RoomRow | undefined {
  db.prepare('UPDATE rooms SET finale_json = ?, updated_at = ? WHERE room_id = ?').run(
    finaleJson,
    nowIso(),
    roomId,
  );
  return getRoomById(db, roomId);
}
