import { AppError } from '../lib/errors';

/**
 * Structural GLB validation and asset metrics (tech design §7.4 / T1204).
 *
 * The parser intentionally reads only the container header, the JSON chunk and
 * the accessor counts: it never decodes geometry or images, so it is cheap and
 * safe to run on every upload. Error messages are user-facing Chinese text and
 * only ever contain structural facts (numbers, extension names) — never photo
 * paths, answers or other private data.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** Upload ceiling from tech design §7.4 (2MB target, 8MB hard limit). */
export const GLB_MAX_BYTES = 8 * 1024 * 1024;
/** Mirrors `generation.faceCount` upper bound (300k tris). */
export const GLB_MAX_TRIANGLES = 300_000;

export interface GlbLimits {
  maxBytes: number;
  maxTriangles: number;
}

export const DEFAULT_GLB_LIMITS: GlbLimits = {
  maxBytes: GLB_MAX_BYTES,
  maxTriangles: GLB_MAX_TRIANGLES,
};

/** Compression extensions the viewer can / cannot decode. */
export const DRACO_EXTENSION = 'KHR_draco_mesh_compression';
export const MESHOPT_EXTENSION = 'EXT_meshopt_compression';

export interface GlbInfo {
  /** Actual file size in bytes. */
  bytes: number;
  /** GLB container version (must be 2). */
  version: number;
  generator: string | null;
  /** Number of triangles across all mesh primitives. */
  triangles: number;
  /** VERTEX count summed per primitive (not de-duplicated). */
  vertices: number;
  meshes: number;
  primitives: number;
  materials: number;
  textures: number;
  images: number;
  animations: number;
  extensionsUsed: string[];
  extensionsRequired: string[];
  /** Geometry compression detected in the extension lists. */
  compression: 'draco' | 'meshopt' | null;
  hasBinaryChunk: boolean;
  binaryBytes: number;
}

interface GltfAccessor {
  count?: unknown;
}

interface GltfPrimitive {
  attributes?: Record<string, unknown>;
  indices?: unknown;
  mode?: unknown;
}

interface GltfMesh {
  primitives?: unknown;
}

interface GltfDocument {
  asset?: { version?: unknown; generator?: unknown };
  meshes?: unknown;
  accessors?: unknown;
  materials?: unknown;
  textures?: unknown;
  images?: unknown;
  animations?: unknown;
  extensionsUsed?: unknown;
  extensionsRequired?: unknown;
}

function invalidModel(message: string): AppError {
  return new AppError('INVALID_MODEL', 422, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function accessorCount(
  accessors: readonly GltfAccessor[],
  index: unknown,
  context: string,
): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw invalidModel(`GLB 引用了非法的 accessor（${context}）`);
  }
  const accessor = accessors[index];
  if (!accessor) {
    throw invalidModel(`GLB 引用了不存在的 accessor（${context}）`);
  }
  if (typeof accessor.count !== 'number' || !Number.isInteger(accessor.count) || accessor.count < 0) {
    throw invalidModel(`GLB 的 accessor 缺少有效顶点数（${context}）`);
  }
  return accessor.count;
}

/** Triangle count for one primitive, following glTF primitive modes. */
function primitiveTriangles(
  primitive: GltfPrimitive,
  accessors: readonly GltfAccessor[],
  meshIndex: number,
  primitiveIndex: number,
): { triangles: number; vertices: number } {
  const context = `mesh ${meshIndex} primitive ${primitiveIndex}`;
  const attributes = isRecord(primitive.attributes) ? primitive.attributes : {};

  let vertices = 0;
  const position = attributes.POSITION;
  if (position !== undefined) {
    vertices = accessorCount(accessors, position, `${context} 顶点`);
  }

  const mode = typeof primitive.mode === 'number' ? primitive.mode : 4;
  // 4 = TRIANGLES, 5 = TRIANGLE_STRIP, 6 = TRIANGLE_FAN; other modes carry no faces.
  if (mode !== 4 && mode !== 5 && mode !== 6) {
    return { triangles: 0, vertices };
  }

  const count =
    primitive.indices === undefined
      ? accessorCount(accessors, position, `${context} 顶点`)
      : accessorCount(accessors, primitive.indices, `${context} 索引`);

  if (mode === 4) {
    return { triangles: Math.floor(count / 3), vertices };
  }
  return { triangles: Math.max(0, count - 2), vertices };
}

function readChunks(buffer: Buffer, declaredLength: number): {
  json: unknown;
  hasBinaryChunk: boolean;
  binaryBytes: number;
} {
  let offset = GLB_HEADER_BYTES;
  let json: unknown;
  let jsonSeen = false;
  let hasBinaryChunk = false;
  let binaryBytes = 0;

  while (offset + CHUNK_HEADER_BYTES <= declaredLength) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const start = offset + CHUNK_HEADER_BYTES;
    const end = start + chunkLength;

    if (end > declaredLength) {
      throw invalidModel('GLB 的 chunk 数据越界，文件可能已损坏');
    }
    if (chunkLength % 4 !== 0) {
      throw invalidModel('GLB 的 chunk 长度没有按 4 字节对齐，文件可能已损坏');
    }

    if (chunkType === CHUNK_JSON) {
      if (jsonSeen) throw invalidModel('GLB 包含多个 JSON chunk');
      if (offset !== GLB_HEADER_BYTES) {
        throw invalidModel('GLB 的第一个 chunk 必须是 JSON');
      }
      const text = buffer.toString('utf8', start, end).replace(/[\s\0]+$/u, '');
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        throw invalidModel('GLB 的 JSON chunk 不是合法的 JSON');
      }
      jsonSeen = true;
    } else if (chunkType === CHUNK_BIN) {
      if (!jsonSeen) throw invalidModel('GLB 的 BIN chunk 必须出现在 JSON chunk 之后');
      if (hasBinaryChunk) throw invalidModel('GLB 包含多个 BIN chunk');
      hasBinaryChunk = true;
      binaryBytes = chunkLength;
    }
    // Unknown chunk types are skipped, as allowed by the glTF 2.0 spec.

    offset = start + chunkLength;
  }

  if (offset !== declaredLength) {
    throw invalidModel('GLB 的 chunk 结构不完整，文件可能已损坏');
  }
  if (!jsonSeen) {
    throw invalidModel('GLB 缺少 JSON chunk');
  }

  return { json, hasBinaryChunk, binaryBytes };
}

/**
 * Parse a GLB buffer and return structural metrics.
 *
 * Throws `AppError('INVALID_MODEL', 422)` for anything the viewer could not
 * load, and a dedicated actionable error for meshopt-compressed files (the
 * self-hosted decoder only covers Draco).
 */
export function inspectGlb(buffer: Buffer): GlbInfo {
  if (buffer.length === 0) {
    throw invalidModel('模型文件是空的');
  }
  if (buffer.length < GLB_HEADER_BYTES) {
    throw invalidModel(`模型文件只有 ${buffer.length} 字节，不是有效的 GLB`);
  }
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw invalidModel('文件不是 GLB 模型（缺少 glTF 魔数）');
  }

  const version = buffer.readUInt32LE(4);
  if (version !== 2) {
    throw invalidModel(`只支持 glTF 2.0 的 GLB 模型（当前文件版本 ${version}）`);
  }

  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength < GLB_HEADER_BYTES || declaredLength > buffer.length) {
    throw invalidModel(
      `GLB 文件不完整（头部声明 ${declaredLength} 字节，实际 ${buffer.length} 字节）`,
    );
  }

  const { json, hasBinaryChunk, binaryBytes } = readChunks(buffer, declaredLength);
  if (!isRecord(json)) {
    throw invalidModel('GLB 的 JSON chunk 不是对象');
  }
  const document = json as GltfDocument;

  const asset = isRecord(document.asset) ? document.asset : undefined;
  if (!asset || typeof asset.version !== 'string') {
    throw invalidModel('GLB 缺少 asset.version，不是标准的 glTF 2.0 模型');
  }
  if (!asset.version.startsWith('2.')) {
    throw invalidModel(`只支持 glTF 2.0 的 GLB 模型（当前 JSON 版本 ${asset.version}）`);
  }

  const extensionsUsed = stringArray(document.extensionsUsed);
  const extensionsRequired = stringArray(document.extensionsRequired);

  if (
    extensionsRequired.includes(MESHOPT_EXTENSION) ||
    extensionsUsed.includes(MESHOPT_EXTENSION)
  ) {
    throw invalidModel(
      '这个 GLB 用了 EXT_meshopt_compression 压缩，浏览器端暂时无法解码。请重新导出未压缩的 GLB，或改用 Draco 压缩（KHR_draco_mesh_compression）后再上传。',
    );
  }

  const compression = extensionsRequired.includes(DRACO_EXTENSION) ||
    extensionsUsed.includes(DRACO_EXTENSION)
    ? 'draco'
    : null;

  const meshes = Array.isArray(document.meshes) ? document.meshes : [];
  const accessors = Array.isArray(document.accessors)
    ? (document.accessors as GltfAccessor[])
    : [];

  let triangles = 0;
  let vertices = 0;
  let primitives = 0;

  meshes.forEach((rawMesh, meshIndex) => {
    if (!isRecord(rawMesh)) {
      throw invalidModel(`GLB 的 mesh ${meshIndex} 结构不合法`);
    }
    const mesh = rawMesh as GltfMesh;
    const list = Array.isArray(mesh.primitives) ? mesh.primitives : [];
    list.forEach((rawPrimitive, primitiveIndex) => {
      if (!isRecord(rawPrimitive)) {
        throw invalidModel(
          `GLB 的 mesh ${meshIndex} primitive ${primitiveIndex} 结构不合法`,
        );
      }
      const stats = primitiveTriangles(
        rawPrimitive as GltfPrimitive,
        accessors,
        meshIndex,
        primitiveIndex,
      );
      triangles += stats.triangles;
      vertices += stats.vertices;
      primitives += 1;
    });
  });

  const generator =
    typeof asset.generator === 'string' && asset.generator.length > 0
      ? asset.generator.slice(0, 80)
      : null;

  return {
    bytes: buffer.length,
    version,
    generator,
    triangles,
    vertices,
    meshes: meshes.length,
    primitives,
    materials: arrayLength(document.materials),
    textures: arrayLength(document.textures),
    images: arrayLength(document.images),
    animations: arrayLength(document.animations),
    extensionsUsed,
    extensionsRequired,
    compression,
    hasBinaryChunk,
    binaryBytes,
  };
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Reject assets that would blow the client/network budget (§7.4): >8MB on disk
 * or >300k triangles. Both limits are inclusive.
 */
export function assertGlbLimits(info: GlbInfo, limits: GlbLimits = DEFAULT_GLB_LIMITS): void {
  if (info.bytes > limits.maxBytes) {
    throw new AppError(
      'MODEL_TOO_LARGE',
      422,
      `模型文件 ${formatMegabytes(info.bytes)}（${info.bytes} 字节）超过 ${formatMegabytes(limits.maxBytes)} 上限。请在 Blender 中减面或重新导出低精度模型后再上传。`,
    );
  }
  if (info.triangles > limits.maxTriangles) {
    throw new AppError(
      'MODEL_TOO_COMPLEX',
      422,
      `模型有 ${info.triangles} 个三角面，超过 ${limits.maxTriangles} 上限。请在 Blender 中减面（Decimate）后再上传。`,
    );
  }
}

/** Structural validation + budget limits; returns metrics for logging/assets. */
export function validateDollModel(
  buffer: Buffer,
  limits: GlbLimits = DEFAULT_GLB_LIMITS,
): GlbInfo {
  const info = inspectGlb(buffer);
  assertGlbLimits(info, limits);
  return info;
}

/** Short, log-safe summary (no paths, no user content). */
export function describeGlb(info: GlbInfo): string {
  return `${info.triangles} tris, ${info.textures} textures, ${formatMegabytes(info.bytes)}${
    info.compression ? `, ${info.compression}` : ''
  }`;
}
