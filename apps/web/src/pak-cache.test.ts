// M7.3: pure pak-cache helpers + IDB-absent fallback (headless-safe).
import { describe, expect, it } from 'vitest';
import {
  clearCachedPak,
  hasIndexedDB,
  isValidPakCacheMeta,
  loadCachedPak,
  PAK_CACHE_MAX_BYTES,
  storeCachedPak,
  tryIngestCachedPak,
  validateCachedRecord,
} from './pak-cache.js';
import { makePakForTest } from './test-helpers.js';

describe('pak cache helpers (pure)', () => {
  it('validates stored metadata (name + size)', () => {
    expect(isValidPakCacheMeta({ name: 'pak0.pak', byteSize: 1024 })).toBe(true);
    expect(isValidPakCacheMeta({ name: 'PAK0.PAK', byteSize: 13 })).toBe(true);
    expect(isValidPakCacheMeta({ name: '', byteSize: 1024 })).toBe(false);
    expect(isValidPakCacheMeta({ name: 'pak0.pk2', byteSize: 1024 })).toBe(false);
    expect(isValidPakCacheMeta({ name: 'pak0.pak', byteSize: 0 })).toBe(false);
    expect(isValidPakCacheMeta({ name: 'pak0.pak', byteSize: 12 })).toBe(false);
    expect(isValidPakCacheMeta({ name: 'pak0.pak', byteSize: 1.5 })).toBe(false);
    expect(isValidPakCacheMeta({ name: 'pak0.pak', byteSize: PAK_CACHE_MAX_BYTES + 1 })).toBe(false);
    expect(isValidPakCacheMeta({})).toBe(false);
    expect(isValidPakCacheMeta({ name: 42, byteSize: 'big' })).toBe(false);
  });

  it('ingests cached bytes when size matches, rejects mismatch/corruption', () => {
    const buf = makePakForTest();
    const pak = tryIngestCachedPak('pak0.pak', buf, buf.byteLength);
    expect(pak?.entries.length).toBe(1);
    // Truncated view: stored size disagrees → null, no throw.
    expect(tryIngestCachedPak('pak0.pak', buf, buf.byteLength + 1)).toBeNull();
    expect(tryIngestCachedPak('pak0.pak', buf, 13)).toBeNull();
    // Bad filename → null.
    expect(tryIngestCachedPak('readme.txt', buf, buf.byteLength)).toBeNull();
    // Corrupt magic → null, no throw.
    const bad = new ArrayBuffer(64);
    new Uint8Array(bad).fill(0x41);
    expect(tryIngestCachedPak('pak0.pak', bad, bad.byteLength)).toBeNull();
  });

  it('validates raw stored records without throwing', () => {
    expect(validateCachedRecord(null)).toBeNull();
    expect(validateCachedRecord(undefined)).toBeNull();
    expect(validateCachedRecord({})).toBeNull();
    expect(validateCachedRecord({ name: 'pak0.pak', byteSize: 8, bytes: 'nope' })).toBeNull();
    const buf = makePakForTest();
    const good = validateCachedRecord({ name: 'pak0.pak', byteSize: buf.byteLength, bytes: buf, savedAt: 1 });
    expect(good?.name).toBe('pak0.pak');
    expect(good?.pak.entries.length).toBe(1);
    // Size mismatch → corrupt.
    expect(validateCachedRecord({ name: 'pak0.pak', byteSize: 999, bytes: buf, savedAt: 1 })).toBeNull();
  });
});

describe('pak cache without IndexedDB (headless fallback)', () => {
  it('reports IDB absent and resolves to devroom-safe values', async () => {
    expect(typeof document).toBe('undefined');
    expect(hasIndexedDB()).toBe(false);
    await expect(storeCachedPak('pak0.pak', makePakForTest())).resolves.toBeUndefined();
    await expect(loadCachedPak()).resolves.toBeNull();
    await expect(clearCachedPak()).resolves.toBeUndefined();
  });
});
