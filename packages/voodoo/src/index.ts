// @q2/voodoo — Voodoo3/Glide emulation: post-process + sampling policy (M4.1/M4.2).
//
// Every fidelity row from BRAIN.md §7.2 is switchable through its vd_* cvar
// in @q2/config (read, never written, here). The per-frame pattern is:
//   const st = readVoodooState();   // one cvar snapshot per frame
//   ... rasterise in 8:8:8 / sample with sampleTexture ...
//   resolveFrame(fb, fb565, display, w, h, st);
// Low-level functions take explicit parameters so unit tests are deterministic
// without touching global cvars.

import { getCVarNumber, getCVarString } from '@q2/config';

export * from './bayer.js';
export * from './capture.js';
export * from './profile.js';
export * from './resolve.js';
export * from './sampler.js';
export * from './upload.js';

import { applyPostFilter, applyReconstruction2x2, applyReconstruction4x1, expandRGB565, parseDitherMode, parseReconMode, parseRgbMaxDelta, quantiseDepth, resolveRGB565, resolveRGB888 } from './resolve.js';
import { applyFog, capTextureSize, modulateLightmap, samplePalette, sampleRGBTexture } from './sampler.js';
import type { DitherMode, ReconMode, RgbMaxDelta } from './resolve.js';

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
  /** Write-path ordered-dither matrix (vd_dithermode read-path profile). */
  dithermode: DitherMode;
  /** Scanout reconstruction profile (vd_reconmode read-path profile). 'legacy'
   * stays the default: it preserves the bit-exact M4.1 path all goldens pin;
   * subtract modes are opt-in until an HW capture calibrates them. */
  reconmode: ReconMode;
  /** Per-component reconstruction rejection thresholds (vd_rgbmaxdelta). */
  rgbmaxdelta: RgbMaxDelta;
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
    dithermode: '4x4',
    reconmode: 'legacy',
    rgbmaxdelta: { r: 0, g: 0, b: 0 },
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
    dithermode: parseDitherMode(getCVarString('vd_dithermode')),
    reconmode: parseReconMode(getCVarString('vd_reconmode')),
    rgbmaxdelta: parseRgbMaxDelta(getCVarString('vd_rgbmaxdelta')),
  };
}

/**
 * Full M4.1 frame resolve: gamma -> dither -> RGB565, then the scanout
 * reconstruction into display (when enabled and provided). Zero-alloc inner
 * loops; pass display = null to skip the postfilter stage.
 *
 * Display contract (astra §2.1/§2.2):
 * - quantise on, postfilter on: display = scanout reconstruction of the 565
 *   target per st.reconmode ('legacy' = unconditional 2x2 box, the M4.1
 *   approximation; '2x2sub+2x2box' / '4x4sub+4x1' = dither-subtract + box
 *   with rgbMaxDelta edge rejection — deterministic approximations).
 * - quantise on, postfilter off: display = per-pixel expandRGB565 of the
 *   freshly packed target (NEVER stale — every pixel is rewritten).
 * - quantise off (vd_16bit=0 debug bypass): display = resolveRGB888
 *   output (gamma on, dither/postfilter bypassed); dst565 is still packed
 *   via resolveRGB565 for compat readers. Pass display = null to skip the
 *   display plane entirely.
 */
export function resolveFrame(
  src: Uint32Array,
  dst565: Uint16Array,
  display: Uint32Array | null,
  w: number,
  h: number,
  st: VoodooState = readVoodooState(),
): void {
  if (!st.quantise) {
    // Genuine RGB888 debug bypass: gamma stays on, dither/postfilter off.
    resolveRGB565(src, dst565, w, h, { gamma: st.gamma, dither: st.dither, ditherMode: st.dithermode, quantise: st.quantise });
    if (display !== null) resolveRGB888(src, display, w, h, { gamma: st.gamma, dither: false });
    return;
  }
  resolveRGB565(src, dst565, w, h, { gamma: st.gamma, dither: st.dither, ditherMode: st.dithermode, quantise: st.quantise });
  if (display === null) return;
  if (!st.postfilter) {
    // Postfilter off: expand every newly packed pixel — no stale pixels.
    const n = w * h;
    for (let i = 0; i < n; i++) display[i] = expandRGB565(dst565[i]!);
    return;
  }
  // Matched scanout reconstruction. The subtract matrix is dictated by the
  // recon MODE; a null subtract means the write path ran dither-off, so
  // there is no pattern to remove (subtracting one would corrupt).
  if (st.reconmode === '2x2sub+2x2box') {
    applyReconstruction2x2(dst565, display, w, h, st.rgbmaxdelta, st.dither ? '2x2' : null);
    return;
  }
  if (st.reconmode === '4x4sub+4x1') {
    applyReconstruction4x1(dst565, display, w, h, st.rgbmaxdelta, st.dither ? '4x4' : null);
    return;
  }
  applyPostFilter(dst565, display, w, h);
}

/**
 * Cvar-aware depth banding: quantise stored 1/z to st.zbits (vd_zbits).
 * bits >= 24 (or <= 0) is a pass-through.
 *
 * DISPLAY/BANDING APPROXIMATION ONLY — NOT a depth-buffer emulation
 * (astra §2.5): post-hoc on already-resolved depth, cannot affect
 * visibility. True emulation must quantise BEFORE test/write against a
 * future internal quantized plane. Framebuffer.depth keeps 1/z semantics.
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
 * Cvar-aware paletted texture sample. Filtering is governed by vd_bilinear
 * ONLY: vd_palettetex selects the upload/representation policy (paletted
 * vs expanded storage) and must NOT gate filtering (astra §2.3). With
 * bilinear off the texture point-samples (single nearest index expanded
 * through the palette). Writes RGB to out[off..off+2]. For the expanded
 * RGB-triplet path with the same policy see sampleRGBTextureFrame.
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
  samplePalette(indices, palette, w, h, u, v, out, off, st.bilinear);
}

/**
 * Cvar-aware expanded-RGB texture sample: tex holds w*h RGB triplets
 * (upload-time expanded storage, the vd_palettetex=0 representation).
 * Same bilinear/nearest policy as sampleTexture, driven by vd_bilinear
 * only. Writes RGB to out[off..off+2].
 */
export function sampleRGBTextureFrame(
  tex: Uint8Array,
  w: number,
  h: number,
  u: number,
  v: number,
  out: Uint8Array,
  off: number,
  st: VoodooState = readVoodooState(),
): void {
  sampleRGBTexture(tex, w, h, u, v, out, off, st.bilinear);
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
