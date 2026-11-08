import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { getRoomById } from '../db/repos/rooms';
import { listAllEvents } from '../db/repos/events';
import { AppError } from '../lib/errors';
import {
  BOARD_HEARTBEAT_MS,
  MAX_BOARD_STREAMS,
  sanitizeEventPayload,
  type BoardHub,
} from '../lib/events';
import { nowIso } from '../lib/ids';
import { requireHost, type HostSession } from '../services/host-auth';
import { boardSnapshot } from '../services/board';
import type { RoomRow } from '../db/rows';

export interface BoardRouteOptions {
  config: AppConfig;
  db: Db;
  secret: Buffer;
  hub: BoardHub;
}

function sendEvent(reply: FastifyReply, event: string, data: unknown): void {
  const raw = reply.raw;
  if (raw.writableEnded || raw.destroyed) return;
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Host-only live board (tech design §5.6, FR-11).
 *
 * - `GET /api/board/:room_id`      aggregate snapshot (SSE reconnect fallback)
 * - `GET /api/board/:room_id/stream` SSE nudge stream, 15s heartbeat
 * - `GET /api/host/logs/export`    JSONL analytics export (P1, FR-48)
 */
export async function boardRoutes(
  app: FastifyInstance,
  options: BoardRouteOptions,
): Promise<void> {
  const deps = { config: options.config, db: options.db, secret: options.secret };

  function requireRoom(request: FastifyRequest): { session: HostSession; room: RoomRow } {
    const session = requireHost(request, deps);
    const { room_id: roomId } = request.params as { room_id: string };
    if (roomId !== session.roomId) {
      throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');
    }
    const room = getRoomById(options.db, session.roomId);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');
    return { session, room };
  }

  app.get('/api/board/:room_id', async (request) => {
    const { room } = requireRoom(request);
    return { board: boardSnapshot(options.db, room) };
  });

  app.get('/api/board/:room_id/stream', async (request, reply) => {
    const { room } = requireRoom(request);

    if (options.hub.connectionCount(room.room_id) >= MAX_BOARD_STREAMS) {
      throw new AppError('BOARD_BUSY', 429, '看板窗口太多了，请关掉几个再刷新', true);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    reply.raw.write('retry: 3000\n\n');
    sendEvent(reply, 'ready', {
      room_id: room.room_id,
      status: room.status,
      at: nowIso(),
    });

    let closed = false;
    let unsubscribe: () => void = () => {};

    function finish(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    }

    unsubscribe = options.hub.subscribe(room.room_id, (message) => {
      if (closed) return;
      sendEvent(reply, message.signal, {
        type: message.type,
        seq: message.seq,
        at: message.at,
        guest_id: message.guest_id,
        doll_id: message.doll_id,
        payload: message.payload,
      });
      if (message.type === 'room_status') checkRoomState();
    });

    function checkRoomState(): void {
      const current = getRoomById(options.db, room.room_id);
      if (!current || current.status === 'ended') {
        sendEvent(reply, 'closed', { reason: 'ended' });
        finish();
      }
    }

    const heartbeat = setInterval(() => {
      if (closed) return;
      sendEvent(reply, 'ping', { at: nowIso() });
      checkRoomState();
    }, BOARD_HEARTBEAT_MS);
    heartbeat.unref?.();

    request.raw.on('close', finish);
    checkRoomState();
  });

  app.get('/api/host/logs/export', async (request, reply) => {
    const session = requireHost(request, deps);
    const room = getRoomById(options.db, session.roomId);
    if (!room) throw new AppError('ROOM_NOT_FOUND', 404, '房间不存在');

    const guests = options.db
      .prepare('SELECT guest_id, nickname FROM guests WHERE room_id = ?')
      .all(room.room_id) as Array<{ guest_id: string; nickname: string }>;
    const dolls = options.db
      .prepare('SELECT doll_id, name FROM dolls WHERE room_id = ?')
      .all(room.room_id) as Array<{ doll_id: string; name: string }>;
    const guestNames = new Map(guests.map((guest) => [guest.guest_id, guest.nickname]));
    const dollNames = new Map(dolls.map((doll) => [doll.doll_id, doll.name]));

    const lines = listAllEvents(options.db, room.room_id).map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.payload_json) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = sanitizeEventPayload(parsed as Record<string, unknown>);
        }
      } catch {
        payload = {};
      }
      return JSON.stringify({
        seq: row.seq,
        at: row.created_at,
        type: row.type,
        room_code: room.room_code,
        guest_id: row.guest_id,
        guest_name: row.guest_id ? (guestNames.get(row.guest_id) ?? null) : null,
        doll_id: row.doll_id,
        doll_name: row.doll_id ? (dollNames.get(row.doll_id) ?? null) : null,
        payload,
      });
    });

    const stamp = nowIso().slice(0, 10).replace(/-/g, '');
    return reply
      .type('application/x-ndjson; charset=utf-8')
      .header('cache-control', 'no-store')
      .header(
        'content-disposition',
        `attachment; filename="events-${room.room_code}-${stamp}.jsonl"`,
      )
      .send(lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  });
}
