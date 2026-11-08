import { Buffer } from 'node:buffer';

/**
 * Test-only GLB builders. Everything is constructed in memory — no network,
 * no binary fixtures checked into the repo.
 */

export interface GlbChunk {
  type: 'JSON' | 'BIN' | (string & {});
  data: Buffer;
}

export interface BuildGlbOptions {
  /** Override the 4-byte magic (`glTF` by default). */
  magic?: string;
  version?: number;
  /** Override the header length field (to simulate truncated files). */
  declaredLength?: number;
  /** Raw JSON text; when omitted the `json` argument is stringified. */
  rawJsonText?: string;
  bin?: Buffer;
  /** Custom chunk list; ignores `json`/`bin`/`rawJsonText`. */
  chunks?: GlbChunk[];
}

function padTo4(buffer: Buffer, fill: number): Buffer {
  const remainder = buffer.length % 4;
  if (remainder === 0) return buffer;
  const padded = Buffer.alloc(buffer.length + (4 - remainder), fill);
  buffer.copy(padded);
  return padded;
}

function typeCode(type: string): number {
  return Buffer.from(type.padEnd(4, '\0'), 'ascii').readUInt32LE(0);
}

function chunk(type: string, data: Buffer, fill: number): Buffer {
  const padded = padTo4(data, fill);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(padded.length, 0);
  header.writeUInt32LE(typeCode(type), 4);
  return Buffer.concat([header, padded]);
}

export function buildGlbFromChunks(
  chunks: GlbChunk[],
  options: Pick<BuildGlbOptions, 'magic' | 'version' | 'declaredLength'> = {},
): Buffer {
  const magic = Buffer.from((options.magic ?? 'glTF').padEnd(4, ' '), 'ascii').subarray(0, 4);
  const parts = chunks.map((item) =>
    chunk(item.type, item.data, item.type === 'JSON' ? 0x20 : 0),
  );
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  magic.copy(header, 0);
  header.writeUInt32LE(options.version ?? 2, 4);
  header.writeUInt32LE(options.declaredLength ?? 12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** Serialize a glTF JSON document (plus optional BIN chunk) into GLB bytes. */
export function buildGlb(json: unknown, options: BuildGlbOptions = {}): Buffer {
  if (options.chunks) return buildGlbFromChunks(options.chunks, options);

  const text =
    options.rawJsonText ?? `${JSON.stringify(json, null, 0)}\n`;
  const chunks: GlbChunk[] = [{ type: 'JSON', data: Buffer.from(text, 'utf8') }];
  if (options.bin) chunks.push({ type: 'BIN', data: options.bin });
  return buildGlbFromChunks(chunks, options);
}

export interface GlbJsonOptions {
  triangles?: number;
  /** Use an index accessor (default true). */
  indices?: boolean;
  textures?: number;
  materials?: number;
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  generator?: string;
  /** Emit a real BIN chunk so the fixture is loadable by three.js. */
  withBinary?: boolean;
}

export interface MinimalGlb {
  json: Record<string, unknown>;
  bin: Buffer | null;
}

/**
 * Build a glTF 2.0 JSON document describing a single mesh with `triangles`
 * faces. Geometry is degenerate (all vertices at the origin) but structurally
 * valid, which is all the validator needs.
 */
export function minimalGlbJson(options: GlbJsonOptions = {}): MinimalGlb {
  const triangles = options.triangles ?? 1;
  const useIndices = options.indices ?? true;
  const vertexCount = triangles * 3;
  const indexCount = triangles * 3;
  const textures = options.textures ?? 0;
  const materials = options.materials ?? (textures > 0 ? 1 : 0);

  const bufferViews: Record<string, unknown>[] = [
    { buffer: 0, byteOffset: 0, byteLength: vertexCount * 12 },
  ];
  const accessors: Record<string, unknown>[] = [
    {
      bufferView: 0,
      componentType: 5126,
      count: vertexCount,
      type: 'VEC3',
      min: [0, 0, 0],
      max: [0, 0, 0],
    },
  ];
  if (useIndices) {
    bufferViews.push({
      buffer: 0,
      byteOffset: vertexCount * 12,
      byteLength: indexCount * 2,
    });
    accessors.push({
      bufferView: 1,
      componentType: 5123,
      count: indexCount,
      type: 'SCALAR',
    });
  }

  const images = Array.from({ length: textures }, (_item, index) => ({
    uri: `texture-${index}.png`,
  }));
  const textureList = Array.from({ length: textures }, (_item, index) => ({
    source: index,
  }));
  const materialList = Array.from({ length: materials }, (_item, index) => ({
    name: `material-${index}`,
    pbrMetallicRoughness: textures > 0 ? { baseColorTexture: { index: 0 } } : {},
  }));

  const json: Record<string, unknown> = {
    asset: {
      version: '2.0',
      generator: options.generator ?? 'wtm-test-fixture',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            ...(useIndices ? { indices: 1 } : {}),
            mode: 4,
          },
        ],
      },
    ],
    accessors,
    bufferViews,
  };

  if (options.withBinary) {
    const binLength = vertexCount * 12 + (useIndices ? indexCount * 2 : 0);
    json.buffers = [{ byteLength: binLength }];
  }
  if (textures > 0) {
    json.images = images;
    json.textures = textureList;
  }
  if (materialList.length > 0) json.materials = materialList;
  if (options.extensionsUsed) json.extensionsUsed = options.extensionsUsed;
  if (options.extensionsRequired) json.extensionsRequired = options.extensionsRequired;

  let bin: Buffer | null = null;
  if (options.withBinary) {
    const binLength = vertexCount * 12 + (useIndices ? indexCount * 2 : 0);
    bin = Buffer.alloc(binLength);
  }

  return { json, bin };
}

/** Valid GLB bytes with `triangles` faces (safe for ingestion tests). */
export function triangleGlb(triangles = 1, options: GlbJsonOptions = {}): Buffer {
  const fixture = minimalGlbJson({
    ...options,
    triangles,
    withBinary: options.withBinary ?? true,
  });
  return buildGlb(fixture.json, fixture.bin ? { bin: fixture.bin } : {});
}

/** Draco-compressed fixture: accessors keep counts, primitives declare the extension. */
export function dracoGlb(triangles = 2): Buffer {
  const fixture = minimalGlbJson({ triangles, indices: true });
  const json = fixture.json as Record<string, unknown>;
  json.extensionsUsed = ['KHR_draco_mesh_compression'];
  json.extensionsRequired = ['KHR_draco_mesh_compression'];
  const meshes = json.meshes as Array<{ primitives: Record<string, unknown>[] }>;
  meshes[0]!.primitives[0]!.extensions = {
    KHR_draco_mesh_compression: {
      bufferView: 0,
      attributes: { POSITION: 0 },
    },
  };
  return buildGlb(json);
}

/** Meshopt-compressed fixture (rejected by the server). */
export function meshoptGlb(triangles = 2): Buffer {
  const fixture = minimalGlbJson({ triangles, indices: true });
  const json = fixture.json as Record<string, unknown>;
  json.extensionsUsed = ['EXT_meshopt_compression'];
  json.extensionsRequired = ['EXT_meshopt_compression'];
  return buildGlb(json);
}
