// RELEASE-15 — underwater view presentation (eye-contents blend + software
// screen warp). C sources: game/p_view.c SV_CalcBlend (contents block),
// client/cl_view.c V_RenderView (the +1/16 vieworg nudge), ref_soft/r_scan.c
// D_WarpScreen + r_main.c R_InitTurb/R_CalcPalette, ref_gl/gl_rmain.c
// R_PolyBlend.
//
// Source behavior this ports (numbers pinned against ../external/quake-2-source):
// - SV_CalcBlend keys BOTH the fullscreen blend AND RDF_UNDERWATER off
//   gi.pointcontents at the eye (origin + viewoffset). Water adds
//   (0.5,0.3,0.2,0.4), slime (0.0,0.1,0.05,0.6), lava/solid
//   (1.0,0.3,0.0,0.6); RDF_UNDERWATER is set for lava|slime|water only
//   (a solid eye still blends, but never warps).
// - ref_soft warps the finished 8-bit frame with a sine displacement
//   (D_WarpScreen) when sw_waterwarp (default 1) AND RDF_UNDERWATER, then
//   applies the blend through the palette (R_CalcPalette, after the warp).
// - ref_gl NEVER reads RDF_UNDERWATER: submerged GL views get the
//   fullscreen blend quad (R_PolyBlend, gl_polyblend default 1) and NO
//   screen warp. Water SURFACES warp in both renderers (turbulent spans /
//   EmitWaterPolys) — that is surface animation, not refraction, and is
//   untouched here. There is no FOV change underwater in either backend.
//
// q2ts placement (frozen RefDef contract carries no rdflags/blend channel,
// so this deliberately stays out of the renderers, like the RELEASE-14
// damage wash in drawPlayHud):
// - The tint is a fullscreen SRC_OVER wash painted in drawPlayHud BEFORE
//   the damage wash (C composites contents, then damage) on BOTH backends
//   (the GPU overlay path funnels through drawPlayHud too).
// - The warp runs on the software index plane between renderView and
//   endFrame (palette expand), mirroring warp-then-palettize. C renders the
//   3D view small (320x240 warpbuffer) and upscales through the warp; q2ts
//   renders full-res and warps in place — sharper than C, documented.
//   Nearest-neighbor warp commutes with the palette lookup, so warping the
//   indexed plane pre-expand is exactly warp-after-expand on colors.
// - The GPU backend applies NO screen warp (ref_gl parity).

import {
  CONTENTS_LAVA,
  CONTENTS_SLIME,
  CONTENTS_SOLID,
  CONTENTS_WATER,
  type PointContentsFn,
} from '@q2/game';
import type { Vec3 } from '@q2/math';
import { v3 } from '@q2/math';

/** Sine-warp amplitude steps (ref_soft r_local.h AMP2). */
export const UNDERWATER_WARP_AMP = 3;
/** Warp phase speed, cycles/sec scaled (ref_soft r_local.h SPEED). */
export const UNDERWATER_WARP_SPEED = 20;
/** Turbulent cycle size (ref_soft r_local.h CYCLE). */
export const UNDERWATER_WARP_CYCLE = 128;
/** Full sine table length (ref_soft r_rast.c intsintable[1280]). */
export const UNDERWATER_WARP_TABLE = 1280;
/** Edge-compression margin, 2*AMP2 (D_WarpScreen rowptr/column sizing). */
export const UNDERWATER_WARP_MARGIN = UNDERWATER_WARP_AMP * 2;
/** Eye-contents nudge per axis (cl_view.c: vieworg += 1/16, keeps the eye
 * off exact node lines so a water plane cannot disappear / misclassify). */
export const EYE_CONTENTS_NUDGE = 1 / 16;

/** Closed-form intsintable value (r_main.c R_InitTurb, float form). */
export function warpTableValue(idx: number): number {
  return UNDERWATER_WARP_AMP + Math.sin((idx * 2 * Math.PI) / UNDERWATER_WARP_CYCLE) * UNDERWATER_WARP_AMP;
}

/** Integer warp offset at table index (C truncates toward zero on x86). */
export function warpTableInt(idx: number): number {
  const v = warpTableValue(idx);
  return v < 0 ? Math.ceil(v) : Math.floor(v);
}

export type UnderwaterKind = 'water' | 'slime' | 'lava' | 'solid';

export interface UnderwaterState {
  kind: UnderwaterKind;
  /** 0..1 fullscreen blend color (SV_CalcBlend contents block, exact). */
  r: number;
  g: number;
  b: number;
  /** 0..1 fullscreen blend alpha. */
  a: number;
  /** RDF_UNDERWATER equivalent: warp the screen (lava|slime|water only). */
  submerged: boolean;
}

/**
 * SV_CalcBlend contents block (game/p_view.c) in compact pmove contents
 * bits (SOLID 1, WATER 2, SLIME 4, LAVA 8 — same branch shape as the raw
 * BSP bits C reads: solid|lava first, then slime, then water). Null when
 * the eye is dry. Pure: no allocation beyond the result.
 */
export function underwaterBlendForContents(contents: number): UnderwaterState | null {
  if (contents & (CONTENTS_SOLID | CONTENTS_LAVA)) {
    return {
      kind: (contents & CONTENTS_LAVA) !== 0 ? 'lava' : 'solid',
      r: 1.0, g: 0.3, b: 0.0, a: 0.6,
      submerged: (contents & (CONTENTS_LAVA | CONTENTS_SLIME | CONTENTS_WATER)) !== 0,
    };
  }
  if (contents & CONTENTS_SLIME) {
    return { kind: 'slime', r: 0.0, g: 0.1, b: 0.05, a: 0.6, submerged: true };
  }
  if (contents & CONTENTS_WATER) {
    return { kind: 'water', r: 0.5, g: 0.3, b: 0.2, a: 0.4, submerged: true };
  }
  return null;
}

/**
 * Eye-contents query with the cl_view.c +1/16 nudge on each axis. The
 * render eye is passed through untouched; only the classification point
 * is nudged (C nudges refdef.vieworg itself, but q2ts keeps the render
 * origin exact and the nudge is a pointcontents robustness margin).
 */
export function eyeContentsAt(contentsFn: PointContentsFn, eye: Vec3): number {
  // The caller's eye is never mutated; only the classification point moves.
  return contentsFn(v3(eye[0]! + EYE_CONTENTS_NUDGE, eye[1]! + EYE_CONTENTS_NUDGE, eye[2]! + EYE_CONTENTS_NUDGE));
}

// --- D_WarpScreen port (ref_soft/r_scan.c) --------------------------------
//
// intsintable cache (R_InitTurb values, integer form) + per-resolution
// row/column compression tables (the C static cached_width/height cache),
// then the same displacement compositing: dest[u,v] =
// src[col[turb[v]+u], row[v+turb[u]]].
//
// C renders into a 320x240 warpbuffer and maps through r_refdef.vrect; here
// source and dest are the same full-res plane (vrect == view), so the
// column/row tables map [0,w+MARG)->[0,w) / [0,h+MARG)->[0,h).

const warpIntTable: Int32Array = (() => {
  const t = new Int32Array(UNDERWATER_WARP_TABLE);
  for (let i = 0; i < UNDERWATER_WARP_TABLE; i++) t[i] = warpTableInt(i);
  return t;
})();

interface WarpTables {
  w: number;
  h: number;
  col: Int32Array;
  row: Int32Array;
}

let cachedTables: WarpTables | null = null;

function warpTablesFor(w: number, h: number): WarpTables {
  const c = cachedTables;
  if (c && c.w === w && c.h === h) return c;
  const m = UNDERWATER_WARP_MARGIN;
  const col = new Int32Array(w + m);
  for (let u = 0; u < w + m; u++) col[u] = ((u / (w + m)) * w) | 0;
  const row = new Int32Array(h + m);
  for (let v = 0; v < h + m; v++) row[v] = (((v / (h + m)) * h) | 0) * w;
  cachedTables = { w, h, col, row };
  return cachedTables;
}

let warpScratch: Uint8Array | null = null;

/**
 * D_WarpScreen on an indexed plane, in place (needs a same-size scratch
 * copy; a module-level scratch is reused across calls like C's statics).
 * timeSec is the render clock (RefDef.time). Deterministic: same
 * (plane, time) always yields the same output. Returns false + touches
 * nothing when the plane size mismatches (never throws on engine buffers).
 */
export function warpIndexBufferUnderwater(
  index: Uint8Array,
  w: number,
  h: number,
  timeSec: number,
): boolean {
  if (index.length !== w * h || w <= 0 || h <= 0) return false;
  if (!Number.isFinite(timeSec)) return false;
  if (!warpScratch || warpScratch.length !== index.length) {
    warpScratch = new Uint8Array(index.length);
  }
  const src = warpScratch;
  src.set(index);
  const { col, row } = warpTablesFor(w, h);
  // C: turb = intsintable + ((int)(time*SPEED) & (CYCLE-1)); table is 1280
  // long so turb[v]/turb[u] stay in bounds for views up to 1152x1152 — clamp
  // the phase the same way and index modulo the table for tall views.
  const phase = (Math.floor(timeSec * UNDERWATER_WARP_SPEED) & (UNDERWATER_WARP_CYCLE - 1)) >>> 0;
  const at = (k: number): number => warpIntTable[(phase + k) % UNDERWATER_WARP_TABLE]!;
  for (let v = 0; v < h; v++) {
    const tv = at(v);
    const destRow = v * w;
    const rowBase = v;
    for (let u = 0; u < w; u++) {
      const sx = col[tv + u]!;
      const sy = row[rowBase + at(u)]!;
      index[destRow + u] = src[sy + sx]!;
    }
  }
  return true;
}

/** Test hook: drop the cached compression tables + scratch. */
export function testResetWarpCache(): void {
  cachedTables = null;
  warpScratch = null;
}
