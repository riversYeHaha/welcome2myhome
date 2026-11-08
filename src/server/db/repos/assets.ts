import { newAssetId, nowIso } from '../../lib/ids';
import type { Db } from '../index';
import type { AssetKind, AssetRow } from '../rows';

export interface RecordAssetInput {
  roomId: string;
  dollId: string;
  kind: AssetKind;
  path: string;
  bytes?: number;
  checksum?: string;
}

/**
 * Insert an `assets` bookkeeping row (tech design §8.3). Files are addressed by
 * `doll_id` on disk; this table is the audit trail for bytes/checksum/kind so
 * the ops screen can spot missing or oversized artefacts.
 */
export function recordAsset(db: Db, input: RecordAssetInput): AssetRow {
  const assetId = newAssetId();
  db.prepare(
    `INSERT INTO assets (asset_id, room_id, doll_id, kind, path, bytes, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    assetId,
    input.roomId,
    input.dollId,
    input.kind,
    input.path,
    input.bytes ?? 0,
    input.checksum ?? '',
    nowIso(),
  );
  return getAsset(db, assetId)!;
}

export function getAsset(db: Db, assetId: string): AssetRow | undefined {
  return db.prepare('SELECT * FROM assets WHERE asset_id = ?').get(assetId) as
    | AssetRow
    | undefined;
}

export function listDollAssets(db: Db, dollId: string): AssetRow[] {
  return db
    .prepare('SELECT * FROM assets WHERE doll_id = ? ORDER BY created_at ASC')
    .all(dollId) as AssetRow[];
}

export function deleteDollAssets(db: Db, dollId: string): number {
  return db.prepare('DELETE FROM assets WHERE doll_id = ?').run(dollId).changes;
}
