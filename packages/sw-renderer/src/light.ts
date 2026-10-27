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
 * dlights: dynamic lights; dlightBits selects the affecting ones (bit d for
 * dlights[d], as set by DLightState.markLights).
 * surfCenter: legacy single-point falloff reference (whole-surface boost).
 * luxelPos: optional per-luxel world-space centers (w*h*3, row-major) for
 * per-luxel falloff (id R_AddDynamicLights computes per-luxel: a point light
 * only affects nearby luxels). When absent, every luxel uses surfCenter
 * (legacy uniform boost; keeps the no-geometry unit-test path stable).
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
  luxelPos?: Float32Array | null,
): void {
  // id R_BuildLightMap sums one scaled block per valid style; the samples
  // here carry a single baked block, so the per-style scales add up. The sum
  // is hoisted: one multiply per luxel, no allocation.
  let styleScale = 0;
  for (let k = 0; k < styleScales.length; k++) styleScale += styleScales[k]!;
  if (styleScales.length === 0) styleScale = 1;
  const n = w * h;
  const perLuxel = luxelPos && luxelPos.length >= n * 3 ? luxelPos : null;
  for (let i = 0; i < n; i++) {
    const r = samples[i * 3]! / 255;
    const g = samples[i * 3 + 1]! / 255;
    const b = samples[i * 3 + 2]! / 255;
    // luma of the static sample, scaled by the summed lightstyles
    // (overbright-style modulate happens here, before the grade clamp)
    let l = (0.299 * r + 0.587 * g + 0.114 * b) * styleScale * overbright;
    // dynamic lights: linear falloff from the luxel position
    // (R_AddDynamicLights). Per-luxel world pos when the caller supplies
    // the fitted grid, else the legacy single surfCenter for all luxels.
    for (let d = 0; d < dlights.length; d++) {
      if (((dlightBits >> d) & 1) === 0) continue;
      const dl = dlights[d]!;
      const px = perLuxel ? perLuxel[i * 3]! : surfCenter[0]!;
      const py = perLuxel ? perLuxel[i * 3 + 1]! : surfCenter[1]!;
      const pz = perLuxel ? perLuxel[i * 3 + 2]! : surfCenter[2]!;
      const dx = dl.origin[0]! - px;
      const dy = dl.origin[1]! - py;
      const dz = dl.origin[2]! - pz;
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

/**
 * Per-channel RGB lightmap build (astra V2a — ref_gl gl_light.c
 * R_BuildLightMap / R_AddDynamicLights port). Unlike buildLightMap, which
 * reduces static samples to a scalar luma grade for the 8-bit colormap
 * path, this keeps all three channels separate end to end:
 * - static RGB luxels scaled by the summed style scales, with the same
 *   pre-clamp overbright modulate stage as the scalar path,
 * - colored dynamic lights added per channel with linear falloff
 *   (R_AddDynamicLights), per-luxel when luxelPos is supplied,
 * - hue-preserving over-range (ref_gl bound step): when any channel
 *   exceeds 1 the whole luxel is scaled by 1/max instead of clipping
 *   channels independently, so red/blue patches keep distinct hues
 *   under style/dlight changes instead of collapsing to white.
 * Output is 0..255 bytes per channel (w*h*3). buildLightMap is untouched.
 */
export function buildRGBLightMap(
  out: Uint8Array,
  samples: Uint8Array,
  w: number,
  h: number,
  styleScales: Float32Array | number[],
  dlights: DynamicLight[],
  surfCenter: Float32Array,
  dlightBits: number,
  overbright = LIGHT_OVERBRIGHT,
  luxelPos?: Float32Array | null,
): void {
  // Same style-sum hoist as buildLightMap (single baked block per surface).
  let styleScale = 0;
  for (let k = 0; k < styleScales.length; k++) styleScale += styleScales[k]!;
  if (styleScales.length === 0) styleScale = 1;
  const n = w * h;
  const perLuxel = luxelPos && luxelPos.length >= n * 3 ? luxelPos : null;
  for (let i = 0; i < n; i++) {
    let r = (samples[i * 3]! / 255) * styleScale * overbright;
    let g = (samples[i * 3 + 1]! / 255) * styleScale * overbright;
    let b = (samples[i * 3 + 2]! / 255) * styleScale * overbright;
    for (let d = 0; d < dlights.length; d++) {
      if (((dlightBits >> d) & 1) === 0) continue;
      const dl = dlights[d]!;
      const px = perLuxel ? perLuxel[i * 3]! : surfCenter[0]!;
      const py = perLuxel ? perLuxel[i * 3 + 1]! : surfCenter[1]!;
      const pz = perLuxel ? perLuxel[i * 3 + 2]! : surfCenter[2]!;
      const dx = dl.origin[0]! - px;
      const dy = dl.origin[1]! - py;
      const dz = dl.origin[2]! - pz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const rad = dl.intensity;
      if (dist < rad) {
        const f = (rad - dist) / rad;
        r += f * dl.color[0]!;
        g += f * dl.color[1]!;
        b += f * dl.color[2]!;
      }
    }
    // Hue-preserving over-range: normalize the whole luxel by the max
    // channel instead of clipping per channel (which would push saturated
    // red/blue patches toward white and erase their hue difference).
    const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (m > 1) {
      const s = 1 / m;
      r *= s;
      g *= s;
      b *= s;
    }
    if (r < 0) r = 0;
    if (g < 0) g = 0;
    if (b < 0) b = 0;
    out[i * 3] = Math.round(r * 255);
    out[i * 3 + 1] = Math.round(g * 255);
    out[i * 3 + 2] = Math.round(b * 255);
  }
}

/**
 * Fit world-space positions for every luxel of a surface lightmap grid.
 * The surface is planar, so world xyz is an exact affine function of the
 * per-vertex luxel coords (lux = (uv - base)/16, see bspWorld): solve the
 * map from the first non-collinear vertex triple, then evaluate at luxel
 * centers (s+0.5, t+0.5). Degenerate input (n < 3, all verts sharing one
 * luxel, NaN) falls back to `center` for every luxel — never NaN, never
 * throws. `out` must hold at least w*h*3 floats. No allocation.
 */
export function luxelWorldPositions(
  verts: Float32Array,
  lux: Float32Array,
  n: number,
  w: number,
  h: number,
  center: Float32Array,
  out: Float32Array,
): void {
  const need = w * h * 3;
  const fillCenter = (): void => {
    const cx = center[0] ?? 0, cy = center[1] ?? 0, cz = center[2] ?? 0;
    for (let i = 0; i < need; i += 3) {
      out[i] = cx;
      out[i + 1] = cy;
      out[i + 2] = cz;
    }
  };
  if (!(n >= 3) || !(w >= 1) || !(h >= 1) || out.length < need) {
    if (out.length >= need) fillCenter();
    return;
  }
  // First non-collinear triple in luxel space defines the exact affine map.
  const s0 = lux[0]!, t0 = lux[1]!;
  let i1 = -1, i2 = -1;
  let ds1 = 0, dt1 = 0, ds2 = 0, dt2 = 0;
  if (!Number.isFinite(s0) || !Number.isFinite(t0)) {
    fillCenter();
    return;
  }
  outer: for (let a = 1; a < n; a++) {
    const sa = lux[a * 2]!, ta = lux[a * 2 + 1]!;
    if (!Number.isFinite(sa) || !Number.isFinite(ta)) continue;
    for (let b = a + 1; b < n; b++) {
      const sb = lux[b * 2]!, tb = lux[b * 2 + 1]!;
      if (!Number.isFinite(sb) || !Number.isFinite(tb)) continue;
      const e1s = sa - s0, e1t = ta - t0;
      const e2s = sb - s0, e2t = tb - t0;
      const area2 = e1s * e2t - e2s * e1t;
      // Scale-relative collinearity reject (luxel units can be large).
      const m1 = e1s * e1s + e1t * e1t;
      const m2 = e2s * e2s + e2t * e2t;
      if (area2 * area2 > 1e-12 * m1 * m2) {
        i1 = a;
        i2 = b;
        ds1 = e1s;
        dt1 = e1t;
        ds2 = e2s;
        dt2 = e2t;
        break outer;
      }
    }
  }
  if (i1 < 0) {
    fillCenter();
    return;
  }
  const det = ds1 * dt2 - ds2 * dt1;
  if (!(Math.abs(det) > 0)) {
    fillCenter();
    return;
  }
  const inv = 1 / det;
  const p0x = verts[0]!, p0y = verts[1]!, p0z = verts[2]!;
  const a1x = verts[i1 * 3]! - p0x, a1y = verts[i1 * 3 + 1]! - p0y, a1z = verts[i1 * 3 + 2]! - p0z;
  const a2x = verts[i2 * 3]! - p0x, a2y = verts[i2 * 3 + 1]! - p0y, a2z = verts[i2 * 3 + 2]! - p0z;
  if (!Number.isFinite(a1x + a1y + a1z + a2x + a2y + a2z + p0x + p0y + p0z)) {
    fillCenter();
    return;
  }
  // A = [P1-P0, P2-P0] * M^-1, c = P0 - A*[s0, t0]; eval at centers.
  const m00 = dt2 * inv, m01 = -ds2 * inv;
  const m10 = -dt1 * inv, m11 = ds1 * inv;
  const axx = a1x * m00 + a2x * m10, axy = a1x * m01 + a2x * m11;
  const ayx = a1y * m00 + a2y * m10, ayy = a1y * m01 + a2y * m11;
  const azx = a1z * m00 + a2z * m10, azy = a1z * m01 + a2z * m11;
  const cx = p0x - (axx * s0 + axy * t0);
  const cy = p0y - (ayx * s0 + ayy * t0);
  const cz = p0z - (azx * s0 + azy * t0);
  let o = 0;
  for (let t = 0; t < h; t++) {
    const lt = t + 0.5;
    for (let s = 0; s < w; s++) {
      const ls = s + 0.5;
      out[o] = axx * ls + axy * lt + cx;
      out[o + 1] = ayx * ls + ayy * lt + cy;
      out[o + 2] = azx * ls + azy * lt + cz;
      o += 3;
    }
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
    if (this.lights.length === 0) return;
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
