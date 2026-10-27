// @q2/sw-renderer surfaceCache — r_surf.c surface cache equivalent.
// LRU keyed by (surface, lightstyle hash, miplevel) with a 4 MB budget.
// Entries store the surface's sampled block (mipped texels + light grades)
// so spans reuse built blocks across frames. Dynamic lights invalidate via
// invalidateSurfaces() driven by DLightState.markLights().

import type { RGBMaterial } from './spans.js';

export const SURFACE_CACHE_BUDGET = 4 * 1024 * 1024;

export interface SurfaceBlock {
  /** mipped texel block, pow2 dims */
  texels: Uint8Array;
  bw: number;
  bh: number;
  /** per-luxel light grades 0..63, luxW*luxH */
  light: Uint8Array;
  luxW: number;
  luxH: number;
  /**
   * Optional parallel RGB light block (astra V2a): luxW*luxH*3 bytes
   * 0..255 in luxel space, built by buildRGBLightMap. Present only on
   * RGB-cache entries; the scalar `light` grades are always kept
   * alongside so the software path never changes. Never read by the
   * software span loop.
   */
  rgb?: Uint8Array;
}

interface Entry {
  key: number;
  bytes: number;
  block: SurfaceBlock;
  /** Last frame id that touched this entry (frame-granularity LRU). */
  used: number;
}

export function surfaceCacheKey(surface: number, stylesHash: number, mip: number): number {
  return (surface * 16384 + (stylesHash & 4095) * 4 + (mip & 3)) >>> 0;
}

/** FNV-1a over style scales: the lightstyle component of the cache key. */
export function hashLightStyles(scales: Float32Array | number[], n?: number): number {
  const len = n ?? scales.length;
  let h = 2166136261;
  for (let i = 0; i < len; i++) {
    const q = Math.round(scales[i]! * 256) & 0xffff;
    h ^= q & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (q >> 8) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class SurfaceCache {
  readonly budget: number;
  used = 0;
  hits = 0;
  misses = 0;
  evictions = 0;
  /**
   * Monotonic frame stamp, advanced by nextFrame() once per rendered frame.
   * Eviction prefers the stalest frame (ties keep insertion order, since
   * Map iterates oldest-first). Any eviction choice rebuilds byte-identical
   * blocks on the next miss, so the policy never affects a single pixel —
   * only how often the builder runs.
   */
  private frame = 0;
  private map = new Map<number, Entry>();

  constructor(budget: number = SURFACE_CACHE_BUDGET) {
    this.budget = budget;
  }

  get size(): number {
    return this.map.size;
  }

  hitRate(): number {
    const t = this.hits + this.misses;
    return t === 0 ? 1 : this.hits / t;
  }

  get(surface: number, stylesHash: number, mip: number): SurfaceBlock | null {
    const key = surfaceCacheKey(surface, stylesHash, mip);
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return null;
    }
    // M8.1: no LRU refresh on hit (the old delete+re-insert churned the Map
    // on every one of ~10^3 hits/frame). The stamp records recency for the
    // frame-granularity eviction in put(); steady-state behaviour is the
    // same hot cache, without the per-hit Map traffic.
    e.used = this.frame;
    this.hits++;
    return e.block;
  }

  /** Advance the recency stamp (call once per rendered frame). */
  nextFrame(): void {
    // Wraparound is harmless: all stamps compare stale equally, and the
    // next frames re-stamp live entries in Map (insertion) order.
    this.frame = (this.frame + 1) >>> 0;
  }

  put(surface: number, stylesHash: number, mip: number, block: SurfaceBlock): void {
    const key = surfaceCacheKey(surface, stylesHash, mip);
    const bytes = block.texels.length + block.light.length + 64;
    const old = this.map.get(key);
    if (old) {
      this.used -= old.bytes;
      this.map.delete(key);
    }
    // Evict stalest-frame entries until the block fits (r_surf.c cache
    // thrash guard: a single block larger than budget is still stored,
    // alone). Scan is O(size) but runs only when over budget — steady
    // state never pays it (the old path paid delete+set on every hit).
    // Ties keep insertion order (Map iterates oldest-first), so this is
    // frame-granularity LRU.
    while (this.used + bytes > this.budget && this.map.size > 0) {
      let victim: number | undefined;
      let victimAge = -1;
      for (const [k, e] of this.map) {
        const age = (this.frame - e.used) >>> 0;
        if (age > victimAge) {
          victimAge = age;
          victim = k;
          if (age > 0) break;
        }
      }
      if (victim === undefined) break;
      const e = this.map.get(victim)!;
      this.map.delete(victim);
      this.used -= e.bytes;
      this.evictions++;
    }
    this.map.set(key, { key, bytes, block, used: this.frame });
    this.used += bytes;
  }

  /** Dynamic-light invalidation path: drop every mip/style of surf ids. */
  invalidateSurfaces(ids: number[] | Set<number>): void {
    if (ids instanceof Set) {
      for (const k of [...this.map.keys()]) {
        const surface = Math.floor(k / 16384);
        if (ids.has(surface)) {
          const e = this.map.get(k)!;
          this.map.delete(k);
          this.used -= e.bytes;
        }
      }
      return;
    }
    const set = new Set(ids);
    for (const k of [...this.map.keys()]) {
      const surface = Math.floor(k / 16384);
      if (set.has(surface)) {
        const e = this.map.get(k)!;
        this.map.delete(k);
        this.used -= e.bytes;
      }
    }
  }

  invalidateAll(): void {
    this.map.clear();
    this.used = 0;
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}

/**
 * Cached RGB binding: the scalar-shaped block (`rgb` luxels set, texels +
 * grades shared by reference with the scalar entry built the same batch)
 * plus the built material (mip chain + light view sharing block.rgb).
 */
export interface RGBCachedBlock {
  block: SurfaceBlock;
  material: RGBMaterial;
}

/**
 * Key for the parallel RGB block cache. Carries the dlight serial in
 * addition to (surface, stylesHash, mip): RGB lighting depends on the
 * dynamic-light generation, and the scalar key alone could serve a block
 * whose colored lights predate the latest add/remove. A serial change
 * therefore misses (never serves stale color); the frame loop also drops
 * the whole RGB cache whenever it drops the scalar one. String keys keep
 * the 32-bit serial exact (a packed-number key would lose precision).
 */
export function rgbCacheKey(
  surface: number,
  stylesHash: number,
  mip: number,
  dlightSerial: number,
): string {
  return `${surface}:${stylesHash >>> 0}:${mip & 3}:${dlightSerial >>> 0}`;
}

/**
 * Parallel RGB block cache (astra V2a), beside SurfaceCache. Same
 * frame-stamp LRU policy and budget discipline, separate map and counters
 * so the software path stays bit-identical whether or not the RGB path is
 * armed. Entries are RGBCachedBlocks (block + built material); byte
 * accounting covers the owned RGB luxels + mip chain only (texels/grades
 * are shared with the scalar cache entry). Callers mirror every scalar
 * invalidation (invalidateSurfaces / invalidateAll / nextFrame) on this
 * cache; palette changes must invalidateAll since the mip-chain expansion
 * bakes palette colors in.
 */
export class RGBLightCache {
  readonly budget: number;
  used = 0;
  hits = 0;
  misses = 0;
  evictions = 0;
  private frame = 0;
  private map = new Map<string, { surface: number; entry: RGBCachedBlock; bytes: number; used: number }>();

  constructor(budget: number = SURFACE_CACHE_BUDGET) {
    this.budget = budget;
  }

  get size(): number {
    return this.map.size;
  }

  hitRate(): number {
    const t = this.hits + this.misses;
    return t === 0 ? 1 : this.hits / t;
  }

  nextFrame(): void {
    this.frame = (this.frame + 1) >>> 0;
  }

  get(surface: number, stylesHash: number, mip: number, dlightSerial: number): RGBCachedBlock | null {
    const e = this.map.get(rgbCacheKey(surface, stylesHash, mip, dlightSerial));
    if (!e) {
      this.misses++;
      return null;
    }
    e.used = this.frame;
    this.hits++;
    return e.entry;
  }

  put(surface: number, stylesHash: number, mip: number, dlightSerial: number, entry: RGBCachedBlock): void {
    const key = rgbCacheKey(surface, stylesHash, mip, dlightSerial);
    let chainBytes = 0;
    for (const lvl of entry.material.levels) chainBytes += lvl.data.length;
    const bytes = chainBytes + (entry.block.rgb ? entry.block.rgb.length : 0) + 64;
    const old = this.map.get(key);
    if (old) {
      this.used -= old.bytes;
      this.map.delete(key);
    }
    while (this.used + bytes > this.budget && this.map.size > 0) {
      let victim: string | undefined;
      let victimAge = -1;
      for (const [k, e] of this.map) {
        const age = (this.frame - e.used) >>> 0;
        if (age > victimAge) {
          victimAge = age;
          victim = k;
          if (age > 0) break;
        }
      }
      if (victim === undefined) break;
      const e = this.map.get(victim)!;
      this.map.delete(victim);
      this.used -= e.bytes;
      this.evictions++;
    }
    this.map.set(key, { surface, entry, bytes, used: this.frame });
    this.used += bytes;
  }

  /** Dynamic-light invalidation path: drop every mip/style of surf ids. */
  invalidateSurfaces(ids: number[] | Set<number>): void {
    const set = ids instanceof Set ? ids : new Set(ids);
    for (const [k, e] of [...this.map.keys()].map((k) => [k, this.map.get(k)!] as const)) {
      if (set.has(e.surface)) {
        this.map.delete(k);
        this.used -= e.bytes;
      }
    }
  }

  invalidateAll(): void {
    this.map.clear();
    this.used = 0;
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }
}
