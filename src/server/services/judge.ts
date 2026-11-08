import { hashSecret, verifySecret, type ScryptParams } from '../lib/crypto';

/**
 * Canonical answer form (tech design §5.4.1):
 * NFKC → lowercase → keep only letters/numbers (drops spaces & punctuation).
 * Host-written answers must go through this before hashing.
 */
export function normalizeAnswer(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 100);
}

export function hashAnswer(answer: string, params: ScryptParams): string {
  return hashSecret(normalizeAnswer(answer), params);
}

function parseSynonyms(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeAnswer)
      .filter((item) => item.length > 0);
  } catch {
    return [];
  }
}

/**
 * Compare a submitted answer against the salted hash first, then the normalized
 * synonym list. Never throws on malformed stored data; returns false instead.
 */
export function verifyAnswer(
  submitted: string,
  storedHash: string,
  synonymsJson: string,
): boolean {
  const normalized = normalizeAnswer(submitted);
  if (!normalized) return false;

  try {
    if (storedHash && verifySecret(normalized, storedHash)) return true;
  } catch {
    return false;
  }

  const synonyms = parseSynonyms(synonymsJson);
  return synonyms.includes(normalized);
}
