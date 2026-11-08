import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/server/lib/errors';
import {
  DEFAULT_GLB_LIMITS,
  assertGlbLimits,
  describeGlb,
  inspectGlb,
  validateDollModel,
} from '../../src/server/services/glb';
import {
  buildGlb,
  buildGlbFromChunks,
  dracoGlb,
  meshoptGlb,
  minimalGlbJson,
  triangleGlb,
} from '../helpers/glb';

function errorOf(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the call to throw');
}

describe('GLB structural validation', () => {
  it('parses a minimal valid GLB and reports metrics', () => {
    const buffer = triangleGlb(2);
    const info = inspectGlb(buffer);

    expect(info.version).toBe(2);
    expect(info.bytes).toBe(buffer.length);
    expect(info.triangles).toBe(2);
    expect(info.vertices).toBe(6);
    expect(info.meshes).toBe(1);
    expect(info.primitives).toBe(1);
    expect(info.hasBinaryChunk).toBe(true);
    expect(info.binaryBytes).toBeGreaterThan(0);
    expect(info.compression).toBeNull();
    expect(info.generator).toBe('wtm-test-fixture');
  });

  it('counts triangles from POSITION when primitives have no indices', () => {
    const fixture = minimalGlbJson({ triangles: 5, indices: false });
    const info = inspectGlb(buildGlb(fixture.json));

    expect(info.triangles).toBe(5);
    expect(info.vertices).toBe(15);
  });

  it('counts textures, images and materials', () => {
    const info = inspectGlb(triangleGlb(1, { textures: 3, materials: 2 }));

    expect(info.textures).toBe(3);
    expect(info.images).toBe(3);
    expect(info.materials).toBe(2);
  });

  it('treats non-triangle primitive modes as zero faces', () => {
    const fixture = minimalGlbJson({ triangles: 3, indices: false });
    const json = fixture.json as {
      meshes: Array<{ primitives: Array<Record<string, unknown>> }>;
    };
    json.meshes[0]!.primitives[0]!.mode = 1; // LINES

    expect(inspectGlb(buildGlb(json)).triangles).toBe(0);
  });

  it('skips unknown trailing chunks allowed by the spec', () => {
    const fixture = minimalGlbJson({ triangles: 1 });
    const buffer = buildGlbFromChunks([
      { type: 'JSON', data: Buffer.from(JSON.stringify(fixture.json)) },
      { type: 'XTRA', data: Buffer.from('abcd') },
    ]);

    expect(inspectGlb(buffer).triangles).toBe(1);
  });

  it('rejects empty, short and non-GLB buffers', () => {
    expect(errorOf(() => inspectGlb(Buffer.alloc(0))).code).toBe('INVALID_MODEL');
    expect(errorOf(() => inspectGlb(Buffer.from('glTF'))).code).toBe('INVALID_MODEL');
    expect(errorOf(() => inspectGlb(Buffer.from('nope nope nope'))).code).toBe(
      'INVALID_MODEL',
    );
  });

  it('rejects wrong GLB versions and truncated files', () => {
    const json = minimalGlbJson({ triangles: 1 });
    const wrongVersion = buildGlb(json.json, { version: 1 });
    expect(errorOf(() => inspectGlb(wrongVersion)).message).toContain('版本 1');

    const valid = triangleGlb(1);
    const truncated = buildGlb(json.json, {
      declaredLength: valid.length + 64,
    });
    expect(errorOf(() => inspectGlb(truncated)).message).toContain('不完整');
  });

  it('rejects a non-JSON first chunk, broken JSON and missing asset version', () => {
    const fixture = minimalGlbJson({ triangles: 1 });
    const binFirst = buildGlbFromChunks([
      { type: 'XTRA', data: Buffer.alloc(4) },
      { type: 'JSON', data: Buffer.from(JSON.stringify(fixture.json)) },
    ]);
    expect(errorOf(() => inspectGlb(binFirst)).message).toContain('第一个 chunk');

    const broken = buildGlb(fixture.json, { rawJsonText: '{not json' });
    expect(errorOf(() => inspectGlb(broken)).message).toContain('JSON');

    const noAsset = buildGlb({ scenes: [], meshes: [] });
    expect(errorOf(() => inspectGlb(noAsset)).message).toContain('asset.version');
  });

  it('rejects accessor references and non-2.0 JSON versions', () => {
    const fixture = minimalGlbJson({ triangles: 1 });
    const json = fixture.json as {
      asset: { version: string };
      meshes: Array<{ primitives: Array<Record<string, unknown>> }>;
    };
    json.meshes[0]!.primitives[0]!.attributes = { POSITION: 9 };

    expect(errorOf(() => inspectGlb(buildGlb(json))).message).toContain('accessor');

    json.meshes[0]!.primitives[0]!.attributes = { POSITION: 0 };
    json.meshes[0]!.primitives[0]!.indices = 7;
    expect(errorOf(() => inspectGlb(buildGlb(json))).message).toContain('accessor');

    const oldVersion = minimalGlbJson({ triangles: 1 });
    (oldVersion.json.asset as { version: string }).version = '1.0';
    expect(errorOf(() => inspectGlb(buildGlb(oldVersion.json))).message).toContain('2.0');
  });
});

describe('GLB compression extension handling', () => {
  it('accepts Draco-compressed GLBs and reports the extension', () => {
    const info = inspectGlb(dracoGlb(12));

    expect(info.compression).toBe('draco');
    expect(info.triangles).toBe(12);
    expect(info.extensionsRequired).toContain('KHR_draco_mesh_compression');
  });

  it('rejects meshopt-compressed GLBs with an actionable message', () => {
    const error = errorOf(() => inspectGlb(meshoptGlb(2)));

    expect(error.code).toBe('INVALID_MODEL');
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain('EXT_meshopt_compression');
    expect(error.message).toContain('重新导出');
  });
});

describe('GLB budget limits', () => {
  const baseInfo = inspectGlb(triangleGlb(1));

  it('accepts models exactly at the limits', () => {
    expect(() =>
      validateDollModel(triangleGlb(300_000, { withBinary: false })),
    ).not.toThrow();
    expect(DEFAULT_GLB_LIMITS).toEqual({
      maxBytes: 8 * 1024 * 1024,
      maxTriangles: 300_000,
    });
  });

  it('rejects oversize files with MODEL_TOO_LARGE', () => {
    const error = errorOf(() =>
      assertGlbLimits({ ...baseInfo, bytes: DEFAULT_GLB_LIMITS.maxBytes + 1 }),
    );

    expect(error.code).toBe('MODEL_TOO_LARGE');
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain('8.0 MB');
  });

  it('rejects too many triangles with MODEL_TOO_COMPLEX', () => {
    const error = errorOf(() =>
      validateDollModel(triangleGlb(300_001, { withBinary: false })),
    );

    expect(error.code).toBe('MODEL_TOO_COMPLEX');
    expect(error.statusCode).toBe(422);
    expect(error.message).toContain('300001');
    expect(error.message).toContain('300000');
  });

  it('summarizes assets without leaking paths', () => {
    const info = inspectGlb(dracoGlb(3));
    const summary = describeGlb(info);

    expect(summary).toContain('3 tris');
    expect(summary).toContain('draco');
    expect(summary).not.toContain('/');
  });
});
