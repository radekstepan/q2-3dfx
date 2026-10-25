// @q2/sw-renderer light — r_light.c equivalent.
// R_BuildLightMap: luxel blocklights from static lightmap samples x style
// scales, plus dynamic light contributions. R_MarkLights: per-surface
// dynamic-light marking for cache invalidation.

export interface DynamicLight {
  /** world-space origin */
  origin: Float32Array;
  intensity: number;
  /** rgb multiplier 0..1 */
  color: Float32Array;
}

export interface SurfaceBounds {
  id: number;
  /** world-space bbox */
  mins: Float32Array;
  maxs: Float32Array;
}

/**
 * Style index meaning "no more styles" (id qfiles.h: faces carry up to 4
 * style slots, unused slots are 255). Must never index RefDef.lightStyles.
 */
export const LIGHT_STYLE_UNUSED = 255;

/**
 * Light modulate applied in buildLightMap before the grade clamp.
 * 1 = current software look (devroom golden `8f61c755` is pinned at 1);
 * pass 2 for the gl-style x2 modulate. Cvar-friendly knob for a future
 * `sw_overbright`; the frame path keeps the default so output is unchanged.
 */
export const LIGHT_OVERBRIGHT = 1;

/**
 * Build per-luxel light grades 0..63 (R_BuildLightMap equivalent).
 * samples: RGB luxels (w*h*3, 0..255). styleScales: per-style 0..2 multipliers
 * (from RefDef.lightStyles at the surface's style indices, 255 slots already
 * filtered by the caller). Empty scales fall back to 1 (unlit default).
 * dlights: dynamic lights with world-space surfCenter for falloff.
 * overbright: pre-clamp modulate (default LIGHT_OVERBRIGHT = 1).
 */
export function buildLightMap(
  out: Uint8Array,
  samples: Uint8Array,
  w: number,
  h: number,
  styleScales: Float32Array | number[],
  dlights: DynamicLight[],
  surfCenter: Float32Array,
  dlightBits: number,
  overbright = LIGHT_OVERBRIGHT,
): void {
  // id R_BuildLightMap sums one scaled block per valid style; the samples
  // here carry a single baked block, so the per-style scales add up. The sum
  // is hoisted: one multiply per luxel, no allocation.
  let styleScale = 0;
  for (let k = 0; k < styleScales.length; k++) styleScale += styleScales[k]!;
  if (styleScales.length === 0) styleScale = 1;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = samples[i * 3]! / 255;
    const g = samples[i * 3 + 1]! / 255;
    const b = samples[i * 3 + 2]! / 255;
    // luma of the static sample, scaled by the summed lightstyles
    // (overbright-style modulate happens here, before the grade clamp)
    let l = (0.299 * r + 0.587 * g + 0.114 * b) * styleScale * overbright;
    // dynamic lights: linear falloff from the surface center (R_AddDynamicLights)
    for (let d = 0; d < dlights.length; d++) {
      if (((dlightBits >> d) & 1) === 0) continue;
      const dl = dlights[d]!;
      const dx = dl.origin[0]! - surfCenter[0]!;
      const dy = dl.origin[1]! - surfCenter[1]!;
      const dz = dl.origin[2]! - surfCenter[2]!;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const rad = dl.intensity;
      if (dist < rad) {
        const f = (rad - dist) / rad;
        const dlLuma = 0.299 * dl.color[0]! + 0.587 * dl.color[1]! + 0.114 * dl.color[2]!;
        l += f * dlLuma;
      }
    }
    if (l < 0) l = 0;
    if (l > 1) l = 1;
    out[i] = Math.round(l * 63);
  }
}

/** Extra styles beyond the first scale the whole block (multi-style surf).
 * Style slot 255 is id's "no more styles" terminator and is skipped. */
export function combineStyleScales(styleIndices: number[], lightStyles: Float32Array): number {
  let s = 0;
  for (let i = 0; i < styleIndices.length; i++) {
    const idx = styleIndices[i]!;
    if (idx === LIGHT_STYLE_UNUSED) continue;
    s += lightStyles[idx] ?? 0;
  }
  return s;
}

/**
 * Default muzzle-flash lifetime: how many renderView calls a renderer-owned
 * light stays alive without being re-added. 2 keeps the existing golden
 * dlight test's two lit renders intact while bounding any leak: a flash the
 * caller stops pumping is gone (and its cache entries rebuilt once) within
 * 3 frames, even if clear() is never called.
 */
export const DEFAULT_DLIGHT_TTL_FRAMES = 2;

/**
 * Mark surfaces touched by dynamic lights (R_MarkLights equivalent).
 * Returns the sorted list of affected surface ids and bumps state.serial.
 * Uses bbox-distance culling (dist > intensity skips the whole surface).
 *
 * Renderer-owned lights expire on their own (M6.1 muzzle-leak fix, renderer
 * side) via two cooperating paths: pump-driven hosts call expireAll() (via
 * testExpireDynamicLights) before each frame's conditional re-add, so a
 * one-shot flash ends immediately and idle frames cost nothing; direct-add
 * users (headless tests) that never pump are covered by the ttl path —
 * renderView calls expireStaleLights() before the serial check and ageFrame()
 * after drawing, so an abandoned flash is dropped with exactly one serial
 * bump (one cache rebuild) and the scene returns to baseline. Either way the
 * live list stays bounded by ttl, so the `1 << li` bit budget below cannot
 * overflow from accumulation.
 */
export class DLightState {
  serial = 1;
  lights: DynamicLight[] = [];
  /** parallel to lights: renderViews remaining before expiry. No allocation on sweep (swap-remove). */
  private ttl: number[] = [];
  /** per-surface bitmask of affecting dynamic lights, keyed by surface id */
  dlightBits = new Map<number, number>();
  dlightFrame = new Map<number, number>();
  frame = 0;

  clear(): void {
    this.lights.length = 0;
    this.ttl.length = 0;
    this.serial++;
  }

  addLight(l: DynamicLight, ttlFrames = DEFAULT_DLIGHT_TTL_FRAMES): void {
    this.lights.push(l);
    const ttl = Math.floor(ttlFrames);
    this.ttl.push(ttl < 0 ? 0 : ttl);
    this.serial++;
  }

  /** Live renderer-owned light count (muzzle-leak observability, test hook). */
  get count(): number {
    return this.lights.length;
  }

  /**
   * Drop every renderer-owned light now; bumps serial exactly once when
   * anything was dropped (one cache rebuild), not at all when idle — so a
   * per-frame pump hook is free in steady state. Returns removed count.
   * This is what the web muzzle pump calls before each frame's conditional
   * re-add: the previous one-shot flash ends immediately, a fresh add is the
   * only live light, and nothing accumulates. No allocation.
   */
  expireAll(): number {
    const removed = this.lights.length;
    if (removed === 0) return 0;
    this.lights.length = 0;
    this.ttl.length = 0;
    this.serial++;
    return removed;
  }

  /**
   * Drop lights whose ttl reached zero. Returns the removed count and bumps
   * serial exactly once when anything was removed (one cache rebuild).
   * Call before the serial check in renderView. No allocation.
   */
  expireStaleLights(): number {
    let removed = 0;
    for (let i = this.lights.length - 1; i >= 0; i--) {
      if (this.ttl[i]! <= 0) {
        const last = this.lights.length - 1;
        this.lights[i] = this.lights[last]!;
        this.lights.pop();
        this.ttl[i] = this.ttl[last]!;
        this.ttl.pop();
        removed++;
      }
    }
    if (removed > 0) this.serial++;
    return removed;
  }

  /** Age one rendered frame: decrement remaining lifetimes. No allocation. Call after drawing. */
  ageFrame(): void {
    for (let i = 0; i < this.ttl.length; i++) this.ttl[i]!--;
  }

  markLights(surfs: SurfaceBounds[], count?: number): number[] {
    this.frame++;
    const n = count ?? surfs.length;
    const affected: number[] = [];
    for (let li = 0; li < this.lights.length; li++) {
      const l = this.lights[li]!;
      const rad = l.intensity < 0 ? -l.intensity : l.intensity;
      const bit = 1 << li;
      for (let si = 0; si < n; si++) {
        const s = surfs[si]!;
        const dist = bboxDistance(l.origin, s.mins, s.maxs);
        if (dist > rad) continue;
        if (this.dlightFrame.get(s.id) !== this.frame) {
          this.dlightFrame.set(s.id, this.frame);
          this.dlightBits.set(s.id, 0);
        }
        this.dlightBits.set(s.id, this.dlightBits.get(s.id)! | bit);
        if (!affected.includes(s.id)) affected.push(s.id);
      }
    }
    affected.sort((a, b) => a - b);
    return affected;
  }

  bitsFor(surfaceId: number): number {
    if (this.dlightFrame.get(surfaceId) !== this.frame) return 0;
    return this.dlightBits.get(surfaceId) ?? 0;
  }
}

export function bboxDistance(p: Float32Array, mins: Float32Array, maxs: Float32Array): number {
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const v = p[i]!;
    if (v < mins[i]!) {
      const d = mins[i]! - v;
      d2 += d * d;
    } else if (v > maxs[i]!) {
      const d = v - maxs[i]!;
      d2 += d * d;
    }
  }
  return Math.sqrt(d2);
}
