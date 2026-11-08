import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config';

/**
 * Blender headless wrapper (tech design §7.3 / T1205).
 *
 * The heavy lifting lives in `scripts/blender/clean.py`; this module only
 * spawns Blender with a hard timeout and turns stdout into a typed result.
 * Every failure path is recoverable: callers keep the raw GLB and record why
 * the cleanup was skipped, so generation is never blocked by a missing Blender.
 */

export const BLENDER_RESULT_PREFIX = 'WTM_BLENDER_RESULT ';
export const BLENDER_ERROR_PREFIX = 'WTM_BLENDER_ERROR ';

/** Docs §5.7: Blender budget is 90s inside the 300s generation window. */
export const BLENDER_TIMEOUT_MS = 90_000;

export type BlenderFailureCode =
  | 'BLENDER_DISABLED'
  | 'BLENDER_MISSING'
  | 'SCRIPT_MISSING'
  | 'BLENDER_TIMEOUT'
  | 'BLENDER_FAILED'
  | 'BLENDER_INVALID_OUTPUT';

export interface BlenderSummary {
  ok: boolean;
  triangles_before: number;
  triangles_after: number;
  vertices: number;
  meshes_joined: number;
  removed_objects: number;
  textures_resized: number;
  height: number;
  width: number;
  depth: number;
  scale: number;
  target_height: number;
  max_tris: number;
  silhouette_ok: boolean;
  silhouette_error: string | null;
  engine: string;
  blender: string;
  duration_ms: number;
  output: string;
  silhouette: string | null;
}

export type BlenderOutcome =
  | { ok: true; summary: BlenderSummary; durationMs: number }
  | { ok: false; code: BlenderFailureCode; reason: string; durationMs: number };

export interface BlenderCleanRequest {
  input: string;
  output: string;
  silhouette: string;
  maxTriangles?: number;
  targetHeight?: number;
  silhouetteSize?: number;
  timeoutMs?: number;
}

export interface BlenderRunOptions extends BlenderCleanRequest {
  blenderPath: string;
  scriptPath: string;
}

function failure(
  code: BlenderFailureCode,
  reason: string,
  startedAt: number,
): BlenderOutcome {
  return { ok: false, code, reason, durationMs: Date.now() - startedAt };
}

/** Shorten a Blender diagnostic so it is safe to store/display. */
function tidyReason(value: string, max = 240): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, max);
}

/** Locate `scripts/blender/clean.py` from source, bundled or cwd layouts. */
export function resolveBlenderScript(rootDir?: string): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    rootDir ? join(rootDir, 'scripts/blender/clean.py') : null,
    // src/server/services -> repo root; dist/server -> repo root.
    resolve(moduleDir, '../../../scripts/blender/clean.py'),
    resolve(moduleDir, '../../scripts/blender/clean.py'),
    join(process.cwd(), 'scripts/blender/clean.py'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export function isBlenderAvailable(blenderPath: string): boolean {
  if (!blenderPath || !existsSync(blenderPath)) return false;
  try {
    if (!statSync(blenderPath).isFile()) return false;
    accessSync(blenderPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lastJsonLine(stdout: string, prefix: string): unknown {
  const lines = stdout.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith(prefix)) continue;
    try {
      return JSON.parse(line.slice(prefix.length)) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isSummary(value: unknown): value is BlenderSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { triangles_after?: unknown }).triangles_after === 'number'
  );
}

/**
 * Run the cleanup script once. Never throws for environmental problems — the
 * caller gets `{ok:false, code, reason}` and keeps the raw GLB.
 */
export function runBlenderClean(options: BlenderRunOptions): Promise<BlenderOutcome> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? BLENDER_TIMEOUT_MS;

  if (!isBlenderAvailable(options.blenderPath)) {
    return Promise.resolve(
      failure('BLENDER_MISSING', `未找到可执行的 Blender：${options.blenderPath || '(未配置)'}`, startedAt),
    );
  }
  if (!existsSync(options.scriptPath)) {
    return Promise.resolve(
      failure('SCRIPT_MISSING', `缺少 Blender 清理脚本：${options.scriptPath}`, startedAt),
    );
  }
  if (!existsSync(options.input)) {
    return Promise.resolve(failure('BLENDER_FAILED', '原始 GLB 不存在，跳过清理', startedAt));
  }

  const args = [
    '-b',
    '--factory-startup',
    '--python',
    options.scriptPath,
    '--',
    '--input',
    options.input,
    '--output',
    options.output,
    '--silhouette',
    options.silhouette,
    '--max-tris',
    String(options.maxTriangles ?? 15_000),
    '--target-height',
    String(options.targetHeight ?? 0.35),
    '--silhouette-size',
    String(options.silhouetteSize ?? 1024),
  ];

  return new Promise<BlenderOutcome>((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (outcome: BlenderOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // Settle immediately: a killed Blender could leave a helper process
      // holding the stdout pipe open, and the caller must never wait past the
      // documented cleanup budget.
      finish(
        failure(
          'BLENDER_TIMEOUT',
          `Blender 清理超时（${Math.round(timeoutMs / 1000)}s），已继续使用原始 GLB`,
          startedAt,
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    const child = spawn(options.blenderPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BLENDER_HEADLESS: '1' },
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-128 * 1024);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });

    child.on('error', (error: Error) => {
      finish(failure('BLENDER_MISSING', tidyReason(error.message), startedAt));
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        finish(
          failure(
            'BLENDER_TIMEOUT',
            `Blender 清理超时（${Math.round(timeoutMs / 1000)}s），已继续使用原始 GLB`,
            startedAt,
          ),
        );
        return;
      }

      const scriptError = lastJsonLine(stdout, BLENDER_ERROR_PREFIX) as
        | { code?: unknown; message?: unknown }
        | undefined;
      const errorMessage =
        typeof scriptError?.message === 'string' ? scriptError.message : '';

      const summary = lastJsonLine(stdout, BLENDER_RESULT_PREFIX);
      if (isSummary(summary) && summary.ok) {
        const outputOk =
          existsSync(summary.output) && statSync(summary.output).size > 0;
        if (!outputOk) {
          finish(failure('BLENDER_INVALID_OUTPUT', 'Blender 没有产出清理后的 GLB', startedAt));
          return;
        }
        finish({ ok: true, summary, durationMs });
        return;
      }

      const diag = errorMessage || stderr.trim() || stdout.trim();
      finish(
        failure(
          'BLENDER_FAILED',
          tidyReason(diag || `Blender 退出码 ${code ?? 'unknown'}`),
          startedAt,
        ),
      );
    });
  });
}

export interface CleanDollPaths {
  input: string;
  output: string;
  silhouette: string;
}

/**
 * Config-aware entry point used by the generation pipeline. Disabled Blender
 * (`generation.blenderEnabled=false`, the default) is a no-op, not an error.
 */
export function cleanDollModel(
  config: AppConfig,
  paths: CleanDollPaths,
  options: { maxTriangles?: number; targetHeight?: number } = {},
): Promise<BlenderOutcome> {
  const startedAt = Date.now();
  const scriptPath = resolveBlenderScript(config.paths.root);
  const { blenderEnabled, blenderPath, timeoutSec } = config.generation;

  if (!blenderEnabled) {
    return Promise.resolve(
      failure('BLENDER_DISABLED', '未启用 Blender 清理（generation.blenderEnabled=false）', startedAt),
    );
  }
  if (!blenderPath) {
    return Promise.resolve(failure('BLENDER_MISSING', '未配置 generation.blenderPath', startedAt));
  }
  if (!scriptPath) {
    return Promise.resolve(
      failure('SCRIPT_MISSING', '未找到 scripts/blender/clean.py', startedAt),
    );
  }

  return runBlenderClean({
    ...paths,
    blenderPath,
    scriptPath,
    maxTriangles: options.maxTriangles ?? 15_000,
    targetHeight: options.targetHeight ?? 0.35,
    // Docs §5.7: Blender gets at most 90s inside the 300s generation budget.
    timeoutMs: Math.min(timeoutSec > 0 ? timeoutSec * 1000 : BLENDER_TIMEOUT_MS, BLENDER_TIMEOUT_MS),
  });
}
