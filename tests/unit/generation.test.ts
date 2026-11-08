import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/server/lib/errors';
import { normalizePhoto } from '../../src/server/services/generation';

describe('photo normalization', () => {
  it('resizes to 1536 and re-encodes without metadata', async () => {
    const input = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: '#aabbcc' },
    })
      .jpeg()
      .toBuffer();

    const result = await normalizePhoto(input);
    expect(result.width).toBeLessThanOrEqual(1536);
    expect(result.height).toBeLessThanOrEqual(1536);
    expect(result.bytes).toBeGreaterThan(0);

    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
  });

  it('rejects non-image uploads', async () => {
    await expect(normalizePhoto(Buffer.from('not an image'))).rejects.toBeInstanceOf(AppError);
    await expect(normalizePhoto(Buffer.from('not an image'))).rejects.toMatchObject({
      code: 'INVALID_PHOTO',
    });
  });
});
