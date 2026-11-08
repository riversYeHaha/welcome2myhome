import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../../src/server/lib/rate-limit';
import { hashAnswer, normalizeAnswer, verifyAnswer } from '../../src/server/services/judge';

const params = { N: 16384, r: 8, p: 1 };

describe('answer normalization', () => {
  it('folds width, case, spaces and punctuation', () => {
    expect(normalizeAnswer('  打 雷！ ')).toBe('打雷');
    expect(normalizeAnswer('ＡＢＣ')).toBe('abc');
    expect(normalizeAnswer('Hello, World!')).toBe('helloworld');
    expect(normalizeAnswer('雷…声')).toBe('雷声');
    expect(normalizeAnswer('🐶 阿黄')).toBe('阿黄');
  });

  it('caps the normalized length at 100 characters', () => {
    expect(normalizeAnswer('a'.repeat(200))).toHaveLength(100);
  });
});

describe('answer verification', () => {
  it('verifies the hashed answer and documented synonyms', () => {
    const hash = hashAnswer('打雷', params);
    const synonyms = JSON.stringify(['雷声', '打雷', ' Thunder ']);

    expect(verifyAnswer(' 打 雷 ', hash, synonyms)).toBe(true);
    expect(verifyAnswer('雷 声', hash, synonyms)).toBe(true);
    expect(verifyAnswer('thunder', hash, synonyms)).toBe(true);
    expect(verifyAnswer('黄瓜', hash, synonyms)).toBe(false);
    expect(verifyAnswer('', hash, synonyms)).toBe(false);
  });

  it('fails closed on malformed stored data', () => {
    expect(verifyAnswer('打雷', 'garbage', 'not-json')).toBe(false);
    expect(verifyAnswer('打雷', '', JSON.stringify(['雷声']))).toBe(false);
  });
});

describe('sliding window limiter', () => {
  it('allows the burst, blocks afterwards and reports retry-after', () => {
    const limiter = new SlidingWindowLimiter(6, 30_000);
    const now = 1_000_000;

    for (let i = 0; i < 6; i += 1) {
      expect(limiter.allow('g:d', now + i)).toBe(true);
    }
    expect(limiter.allow('g:d', now + 6)).toBe(false);
    expect(limiter.retryAfterSec('g:d', now + 6)).toBeGreaterThan(0);
    expect(limiter.allow('other', now)).toBe(true);
  });
});
