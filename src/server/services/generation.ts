import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { createGenTask, getGenTask, updateGenTask } from '../db/repos/gen';
import { getDoll, setDollGeneration } from '../db/repos/dolls';
import type { DollRow, GenTaskRow } from '../db/rows';
import { AppError } from '../lib/errors';
import { createDollWithCard } from './cards';

const MAX_PHOTO_EDGE = 1536;

export interface NormalizedPhoto {
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Re-encode and resize the uploaded photo. sharp drops EXIF/GPS metadata when
 * writing a new JPEG, which is the privacy baseline from tech design §10.5.
 */
export async function normalizePhoto(input: Buffer): Promise<NormalizedPhoto> {
  if (input.length === 0) {
    throw new AppError('INVALID_PHOTO', 422, '照片内容为空');
  }

  try {
    const image = sharp(input, { failOn: 'error' }).rotate();
    const meta = await image.metadata();
    if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) {
      throw new Error(`unsupported format ${meta.format ?? 'unknown'}`);
    }

    const buffer = await image
      .resize({
        width: MAX_PHOTO_EDGE,
        height: MAX_PHOTO_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();

    const outputMeta = await sharp(buffer).metadata();
    return {
      buffer,
      width: outputMeta.width ?? 0,
      height: outputMeta.height ?? 0,
      bytes: buffer.length,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_PHOTO', 422, '只支持 JPG / PNG / WebP 照片');
  }
}

export interface CreateDollFromPhotoInput {
  roomId: string;
  name: string;
  tagline?: string;
  photo: Buffer;
}

export interface CreatedDollWithTask {
  doll: DollRow;
  task: GenTaskRow;
}

/**
 * Create the doll, persist the normalized photo and open a generation task.
 * The manual provider stops at `awaiting_upload` until the host uploads a GLB.
 */
export async function createDollFromPhoto(
  db: Db,
  config: AppConfig,
  input: CreateDollFromPhotoInput,
): Promise<CreatedDollWithTask> {
  const photo = await normalizePhoto(input.photo);

  const doll = createDollWithCard(db, {
    roomId: input.roomId,
    name: input.name,
    tagline: input.tagline,
  });

  const photoPath = join(config.paths.photos, `${doll.doll_id}_src.jpg`);
  mkdirSync(config.paths.photos, { recursive: true });
  writeFileSync(photoPath, photo.buffer);

  const task = createGenTask(db, {
    roomId: input.roomId,
    dollId: doll.doll_id,
    provider: config.generation.provider,
  });

  const awaiting = updateGenTask(db, task.task_id, {
    status: 'queued',
    stage: 'awaiting_upload',
    percent: 30,
    error: null,
  });

  const updatedDoll = setDollGeneration(db, doll.doll_id, {
    genStatus: 'queued',
    genTaskId: task.task_id,
    sourcePhoto: photoPath,
  });

  return {
    doll: updatedDoll ?? doll,
    task: awaiting ?? task,
  };
}

function assertGlb(buffer: Buffer): void {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('ascii') !== 'glTF') {
    throw new AppError('INVALID_MODEL', 422, '只支持 GLB 模型文件');
  }
}

/**
 * Manual provider completion (T1205): store the GLB and mark the task done.
 * Draco/Blender post-processing hooks land here later.
 */
export function ingestDollModel(
  db: Db,
  config: AppConfig,
  dollId: string,
  buffer: Buffer,
): DollRow {
  const doll = getDoll(db, dollId);
  if (!doll) throw new AppError('NOT_FOUND', 404, '人偶不存在');

  assertGlb(buffer);

  const modelPath = join(config.paths.models, `${doll.doll_id}.glb`);
  mkdirSync(config.paths.models, { recursive: true });
  writeFileSync(modelPath, buffer);

  const updated = setDollGeneration(db, doll.doll_id, {
    genStatus: 'done',
    baseModelUrl: `/assets/models/${doll.doll_id}.glb`,
  });

  if (doll.gen_task_id) {
    updateGenTask(db, doll.gen_task_id, {
      status: 'done',
      stage: 'done',
      percent: 100,
      error: null,
    });
  }

  return updated ?? doll;
}

export function getGenerationTask(db: Db, taskId: string): GenTaskRow | undefined {
  return getGenTask(db, taskId);
}
