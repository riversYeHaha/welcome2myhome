import { createHash } from 'node:crypto';
import type { AppConfig } from '../config';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface UploadToken {
  ousToken: string;
  globalDomain: string;
  blockSize: number;
}

interface Lux3DTask {
  taskId: number;
  status: number;
  outputs: string[];
}

interface Lux3DClientOptions {
  endpoint: string;
  apiKey: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function apiError(message: string): Error {
  return new Error(message);
}

function assertOk(body: { c?: unknown; m?: unknown }, context: string): void {
  if (String(body.c) !== '0') {
    const message = typeof body.m === 'string' && body.m ? body.m : context;
    throw apiError(message);
  }
}

function findGlbUrl(outputs: string[]): string | null {
  for (const output of outputs) {
    if (typeof output !== 'string') continue;
    if (/\.glb(\?|$)/i.test(output)) return output;
  }
  return null;
}

/**
 * Thin HTTP client for the AHOLO Lux3D API.
 *
 * Flow: asset token → OUS single upload → img-to-3D task → poll task → GLB URL.
 * The API key is only sent as the `Authorization` header and never logged.
 */
export class Lux3DClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: Lux3DClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.apiKey, ...extra };
  }

  private async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw apiError(`Lux3D 返回了非 JSON 响应（HTTP ${response.status}）`);
    }
    if (!response.ok) {
      const message =
        typeof (body as { m?: unknown }).m === 'string'
          ? (body as { m: string }).m
          : `Lux3D 请求失败（HTTP ${response.status}）`;
      throw apiError(message);
    }
    return body as T;
  }

  private async uploadToken(): Promise<UploadToken> {
    const body = await this.json<{
      ousToken?: string;
      globalDomain?: string;
      blockSize?: number;
      d?: { ousToken?: string; globalDomain?: string; blockSize?: number };
    }>(`${this.endpoint}/asset/v1/token`, {
      headers: this.authHeaders(),
    });

    const token = body.ousToken ?? body.d?.ousToken;
    const domain = body.globalDomain ?? body.d?.globalDomain;
    const blockSize = body.blockSize ?? body.d?.blockSize;

    if (!token || !domain) throw apiError('无法获取 AHOLO 上传凭证');
    return { ousToken: token, globalDomain: domain.replace(/\/+$/, ''), blockSize: blockSize ?? 0 };
  }

  /** Upload a normalized photo and return its public URL usable by Lux3D. */
  async uploadImage(buffer: Buffer, filename = 'photo.jpg'): Promise<string> {
    const token = await this.uploadToken();
    if (token.blockSize > 0 && buffer.length > token.blockSize) {
      throw apiError('照片超过单次上传大小，请先压缩照片');
    }

    const form = new FormData();
    form.append('md5', createHash('md5').update(buffer).digest('hex'));
    form.append('file', new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' }), filename);

    const upload = await this.json<{ c?: unknown; m?: unknown; d?: { taskId?: string } }>(
      `${token.globalDomain}/ous/api/v2/single/upload`,
      {
        method: 'POST',
        headers: { 'ous-token-v2': token.ousToken },
        body: form,
      },
    );
    assertOk(upload, '照片上传失败');
    if (!upload.d?.taskId) throw apiError('照片上传未返回任务 ID');

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await sleep(500);
      const status = await this.json<{
        c?: unknown;
        m?: unknown;
        d?: { status?: number; url?: string; errorMsg?: string };
      }>(`${token.globalDomain}/ous/api/v2/upload/status`, {
        headers: { 'ous-token-v2': token.ousToken },
      });
      assertOk(status, '照片上传状态查询失败');
      if (status.d?.status === 5 && status.d.url) return status.d.url;
      if (status.d?.status === 6 || status.d?.status === 8) {
        throw apiError(status.d.errorMsg || '照片上传被中止');
      }
    }
    throw apiError('照片上传超时');
  }

  async createImgTo3D(imageUrl: string, options: {
    version: 'G1' | 'G1-Turbo';
    faceCount: number;
    enablePbr: boolean;
  }): Promise<string> {
    const body = await this.json<{ c?: unknown; m?: unknown; d?: number }>(
      `${this.endpoint}/lux3d/v1/generate/img-to-3d/task/create`,
      {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          img: imageUrl,
          version: options.version,
          faceCount: options.faceCount,
          enablePbr: options.enablePbr,
          outputFormat: ['glb'],
        }),
      },
    );
    assertOk(body, '创建图生 3D 任务失败');
    if (typeof body.d !== 'number') throw apiError('创建图生 3D 任务未返回 taskId');
    return String(body.d);
  }

  async getTask(taskId: string): Promise<Lux3DTask> {
    const body = await this.json<{
      c?: unknown;
      m?: unknown;
      d?: { taskId?: number; status?: number; outputs?: Array<{ content?: string }> };
    }>(`${this.endpoint}/lux3d/v1/generate/task/get?taskid=${encodeURIComponent(taskId)}`, {
      headers: this.authHeaders(),
    });
    assertOk(body, '查询图生 3D 任务失败');
    if (!body.d || typeof body.d.status !== 'number') {
      throw apiError('图生 3D 任务状态缺失');
    }
    return {
      taskId: body.d.taskId ?? Number(taskId),
      status: body.d.status,
      outputs: (body.d.outputs ?? [])
        .map((output) => output.content)
        .filter((content): content is string => typeof content === 'string'),
    };
  }

  /** Poll until status 3 (success), then return output URLs. */
  async waitForTask(
    taskId: string,
    onProgress?: (status: number, elapsedMs: number) => void,
  ): Promise<string[]> {
    const started = Date.now();
    while (Date.now() - started < this.timeoutMs) {
      const task = await this.getTask(taskId);
      if (task.status === 3) return task.outputs;
      if (task.status === 4 || task.status === 6) {
        throw apiError(task.status === 4 ? '图生 3D 生成失败' : '图生 3D 任务被取消');
      }
      onProgress?.(task.status, Date.now() - started);
      await sleep(this.pollIntervalMs);
    }
    throw apiError('图生 3D 生成超时');
  }

  async download(url: string): Promise<Buffer> {
    const response = await this.fetchImpl(url);
    if (!response.ok) throw apiError(`下载模型失败（HTTP ${response.status}）`);
    return Buffer.from(await response.arrayBuffer());
  }

  glbFromOutputs(outputs: string[]): string {
    const url = findGlbUrl(outputs);
    if (!url) throw apiError('生成结果中没有 GLB 文件');
    return url;
  }
}

/** Null when no API key is configured; callers then fall back to manual upload. */
export function createLux3DClient(config: AppConfig): Lux3DClient | null {
  const apiKey = config.generation.apiKey;
  if (!apiKey) return null;
  return new Lux3DClient({
    endpoint: config.generation.endpoint,
    apiKey,
    pollIntervalMs: config.generation.pollIntervalMs,
    timeoutMs: config.generation.timeoutSec * 1000,
  });
}
