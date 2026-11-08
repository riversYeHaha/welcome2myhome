import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db';
import { migrate } from '../../src/server/db/migrate';
import {
  cardUrl,
  createDollWithCard,
  generateCardToken,
  generateShortCode,
  issueBackupToken,
  normalizeShortCode,
  qrPng,
  SHORT_CODE_ALPHABET,
} from '../../src/server/services/cards';
import { getDollByAnyToken, getDollByShortCode } from '../../src/server/db/repos/dolls';
import { createRoom } from '../../src/server/db/repos/rooms';
import type { RoomRow } from '../../src/server/db/rows';
import { AppError } from '../../src/server/lib/errors';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtm-cards-'));
  const dbPath = join(dir, 'home.db');
  db = openDatabase(dbPath);
  migrate(db, { dbPath, backupDir: join(dir, 'backups') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('card credentials', () => {
  it('generates 10-char base62 tokens and 6-char unambiguous short codes', () => {
    const tokens = new Set<string>();
    const codes = new Set<string>();

    for (let i = 0; i < 300; i += 1) {
      const token = generateCardToken();
      expect(token).toMatch(/^[0-9A-Za-z]{10}$/);

      const code = generateShortCode();
      expect(code).toMatch(/^[A-Z0-9]{6}$/);
      expect([...code].every((character) => SHORT_CODE_ALPHABET.includes(character))).toBe(
        true,
      );
      expect(code).not.toMatch(/[01IO]/);

      tokens.add(token);
      codes.add(code);
    }

    expect(tokens.size).toBe(300);
    expect(codes.size).toBe(300);
  });

  it('normalizes typed short codes and rejects ambiguous characters', () => {
    expect(normalizeShortCode(' huang7 ')).toBe('HUANG7');
    expect(normalizeShortCode('huang-7')).toBe('HUANG7');

    for (const invalid of ['HUANG0', 'HUANGI', 'HUANGO', 'HUANG1', 'ABC']) {
      try {
        normalizeShortCode(invalid);
        throw new Error(`expected ${invalid} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('SHORTCODE_INVALID');
      }
    }
  });

  it('builds the card URL from the room LAN IP with a fallback host', () => {
    const room = {
      lan_ip: '192.168.1.50',
      port: 8080,
      room_code: '426918',
    } as RoomRow;
    expect(cardUrl(room, 'K7mQ2vR9dL')).toBe(
      'http://192.168.1.50:8080/d/K7mQ2vR9dL?r=426918',
    );

    const fallback = { ...room, lan_ip: '' } as RoomRow;
    expect(cardUrl(fallback, 'K7mQ2vR9dL', '10.0.0.5')).toBe(
      'http://10.0.0.5:8080/d/K7mQ2vR9dL?r=426918',
    );
  });

  it('creates dolls with unique credentials and issues a backup token', () => {
    const room = createRoom(db, { title: '测试房间', roomCode: '426918' });
    const doll = createDollWithCard(db, { roomId: room.room_id, name: '阿黄' });

    expect(doll.card_token).toHaveLength(10);
    expect(getDollByShortCode(db, doll.short_code)?.doll_id).toBe(doll.doll_id);

    const backup = issueBackupToken(db, doll.doll_id);
    expect(backup.card_token_backup).toHaveLength(10);
    expect(backup.card_token_backup).not.toBe(doll.card_token);
    expect(getDollByAnyToken(db, backup.card_token_backup!)?.doll_id).toBe(doll.doll_id);
  });
});

describe('qr rendering', () => {
  it('returns a PNG buffer', async () => {
    const png = await qrPng('http://192.168.1.50:8080/');
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.length).toBeGreaterThan(200);
  });
});
