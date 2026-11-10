import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateDollModel } from '../../src/server/services/glb';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const presetsDir = join(repoRoot, 'assets/presets');

/**
 * Guards the committed preset GLBs: the fallback path copies these files to a
 * doll when generation fails, so they must stay valid, small and low-poly.
 */
describe('bundled preset dolls', () => {
  it('ships six valid low-poly GLBs', () => {
    const files = readdirSync(presetsDir)
      .filter((name) => name.endsWith('.glb'))
      .sort();

    expect(files).toEqual([
      'preset-01.glb',
      'preset-02.glb',
      'preset-03.glb',
      'preset-04.glb',
      'preset-05.glb',
      'preset-06.glb',
    ]);

    for (const name of files) {
      const buffer = readFileSync(join(presetsDir, name));
      const info = validateDollModel(buffer);
      expect(info.triangles).toBeGreaterThan(100);
      expect(info.triangles).toBeLessThanOrEqual(6000);
      expect(info.bytes).toBeLessThan(1_000_000);
      expect(info.textures).toBe(0);
    }
  });

  it('keeps the regeneration runner script in the repo', () => {
    expect(existsSync(join(repoRoot, 'scripts/blender/make-presets.py'))).toBe(true);
    expect(existsSync(join(repoRoot, 'scripts/blender/clean.py'))).toBe(true);
  });
});
