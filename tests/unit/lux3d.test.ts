import { describe, expect, it } from 'vitest';
import { Lux3DClient } from '../../src/server/services/lux3d';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Lux3D client', () => {
  it('uploads an image, creates a task and polls until the GLB is ready', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let uploadPolls = 0;
    let taskPolls = 0;

    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });

      if (url.includes('/asset/v1/token')) {
        return json({ ousToken: 'ous-token', globalDomain: 'https://ous.test', blockSize: 1_000_000 });
      }
      if (url.includes('/ous/api/v2/single/upload')) {
        return json({ c: '0', d: { taskId: 'upload-1' } });
      }
      if (url.includes('/ous/api/v2/upload/status')) {
        uploadPolls += 1;
        return uploadPolls < 2
          ? json({ c: '0', d: { status: 4 } })
          : json({ c: '0', d: { status: 5, url: 'https://img.test/photo.jpg' } });
      }
      if (url.includes('/lux3d/v1/generate/img-to-3d/task/create')) {
        return json({ c: '0', d: 42 });
      }
      if (url.includes('/lux3d/v1/generate/task/get')) {
        taskPolls += 1;
        return taskPolls < 2
          ? json({ c: '0', d: { status: 1 } })
          : json({
              c: '0',
              d: { status: 3, outputs: [{ content: 'https://cdn/model.zip' }, { content: 'https://cdn/model.glb' }] },
            });
      }
      if (url === 'https://cdn/model.glb') {
        return new Response(new Uint8Array([0x67, 0x6c, 0x54, 0x46]), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    };

    const client = new Lux3DClient({
      endpoint: 'https://api.test',
      apiKey: 'secret-key',
      pollIntervalMs: 1,
      timeoutMs: 5000,
      fetchImpl,
    });

    const imageUrl = await client.uploadImage(Buffer.from('photo-bytes'));
    expect(imageUrl).toBe('https://img.test/photo.jpg');

    const taskId = await client.createImgTo3D(imageUrl, {
      version: 'G1',
      faceCount: 300_000,
      enablePbr: true,
    });
    expect(taskId).toBe('42');

    const outputs = await client.waitForTask(taskId);
    expect(outputs).toContain('https://cdn/model.glb');
    expect(client.glbFromOutputs(outputs)).toBe('https://cdn/model.glb');

    const glb = await client.download('https://cdn/model.glb');
    expect(glb.toString('ascii')).toBe('glTF');

    const tokenCall = calls.find((call) => call.url.includes('/asset/v1/token'))!;
    expect(tokenCall.init?.headers).toMatchObject({ Authorization: 'secret-key' });

    const uploadCall = calls.find((call) => call.url.includes('/ous/api/v2/single/upload'))!;
    expect(uploadCall.init?.headers).toMatchObject({ 'ous-token-v2': 'ous-token' });
    expect(uploadCall.init?.body).toBeInstanceOf(FormData);

    const createCall = calls.find((call) => call.url.includes('/img-to-3d/task/create'))!;
    expect(JSON.parse(String(createCall.init?.body))).toMatchObject({
      img: 'https://img.test/photo.jpg',
      version: 'G1',
      faceCount: 300_000,
      outputFormat: ['glb'],
    });
  });

  it('surfaces business errors from the Lux3D response', async () => {
    const client = new Lux3DClient({
      endpoint: 'https://api.test',
      apiKey: 'secret-key',
      fetchImpl: async () => json({ c: 'GENERATION_CONCURRENCY_LIMIT_EXCEEDED', m: '并发已达上限' }),
    });

    await expect(
      client.createImgTo3D('https://img.test/a.jpg', {
        version: 'G1',
        faceCount: 300_000,
        enablePbr: true,
      }),
    ).rejects.toThrow('并发已达上限');
  });
});
