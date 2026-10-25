// @q2/sw-renderer surfaceCache — r_surf.c surface cache equivalent.
// LRU keyed by (surface, lightstyle hash, miplevel) with a 4 MB budget.
// Entries store the surface's sampled block (mipped texels + light grades)
// so spans reuse built blocks across frames. Dynamic lights invalidate via
// invalidateSurfaces() driven by DLightState.markLights().

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
}

interface Entry {
  key: number;
  bytes: number;
  block: SurfaceBlock;
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
    // LRU refresh: re-insert (Map preserves insertion order).
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.block;
  }

  put(surface: number, stylesHash: number, mip: number, block: SurfaceBlock): void {
    const key = surfaceCacheKey(surface, stylesHash, mip);
    const bytes = block.texels.length + block.light.length + 64;
    const old = this.map.get(key);
    if (old) {
      this.used -= old.bytes;
      this.map.delete(key);
    }
    // Evict oldest until the block fits (r_surf.c cache thrash guard:
    // a single block larger than budget is still stored, alone).
    const oldest = this.map.keys();
    while (this.used + bytes > this.budget && this.map.size > 0) {
      const k = oldest.next().value as number | undefined;
      if (k === undefined) break;
      const e = this.map.get(k)!;
      this.map.delete(k);
      this.used -= e.bytes;
      this.evictions++;
    }
    this.map.set(key, { key, bytes, block });
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
