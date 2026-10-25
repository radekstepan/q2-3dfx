// q2ts-web pak cache (M7.3): persist the dropped pak0.pak in IndexedDB so
// one drop survives reloads. The bytes never leave the user's browser.
//
// Headless-safe: every IndexedDB touch goes through `hasIndexedDB()` and
// resolves to a devroom fallback when IDB is absent (Node/vitest) or the
// stored record is empty/corrupt. This module has no top-level side
// effects — importing it in Node is free.
import { ingestPak } from './pak.js';
import type { WebPak } from './pak.js';

export const PAK_CACHE_DB = 'q2ts';
export const PAK_CACHE_STORE = 'pak';
export const PAK_CACHE_KEY = 'pak0';
/** Sanity ceiling: a real pak0.pak is ~20–200 MB; anything larger is junk. */
export const PAK_CACHE_MAX_BYTES = 512 * 1024 * 1024;

export interface PakCacheMeta {
  name: string;
  byteSize: number;
}

interface PakCacheRecord extends PakCacheMeta {
  bytes: ArrayBuffer;
  savedAt: number;
}

/** True when IndexedDB is usable in this environment (browser only). */
export function hasIndexedDB(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * Pure validation for a stored record's metadata: a non-empty `.pak`
 * filename and a plausible byte size. Never touches IndexedDB.
 */
export function isValidPakCacheMeta(meta: {
  name?: unknown;
  byteSize?: unknown;
}): meta is PakCacheMeta {
  return (
    typeof meta.name === 'string' &&
    meta.name.length > 0 &&
    meta.name.toLowerCase().endsWith('.pak') &&
    typeof meta.byteSize === 'number' &&
    Number.isInteger(meta.byteSize) &&
    meta.byteSize > 12 &&
    meta.byteSize <= PAK_CACHE_MAX_BYTES
  );
}

/**
 * Pure ingest for cached bytes: the stored size must match the buffer
 * exactly and the PAK directory must parse, otherwise null (corrupt or
 * truncated cache → silent devroom fallback, no error spam).
 */
export function tryIngestCachedPak(name: string, buf: ArrayBuffer, byteSize: number): WebPak | null {
  if (!isValidPakCacheMeta({ name, byteSize })) return null;
  if (buf.byteLength !== byteSize) return null;
  try {
    return ingestPak(buf);
  } catch {
    return null;
  }
}

/** Validate a raw stored record (unknown shape from IDB) into a WebPak. */
export function validateCachedRecord(record: unknown): { pak: WebPak; name: string } | null {
  if (!record || typeof record !== 'object') return null;
  const rec = record as Partial<PakCacheRecord>;
  if (!(rec.bytes instanceof ArrayBuffer)) return null;
  if (!isValidPakCacheMeta({ name: rec.name, byteSize: rec.byteSize })) return null;
  const pak = tryIngestCachedPak(rec.name as string, rec.bytes, rec.byteSize as number);
  if (!pak) return null;
  return { pak, name: rec.name as string };
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PAK_CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PAK_CACHE_STORE)) db.createObjectStore(PAK_CACHE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
  });
}

/**
 * Persist a dropped pak. Resolves silently (no-op) without IndexedDB;
 * rejects only on real browser IDB failures (callers swallow it — a
 * failed persist must never break the just-dropped boot).
 */
export async function storeCachedPak(name: string, buf: ArrayBuffer): Promise<void> {
  if (!hasIndexedDB()) return;
  if (!isValidPakCacheMeta({ name, byteSize: buf.byteLength })) return;
  const db = await openCacheDb();
  try {
    const tx = db.transaction(PAK_CACHE_STORE, 'readwrite');
    const record: PakCacheRecord = { name, bytes: buf, byteSize: buf.byteLength, savedAt: Date.now() };
    await idbRequest(tx.objectStore(PAK_CACHE_STORE).put(record, PAK_CACHE_KEY));
  } finally {
    db.close();
  }
}

/**
 * Load the cached pak, or null when absent/corrupt (→ devroom boot).
 * Never throws for missing/corrupt data; only real IDB errors propagate
 * and the boot caller swallows those too.
 */
export async function loadCachedPak(): Promise<{ pak: WebPak; name: string } | null> {
  if (!hasIndexedDB()) return null;
  const db = await openCacheDb();
  try {
    const tx = db.transaction(PAK_CACHE_STORE, 'readonly');
    const record = await idbRequest(tx.objectStore(PAK_CACHE_STORE).get(PAK_CACHE_KEY));
    return validateCachedRecord(record);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Drop the cached pak. No-op without IndexedDB; never throws. */
export async function clearCachedPak(): Promise<void> {
  if (!hasIndexedDB()) return;
  try {
    const db = await openCacheDb();
    try {
      const tx = db.transaction(PAK_CACHE_STORE, 'readwrite');
      await idbRequest(tx.objectStore(PAK_CACHE_STORE).delete(PAK_CACHE_KEY));
    } finally {
      db.close();
    }
  } catch {
    /* clearing is best-effort */
  }
}
