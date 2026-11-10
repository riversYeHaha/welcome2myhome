import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { recordAsset } from '../db/repos/assets';
import { createGenTask, getGenTask, updateGenTask } from '../db/repos/gen';
import { getDoll, setDollGeneration } from '../db/repos/dolls';
import type { DollRow, GenTaskRow } from '../db/rows';
import type { GenerationQueue } from './gen-queue';
import { AppError } from '../lib/errors';
import { cleanDollModel } from './blender';
import { createDollWithCard } from './cards';
import { validateDollModel, type GlbInfo } from './glb';
import { createLux3DClient } from './lux3d';

const MAX_PHOTO_EDGE = 1536;

/** Docs §7.3: Blender output should stay under 15k triangles. */
const BLENDER_MAX_TRIANGLES = 15_000;
/** Docs §7.3: doll height after normalization. */
const BLENDER_TARGET_HEIGHT = 0.35;

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
  /** When provided, Lux3D work goes through the serial queue instead of starting inline. */
  queue?: GenerationQueue;
  roomId: string;
  name: string;
  tagline?: string;
  photo: Buffer;
}

export interface CreatedDollWithTask {
  doll: DollRow;
  task: GenTaskRow;
}

export interface Lux3DProvider {
  uploadImage(buffer: Buffer, filename?: string): Promise<string>;
  createImgTo3D(
    imageUrl: string,
    options: { version: 'G1' | 'G1-Turbo'; faceCount: number; enablePbr: boolean },
  ): Promise<string>;
  waitForTask(
    taskId: string,
    onProgress?: (status: number, elapsedMs: number) => void,
  ): Promise<string[]>;
  download(url: string): Promise<Buffer>;
  glbFromOutputs(outputs: string[]): string;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function modelPathOf(config: AppConfig, dollId: string): string {
  return join(config.paths.models, `${dollId}.glb`);
}

function rawModelPathOf(config: AppConfig, dollId: string): string {
  return join(config.paths.models, `${dollId}_raw.glb`);
}

function cleanModelPathOf(config: AppConfig, dollId: string): string {
  return join(config.paths.models, `${dollId}_clean.glb`);
}

function silhouettePathOf(config: AppConfig, dollId: string): string {
  return join(config.paths.silhouettes, `${dollId}_silhouette.png`);
}

/** `assets/presets/*.glb` bundled with the repo (tech design §7.5). */
function presetModels(config: AppConfig): string[] {
  const dir = join(config.paths.root, 'assets/presets');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.glb'))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function writeBlenderSidecar(
  config: AppConfig,
  dollId: string,
  payload: Record<string, unknown>,
): void {
  try {
    mkdirSync(config.paths.models, { recursive: true });
    writeFileSync(
      join(config.paths.models, `${dollId}_blender.json`),
      JSON.stringify({ at: new Date().toISOString(), doll_id: dollId, ...payload }, null, 2),
    );
  } catch {
    // Bookkeeping only: never fail generation because a sidecar could not be written.
  }
}

function storeDollModel(db: Db, config: AppConfig, doll: DollRow, buffer: Buffer): DollRow {
  mkdirSync(config.paths.models, { recursive: true });
  const rawPath = rawModelPathOf(config, doll.doll_id);
  const modelPath = modelPathOf(config, doll.doll_id);
  writeFileSync(rawPath, buffer);
  // The raw file is immediately servable; Blender may replace it with a cleaned
  // version later without ever leaving the doll without a model.
  writeFileSync(modelPath, buffer);

  recordAsset(db, {
    roomId: doll.room_id,
    dollId: doll.doll_id,
    kind: 'base_model',
    path: modelPath,
    bytes: buffer.length,
    checksum: sha256(buffer),
  });

  return setDollGeneration(db, doll.doll_id, {
    genStatus: 'done',
    baseModelUrl: `/assets/models/${doll.doll_id}.glb`,
  }) ?? doll;
}

export interface FallbackOutcome {
  presetApplied: boolean;
  taskId: string | null;
  reason: string;
}

/**
 * Preset fallback (tech design §7.5 / T1204): when generation fails or no model
 * exists, copy a bundled preset GLB if the repo has one, otherwise keep the
 * procedural placeholder the viewer already renders. The task row always gets
 * `fallback_used=1` so the host screen can tell real from fallback models.
 */
export function applyFallbackModel(
  db: Db,
  config: AppConfig,
  dollId: string,
  reason: string,
  taskId?: string | null,
): FallbackOutcome {
  const doll = getDoll(db, dollId);
  const effectiveTaskId = taskId ?? doll?.gen_task_id ?? null;
  const safeReason = reason.slice(0, 200);

  let presetApplied = false;
  if (doll) {
    const modelPath = modelPathOf(config, doll.doll_id);
    const hasModel = existsSync(modelPath);
    if (!hasModel) {
      const preset = presetModels(config)[0] ?? null;
      if (preset) {
        mkdirSync(config.paths.models, { recursive: true });
        copyFileSync(preset, modelPath);
        const bytes = readFileSync(modelPath).length;
        recordAsset(db, {
          roomId: doll.room_id,
          dollId: doll.doll_id,
          kind: 'preset_model',
          path: preset,
          bytes,
        });
        recordAsset(db, {
          roomId: doll.room_id,
          dollId: doll.doll_id,
          kind: 'base_model',
          path: modelPath,
          bytes,
        });
        setDollGeneration(db, doll.doll_id, {
          genStatus: 'done',
          baseModelUrl: `/assets/models/${doll.doll_id}.glb`,
        });
        presetApplied = true;
      } else {
        setDollGeneration(db, doll.doll_id, { genStatus: 'failed' });
      }
    }
  }

  if (effectiveTaskId) {
    updateGenTask(db, effectiveTaskId, {
      status: 'failed',
      stage: presetApplied ? 'fallback' : 'failed',
      percent: 100,
      error: safeReason,
      fallbackUsed: true,
    });
  }

  return { presetApplied, taskId: effectiveTaskId, reason: safeReason };
}

export interface BlenderPostProcessResult {
  ok: boolean;
  reason: string;
  silhouetteUrl?: string;
}

/**
 * Blender cleanup + silhouette for one doll (tech design §7.1 steps [D]/[E]).
 * Never throws: on any failure the raw GLB stays in place and the reason is
 * recorded next to the model for the host/ops screen.
 */
export async function postProcessDollModel(
  db: Db,
  config: AppConfig,
  dollId: string,
): Promise<BlenderPostProcessResult> {
  const rawPath = rawModelPathOf(config, dollId);
  const cleanPath = cleanModelPathOf(config, dollId);
  const silhouettePath = silhouettePathOf(config, dollId);

  const outcome = await cleanDollModel(
    config,
    { input: rawPath, output: cleanPath, silhouette: silhouettePath },
    { maxTriangles: BLENDER_MAX_TRIANGLES, targetHeight: BLENDER_TARGET_HEIGHT },
  );
  if (!outcome.ok) {
    writeBlenderSidecar(config, dollId, {
      ok: false,
      code: outcome.code,
      reason: outcome.reason,
      duration_ms: outcome.durationMs,
    });
    return { ok: false, reason: outcome.reason };
  }

  let info: GlbInfo;
  try {
    info = validateDollModel(readFileSync(cleanPath));
  } catch (error) {
    const reason = `Blender 产出的 GLB 未通过校验：${messageOf(error)}`;
    writeBlenderSidecar(config, dollId, { ok: false, code: 'CLEAN_GLB_INVALID', reason });
    return { ok: false, reason };
  }

  const doll = getDoll(db, dollId);
  if (!doll) return { ok: false, reason: '人偶已不存在' };

  const modelPath = modelPathOf(config, dollId);
  copyFileSync(cleanPath, modelPath);
  const bytes = readFileSync(modelPath).length;
  recordAsset(db, {
    roomId: doll.room_id,
    dollId,
    kind: 'base_model',
    path: modelPath,
    bytes,
    checksum: sha256(readFileSync(modelPath)),
  });

  let silhouetteUrl: string | undefined;
  if (outcome.summary.silhouette_ok && existsSync(silhouettePath)) {
    silhouetteUrl = `/assets/silhouettes/${basename(silhouettePath)}`;
    recordAsset(db, {
      roomId: doll.room_id,
      dollId,
      kind: 'silhouette',
      path: silhouettePath,
      bytes: readFileSync(silhouettePath).length,
    });
  }

  setDollGeneration(db, dollId, silhouetteUrl ? { silhouetteUrl } : {});

  writeBlenderSidecar(config, dollId, {
    ok: true,
    summary: outcome.summary,
    glb: { triangles: info.triangles, bytes: info.bytes, textures: info.textures },
    silhouette_url: silhouetteUrl ?? null,
  });

  return {
    ok: true,
    reason: '',
    ...(silhouetteUrl ? { silhouetteUrl } : {}),
  };
}

/**
 * Background Lux3D pipeline. Updates the task row at each stage and, on
 * success, writes the GLB through the same ingestion path as manual uploads.
 * Any failure lands on the preset fallback and marks `fallback_used`.
 */
export async function runLux3DGeneration(
  db: Db,
  config: AppConfig,
  doll: DollRow,
  task: GenTaskRow,
  photo: Buffer,
  provider: Lux3DProvider,
): Promise<void> {
  const progress = (
    stage: string,
    percent: number,
    status: GenTaskRow['status'] = 'running',
  ): void => {
    updateGenTask(db, task.task_id, { status, stage, percent, error: null });
  };

  try {
    progress('uploading_image', 10);
    const imageUrl = await provider.uploadImage(photo);

    progress('creating_task', 20);
    const providerTaskId = await provider.createImgTo3D(imageUrl, {
      version: config.generation.version,
      faceCount: config.generation.faceCount,
      enablePbr: config.generation.enablePbr,
    });

    progress('generating', 30);
    const outputs = await provider.waitForTask(providerTaskId, (status, elapsedMs) => {
      const percent = Math.min(80, 30 + Math.floor(elapsedMs / 1000) * 2);
      progress(`generating_${status}`, percent);
    });

    progress('downloading', 85);
    const glbUrl = provider.glbFromOutputs(outputs);
    const glb = await provider.download(glbUrl);

    progress('verifying', 88);
    validateDollModel(glb);

    progress('storing', 90);
    storeDollModel(db, config, doll, glb);

    if (config.generation.blenderEnabled) {
      progress('blender', 93);
      await postProcessDollModel(db, config, doll.doll_id);
    }

    progress('verify', 97);
    // The runner may be used with a doll created before its task; always close
    // the task explicitly rather than relying on `doll.gen_task_id`.
    updateGenTask(db, task.task_id, {
      status: 'done',
      stage: 'done',
      percent: 100,
      error: null,
      fallbackUsed: false,
    });
  } catch (error) {
    applyFallbackModel(db, config, doll.doll_id, messageOf(error), task.task_id);
  }
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

  const updatedDoll = setDollGeneration(db, doll.doll_id, {
    genStatus: 'queued',
    genTaskId: task.task_id,
    sourcePhoto: photoPath,
  });

  if (config.generation.provider === 'lux3d') {
    const client = createLux3DClient(config);
    if (client) {
      if (input.queue) {
        const queued = updateGenTask(db, task.task_id, {
          status: 'queued',
          stage: 'queued',
          percent: 5,
          error: null,
        });
        input.queue.enqueue(task.task_id);
        return { doll: updatedDoll ?? doll, task: queued ?? task };
      }

      const running = updateGenTask(db, task.task_id, {
        status: 'running',
        stage: 'uploading_image',
        percent: 10,
        error: null,
      });

      void runLux3DGeneration(
        db,
        config,
        updatedDoll ?? doll,
        running ?? task,
        photo.buffer,
        client,
      );

      return {
        doll: updatedDoll ?? doll,
        task: running ?? task,
      };
    }

    const manualFallback = updateGenTask(db, task.task_id, {
      status: 'queued',
      stage: 'awaiting_upload',
      percent: 30,
      error: 'LUX3D_API_KEY 未配置，已切换为手动上传 GLB',
    });

    return { doll: updatedDoll ?? doll, task: manualFallback ?? task };
  }

  const awaiting = updateGenTask(db, task.task_id, {
    status: 'queued',
    stage: 'awaiting_upload',
    percent: 30,
    error: null,
  });

  return {
    doll: updatedDoll ?? doll,
    task: awaiting ?? task,
  };
}

/**
 * Manual provider completion (T1205): validate + store a host-uploaded GLB and
 * mark the task done. Invalid/oversized models are rejected before anything is
 * written and flip the task to the preset fallback state.
 */
export function ingestDollModel(
  db: Db,
  config: AppConfig,
  dollId: string,
  buffer: Buffer,
): DollRow {
  const doll = getDoll(db, dollId);
  if (!doll) throw new AppError('NOT_FOUND', 404, '人偶不存在');

  try {
    validateDollModel(buffer);
  } catch (error) {
    applyFallbackModel(db, config, doll.doll_id, messageOf(error), doll.gen_task_id);
    throw error;
  }

  const updated = storeDollModel(db, config, doll, buffer);

  if (doll.gen_task_id) {
    updateGenTask(db, doll.gen_task_id, {
      status: 'done',
      stage: 'done',
      percent: 100,
      error: null,
      fallbackUsed: false,
    });
  }

  if (config.generation.blenderEnabled) {
    // Fire and forget: the cleaned model replaces the raw one when ready. The
    // upload response must not block on Blender (90s budget).
    void postProcessDollModel(db, config, doll.doll_id).catch(() => undefined);
  }

  return updated;
}

export function getGenerationTask(db: Db, taskId: string): GenTaskRow | undefined {
  return getGenTask(db, taskId);
}
