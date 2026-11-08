import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/server/config';
import {
  cleanDollModel,
  resolveBlenderScript,
  runBlenderClean,
} from '../../src/server/services/blender';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-blender-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configWithGeneration(patch: Partial<AppConfig['generation']>): AppConfig {
  const base = loadConfig({ rootDir: repoRoot, env: {} });
  return {
    ...base,
    generation: { ...base.generation, ...patch },
  };
}

const paths = (dir: string) => ({
  input: join(dir, 'in.glb'),
  output: join(dir, 'out.glb'),
  silhouette: join(dir, 'out.png'),
});

describe('Blender headless wrapper', () => {
  it('resolves the bundled cleanup script', () => {
    const script = resolveBlenderScript(repoRoot);

    expect(script).toBe(join(repoRoot, 'scripts/blender/clean.py'));
    expect(existsSync(script!)).toBe(true);
  });

  it('skips cleanup when Blender is disabled in config', async () => {
    const dir = tempDir();
    const outcome = await cleanDollModel(
      configWithGeneration({ blenderEnabled: false }),
      paths(dir),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('BLENDER_DISABLED');
      expect(outcome.reason).toContain('blenderEnabled');
    }
  });

  it('degrades gracefully when the Blender binary is missing', async () => {
    const dir = tempDir();
    const outcome = await cleanDollModel(
      configWithGeneration({
        blenderEnabled: true,
        blenderPath: '/nonexistent/Blender',
      }),
      paths(dir),
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('BLENDER_MISSING');
  });

  it('kills a hanging Blender at the timeout and reports it', async () => {
    const dir = tempDir();
    const fake = join(dir, 'fake-blender.sh');
    writeFileSync(fake, '#!/bin/sh\nsleep 1\n');
    chmodSync(fake, 0o755);
    writeFileSync(paths(dir).input, 'glTF');

    const started = Date.now();
    const outcome = await runBlenderClean({
      ...paths(dir),
      blenderPath: fake,
      scriptPath: join(repoRoot, 'scripts/blender/clean.py'),
      timeoutMs: 200,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('BLENDER_TIMEOUT');
      expect(outcome.reason).toContain('超时');
    }
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(dirname(fake)).toBe(dir);
  });
});
