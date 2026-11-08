import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';
import type { LevelType } from '../../shared/levels';
import type { Db } from '../db';
import {
  createDoll,
  getDoll,
  getDollByShortCode,
  getDollByToken,
  setDollBackupToken,
} from '../db/repos/dolls';
import type { DollRow, RoomRow } from '../db/rows';
import { AppError } from '../lib/errors';
import { randomBase62 } from '../lib/ids';
import { isUniqueViolation } from '../lib/sqlite';

export const CARD_TOKEN_LENGTH = 10;
export const SHORT_CODE_LENGTH = 6;

/** Excludes 0/1/I/O so a printed code is unambiguous when typed by hand. */
export const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const MAX_ALLOCATION_ATTEMPTS = 12;

export function generateCardToken(): string {
  return randomBase62(CARD_TOKEN_LENGTH);
}

export function generateShortCode(): string {
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i += 1) {
    code += SHORT_CODE_ALPHABET[randomInt(0, SHORT_CODE_ALPHABET.length)];
  }
  return code;
}

/** Accept lowercase / spaces / hyphens, then enforce the printable alphabet. */
export function normalizeShortCode(input: string): string {
  const value = input.trim().toUpperCase().replace(/[\s-]+/g, '');
  const shape = new RegExp(`^[A-Z0-9]{${SHORT_CODE_LENGTH}}$`);
  if (
    !shape.test(value) ||
    [...value].some((character) => !SHORT_CODE_ALPHABET.includes(character))
  ) {
    throw new AppError('SHORTCODE_INVALID', 404, '短码无效，请核对卡片（不含 0/O/1/I）');
  }
  return value;
}

function tokenInUse(db: Db, token: string): boolean {
  if (getDollByToken(db, token)) return true;
  return Boolean(
    db.prepare('SELECT 1 FROM dolls WHERE card_token_backup = ?').get(token),
  );
}

export function generateUniqueCardToken(db: Db): string {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const token = generateCardToken();
    if (!tokenInUse(db, token)) return token;
  }
  throw new Error('无法分配唯一的卡片 token');
}

export function generateUniqueShortCode(db: Db): string {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const code = generateShortCode();
    if (!getDollByShortCode(db, code)) return code;
  }
  throw new Error('无法分配唯一的短码');
}

/** LAN URL encoded on the physical card (PRD v3 §5.1). */
export function cardUrl(room: RoomRow, token: string, fallbackHost = 'localhost'): string {
  const host = room.lan_ip || fallbackHost;
  const port = room.port || 8080;
  return `http://${host}:${port}/d/${encodeURIComponent(token)}?r=${room.room_code}`;
}

export function welcomeUrl(room: RoomRow, fallbackHost = 'localhost'): string {
  const host = room.lan_ip || fallbackHost;
  const port = room.port || 8080;
  return `http://${host}:${port}/`;
}

/** QR PNG at 512px, ECC level H, 1-module quiet zone (printable at ≥3cm). */
export async function qrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 1,
    width: 512,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

export interface CreateDollWithCardInput {
  roomId: string;
  name: string;
  tagline?: string;
  silhouetteUrl?: string;
  levelType?: LevelType;
}

/** Allocate token + short code and insert the doll in one retrying step. */
export function createDollWithCard(db: Db, input: CreateDollWithCardInput): DollRow {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const cardToken = generateUniqueCardToken(db);
    const shortCode = generateUniqueShortCode(db);
    try {
      return createDoll(db, { ...input, cardToken, shortCode });
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new Error('无法创建带唯一卡片的人偶');
}

/** Generate and store a second token pointing at the same doll (spare card). */
export function issueBackupToken(db: Db, dollId: string): DollRow {
  const doll = getDoll(db, dollId);
  if (!doll) throw new AppError('NOT_FOUND', 404, '人偶不存在');

  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const token = generateUniqueCardToken(db);
    try {
      const updated = setDollBackupToken(db, dollId, token);
      if (updated) return updated;
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new Error('无法分配备用 token');
}

