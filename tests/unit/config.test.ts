import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../../src/server/config';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadConfig', () => {
  it('loads defaults and applies env overrides', () => {
    const config = loadConfig({ rootDir: repoRoot, env: { PORT: '9090', LOG_LEVEL: 'debug' } });

    expect(config.server.port).toBe(9090);
    expect(config.logging.level).toBe('debug');
    expect(config.paths.root).toBe(repoRoot);
    expect(config.paths.data).toBe(join(repoRoot, 'data'));
    expect(config.effects.particleTiers).toEqual([120, 60, 24]);
  });

  it('creates the data directories on demand', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'config'), { recursive: true });
    copyFileSync(join(repoRoot, 'config/default.json'), join(dir, 'config/default.json'));

    const config = loadConfig({ rootDir: dir, env: {} });
    ensureDataDirs(config.paths);

    expect(existsSync(config.paths.data)).toBe(true);
    expect(existsSync(config.paths.photos)).toBe(true);
    expect(existsSync(config.paths.models)).toBe(true);
    expect(existsSync(config.paths.backups)).toBe(true);
    expect(existsSync(config.paths.web)).toBe(false);
  });

  it('rejects invalid configuration and names the field', () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config/default.json'), JSON.stringify({ server: { port: 'nope' } }));

    expect(() => loadConfig({ rootDir: dir, env: {} })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ rootDir: dir, env: {} })).toThrow(/server\.port/);
  });

  it('fails clearly when the config file is missing', () => {
    const dir = makeTempDir();
    expect(() => loadConfig({ rootDir: dir, env: {} })).toThrow(/Configuration file not found/);
  });
});
