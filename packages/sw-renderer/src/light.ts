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
 * Build per-luxel light grades 0..63 (R_BuildLightMap equivalent).
 * samples: RGB luxels (w*h*3, 0..255). styleScales: per-style 0..2 multipliers
 * (from RefDef.lightStyles at the surface's style indices).
 * dlights: dynamic lights with world-space surfCenter for falloff.
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
): void {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = samples[i * 3]! / 255;
    const g = samples[i * 3 + 1]! / 255;
    const b = samples[i * 3 + 2]! / 255;
    const styleScale = styleScales.length > 0 ? styleScales[0]! : 1;
    // luma of the static sample, scaled by lightstyle (qu twice like ref_gl
    // overbright is NOT applied here; the grade clamp clips highlights)
    let l = (0.299 * r + 0.587 * g + 0.114 * b) * styleScale;
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

/** Extra styles beyond the first scale the whole block (multi-style surf). */
export function combineStyleScales(styleIndices: number[], lightStyles: Float32Array): number {
  let s = 0;
  for (let i = 0; i < styleIndices.length; i++) {
    s += lightStyles[styleIndices[i]!] ?? 0;
  }
  return s;
}

/**
 * Mark surfaces touched by dynamic lights (R_MarkLights equivalent).
 * Returns the sorted list of affected surface ids and bumps state.serial.
 * Uses bbox-distance culling (dist > intensity skips the whole surface).
 */
export class DLightState {
  serial = 1;
  lights: DynamicLight[] = [];
  /** per-surface bitmask of affecting dynamic lights, keyed by surface id */
  dlightBits = new Map<number, number>();
  dlightFrame = new Map<number, number>();
  frame = 0;

  clear(): void {
    this.lights.length = 0;
    this.serial++;
  }

  addLight(l: DynamicLight): void {
    this.lights.push(l);
    this.serial++;
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
