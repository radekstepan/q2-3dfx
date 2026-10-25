// @q2/voodoo — Voodoo3/Glide emulation: post-process + sampling policy (M4.1/M4.2).
//
// Every fidelity row from BRAIN.md §7.2 is switchable through its vd_* cvar
// in @q2/config (read, never written, here). The per-frame pattern is:
//   const st = readVoodooState();   // one cvar snapshot per frame
//   ... rasterise in 8:8:8 / sample with sampleTexture ...
//   resolveFrame(fb, fb565, display, w, h, st);
// Low-level functions take explicit parameters so unit tests are deterministic
// without touching global cvars.

import { getCVarNumber } from '@q2/config';

export * from './bayer.js';
export * from './resolve.js';
export * from './sampler.js';

import { applyPostFilter, quantiseDepth, resolveRGB565 } from './resolve.js';
import { applyFog, capTextureSize, modulateLightmap, samplePalette } from './sampler.js';

export interface VoodooState {
  gamma: number;
  lodbias: number;
  dither: boolean;
  postfilter: boolean;
  fog: boolean;
  quantise: boolean;
  bilinear: boolean;
  mipdither: boolean;
  overbright: boolean;
  palettetex: boolean;
  maxtexsize: number;
  zbits: number;
}

export function defaultVoodooState(): VoodooState {
  return {
    gamma: 1.3,
    lodbias: -0.35,
    dither: true,
    postfilter: true,
    fog: true,
    quantise: true,
    bilinear: true,
    mipdither: true,
    overbright: true,
    palettetex: true,
    maxtexsize: 256,
    zbits: 16,
  };
}

/** Snapshot every vd_* cvar (BRAIN.md §7.2) into one frame-reused state. */
export function readVoodooState(): VoodooState {
  return {
    gamma: getCVarNumber('vd_gamma'),
    lodbias: getCVarNumber('vd_lodbias'),
    dither: getCVarNumber('vd_dither') !== 0,
    postfilter: getCVarNumber('vd_postfilter') !== 0,
    fog: getCVarNumber('vd_fog') !== 0,
    quantise: getCVarNumber('vd_16bit') !== 0,
    bilinear: getCVarNumber('vd_bilinear') !== 0,
    mipdither: getCVarNumber('vd_mipdither') !== 0,
    overbright: getCVarNumber('vd_overbright') !== 0,
    palettetex: getCVarNumber('vd_palettetex') !== 0,
    maxtexsize: getCVarNumber('vd_maxtexsize'),
    zbits: getCVarNumber('vd_zbits'),
  };
}

/**
 * Full M4.1 frame resolve: gamma -> dither -> RGB565, then the 2x2 box
 * post filter into display (when enabled and provided). Zero-alloc inner
 * loops; pass display = null to skip the postfilter stage.
 */
export function resolveFrame(
  src: Uint32Array,
  dst565: Uint16Array,
  display: Uint32Array | null,
  w: number,
  h: number,
  st: VoodooState = readVoodooState(),
): void {
  resolveRGB565(src, dst565, w, h, { gamma: st.gamma, dither: st.dither, quantise: st.quantise });
  if (st.postfilter && display !== null) applyPostFilter(dst565, display, w, h);
}

/**
 * Cvar-aware depth banding: quantise stored 1/z to st.zbits (vd_zbits).
 * bits >= 24 (or <= 0) is a pass-through.
 */
export function quantiseDepthFrame(
  depth: Float32Array,
  st: VoodooState = readVoodooState(),
): void {
  quantiseDepth(depth, st.zbits);
}

/**
 * Cvar-aware texture cap: halve until both dimensions fit st.maxtexsize
 * (vd_maxtexsize, 256 on real hardware). max <= 0 disables the cap.
 */
export function capTextureSizeFrame(
  w: number,
  h: number,
  st: VoodooState = readVoodooState(),
): { w: number; h: number } {
  return capTextureSize(w, h, st.maxtexsize);
}

/**
 * Cvar-aware texture sample: honours vd_bilinear + vd_palettetex.
 * With either off the texture point-samples (single nearest index expanded
 * through the palette). Writes RGB to out[off..off+2].
 */
export function sampleTexture(
  indices: Uint8Array,
  palette: Uint8Array,
  w: number,
  h: number,
  u: number,
  v: number,
  out: Uint8Array,
  off: number,
  st: VoodooState = readVoodooState(),
): void {
  samplePalette(indices, palette, w, h, u, v, out, off, st.bilinear && st.palettetex);
}

/**
 * Cvar-aware shade: lightmap modulate (vd_overbright x2 + clamp) then
 * table-fog blend (vd_fog). factor is the 0..255 fog table lookup.
 * Returns packed 0xFFBBGGRR.
 */
export function shadePixel(
  tr: number,
  tg: number,
  tb: number,
  lr: number,
  lg: number,
  lb: number,
  fr: number,
  fg: number,
  fb: number,
  factor: number,
  st: VoodooState = readVoodooState(),
): number {
  const lit = modulateLightmap(tr, tg, tb, lr, lg, lb, st.overbright);
  if (!st.fog || factor <= 0) return lit;
  return applyFog(lit & 255, (lit >> 8) & 255, (lit >> 16) & 255, fr, fg, fb, factor);
}
