// @q2/voodoo — documented approximation profile.
//
// VOODOO_APPROX_PROFILE lists every setting that is NOT hardware-calibrated:
// what the Voodoo3 programming guide (revision 1.4, 14 June 1999) explicitly
// defines vs what this package chooses as a deterministic stand-in. No
// hardware captures or known driver configuration exist to calibrate against,
// so nothing here may be called "hardware-calibrated" — that label is
// reserved for a later comparison against a documented hardware/driver
// reference. Pinned by src/profile.test.ts; summarized in README.md.
//
// Source tags:
// - manual:fbzMode      — defined by the guide's fbzMode register/section.
// - manual:vidProcCfg   — defined by the guide's vidProcCfg/rgbMaxDelta section.
// - manual:textureMode  — defined by the guide's textureMode register (§9.3.58, incl. bit 4 tloddither / lodbias).
// - manual:fogTable     — defined by the guide's fogTable register (§9.3.45) / fog unit (§10.3.4).
// - approx:chosen     — deterministic approximation chosen by this package.
// - preset:appearance — appearance preset (looks right, not measured).

/** Where a profile entry's value comes from. */
export type ApproxSource =
  | 'manual:fbzMode'
  | 'manual:vidProcCfg'
  | 'manual:textureMode'
  | 'manual:fogTable'
  | 'approx:chosen'
  | 'preset:appearance';

export interface ApproxEntry {
  /** Stable setting key (e.g. 'scanout.order'). */
  setting: string;
  /** Current value/policy in this package. */
  value: string;
  /** Manual anchor or approximation/preset tag. */
  source: ApproxSource;
  /** One-line justification. */
  note: string;
}

/**
 * The documented approximation profile. Order is stable (test-pinned):
 * dither, scanout, gamma, LOD, fog, texture upload, depth.
 */
export const VOODOO_APPROX_PROFILE: ReadonlyArray<Readonly<ApproxEntry>> = Object.freeze([
  Object.freeze({
    setting: 'dither.modes',
    value: '2x2 and 4x4 ordered dither at target writes (default 4x4)',
    source: 'manual:fbzMode',
    note: 'fbzMode supports both 2x2 and 4x4 ordered dither (vd_dithermode).',
  }),
  Object.freeze({
    setting: 'dither.weights-phase',
    value: 'canonical Bayer matrices, +/-0.5 LSB amplitude, absolute screen phase',
    source: 'approx:chosen',
    note: 'Exact MiniGL matrix weights/amplitude/phase uncalibrated; deterministic stand-in.',
  }),
  Object.freeze({
    setting: 'scanout.order',
    value: 'linear pack -> reconstruct/box in the video processor -> display gamma for all modes (incl. legacy box)',
    source: 'approx:chosen',
    note: 'Inferred order from video-proc vs RAMDAC placement (PG §6.5.3 overlay/desktop formats + CLUT-bypass bits); no explicit order sentence in the manual. Video-processor (not RAMDAC) wording.',
  }),
  Object.freeze({
    setting: 'scanout.matched-pairs',
    value: '2x2sub+2x2box and 4x4sub+4x1; subtract matrix dictated by the mode (PG §17.8 3-bit-tap alternative tracked, scope decision in VF-6)',
    source: 'manual:vidProcCfg',
    note: 'A blanket 2x2 blur after 4x4 dither is not the established pairing; PG §17.8 retains a 3-bit tap filter for RGB565 dithered as an alternative to the 2x2 box — unmodeled, scope decision in VF-6.',
  }),
  Object.freeze({
    setting: 'scanout.tap-alignment',
    value: '2x2 forward [x,x+1] window; 4x1 centered [x-1,x+2] window; clamp-to-edge; absolute coords',
    source: 'approx:chosen',
    note: 'Window origins provisional but deterministic; absolute coords keep worker bands seamless.',
  }),
  Object.freeze({
    setting: 'scanout.rgbMaxDelta-register',
    value: 'per-component substitute-with-centre then filter; metric is per-tap deviation from centre; 6-bit fields 0..63 (PG §6.5.2 bits 21:16/13:8/5:0)',
    source: 'manual:vidProcCfg',
    note: 'rgbMaxDelta gate substitutes a breaching component with the centre tap before the box filter; exact MiniGL programming uncalibrated.',
  }),
  Object.freeze({
    setting: 'scanout.rgbMaxDelta-values',
    value: 'default 8,8,8 (smooth passes, hard edges reject); 0,0,0 disables rejection (= unconditional box)',
    source: 'approx:chosen',
    note: 'MiniGL programming of the register unestablished; thresholds are placeholders.',
  }),
  Object.freeze({
    setting: 'scanout.default',
    value: "reconmode defaults to '2x2sub+2x2box' (matched 2x2 subtract + box with 8,8,8 rejection); 'legacy' is an accepted alias for the unconditional 2x2 box (no subtraction)",
    source: 'approx:chosen',
    note: 'Matched mode is the hardware-correct default; legacy alias kept for compat tests.',
  }),
  Object.freeze({
    setting: 'gamma.curve',
    value: 'power-curve LUT: out = round(255 * (i/255)^(1/gamma))',
    source: 'approx:chosen',
    note: 'Specified power-curve form; the real RAMDAC curve is uncalibrated.',
  }),
  Object.freeze({
    setting: 'gamma.value',
    value: 'adjustable (vd_gamma); default 1.3',
    source: 'preset:appearance',
    note: '1.3 is an appearance preset (Glide-style lift), not a measured hardware constant.',
  }),
  Object.freeze({
    setting: 'gamma.stage',
    value: 'all modes: linear pack + reconstruct/box, LUT on the display plane after',
    source: 'approx:chosen',
    note: 'Single video-processor order (not RAMDAC); the legacy gamma-on-source ordering is removed.',
  }),
  Object.freeze({
    setting: 'lod.bias-sign',
    value: 'additive: lod = log2(rho) + bias (negative bias favours finer detail)',
    source: 'manual:textureMode',
    note: 'Follows the textureMode lodbias convention (PG §9.3.58 / tLOD).',
  }),
  Object.freeze({
    setting: 'lod.dither-mean',
    value: 'hardware LOD dithering (tloddither, textureMode bit 4) averages +0.375',
    source: 'manual:textureMode',
    note: 'textureMode bit 4 tloddither (PG §9.3.58): average +0.375, bias-compensated.',
  }),
  Object.freeze({
    setting: 'lod.compensation',
    value: 'single +0.375 added in mipLevel for the tlodDither path only; round-to-nearest path uncompensated',
    source: 'approx:chosen',
    note: 'Applied exactly once in mipLevel (never in pickMipLevel); pairing rule: both flags agree. +0.375 addend is manual:textureMode (PG §9.3.58 bit 4); the pick itself is NOT PG trilinear (two-pass blend).',
  }),
  Object.freeze({
    setting: 'lod.pick-mechanism',
    value: 'dithered single-level selection: per-pixel pick of LOD n or n+1 by fractional LOD vs Bayer threshold',
    source: 'approx:chosen',
    note: 'Bayer-threshold pick is package invention (approx:chosen); NOT PG trilinear, which is two-pass blend. +0.375 mean addend is manual:textureMode (PG §9.3.58 bit 4).',
  }),
  Object.freeze({
    setting: 'lod.bias-value',
    value: 'adjustable (vd_lodbias); default -0.35',
    source: 'preset:appearance',
    note: '-0.35 is a project preset, not a universal hardware constant.',
  }),
  Object.freeze({
    setting: 'fog.formula',
    value: 'exp^2 table, density 3.0 default (buildFogTable / buildFogLUT01)',
    source: 'approx:chosen',
    note: 'PG §9.3.45/§10.3.4: the table is loaded by the application — formula and density are driver policy, not hardware.',
  }),
  Object.freeze({
    setting: 'fog.index-domain',
    value: 'caller maps NDC depth to w01 [0,1] first (shaders.ts vFogW); hardware indexes raw 1/W bits',
    source: 'approx:chosen',
    note: 'w01*64 stands in for the hardware hi-6-bit index + lo-8-bit blend split; linear w01 is NOT 1/W-bit space.',
  }),
  Object.freeze({
    setting: 'fog.interpolation',
    value: 'inter-entry lerp by fractional position (CPU fogFactor/fogFactorLerp, GLSL voodooApplyFog)',
    source: 'manual:fogTable',
    note: 'PG §10.3.4: low 8 bits of 1/W blend between entries to reduce banding; implemented on the caller w01 domain.',
  }),
  Object.freeze({
    setting: 'fog.deltas',
    value: 'per-entry 6.2 delta factors NOT applied',
    source: 'approx:chosen',
    note: 'PG §9.3.45 defines 6.2 deltas (diff <= 63, sum <= 255); tracked omission — hardware behavior not invented.',
  }),
  Object.freeze({
    setting: 'fog.dither-zones',
    value: 'fogdither (fogMode[6]) and forzones (fogMode bit 7) NOT implemented',
    source: 'approx:chosen',
    note: 'Tracked omission: no dithering of the fog blend component, no signed fog delta.',
  }),
  Object.freeze({
    setting: 'upload.repeat-nonpot',
    value: 'REPEAT textures: true texel resampling (resampleTexture box filter)',
    source: 'approx:chosen',
    note: 'Application/driver policy choice: padding would break wrap seams, so repeat resamples.',
  }),
  Object.freeze({
    setting: 'upload.clamp-nonpot',
    value: 'CLAMPED textures: pad to POT + UV scale adjust (padTextureToPOT edge replication)',
    source: 'approx:chosen',
    note: 'Application/driver policy choice: texels preserved byte-exact; resampling would blur.',
  }),
  Object.freeze({
    setting: 'texture.bilinear-weights',
    value: '4-tap bilinear with 8-bit fixed-point weights',
    source: 'approx:chosen',
    note: 'PG confirms 4 taps; silent on weight precision — 8-bit weights are a deterministic stand-in.',
  }),
  Object.freeze({
    setting: 'texture.mip-kernel',
    value: 'missing mip levels generated by 2x2 box filter (halveRGB)',
    source: 'approx:chosen',
    note: 'PG describes driver-provided mip chains only; the box generation kernel is a deterministic stand-in.',
  }),
  Object.freeze({
    setting: 'lightmap.overbright-x2',
    value: 'diffuse x lightmap x (overbright ? 2 : 1), ((m*tr*lr+127)/255)|0 per channel, clamp 255',
    source: 'approx:chosen',
    note: 'Post-id game/driver-pipeline convention (Q3-era overbright / gl_modulate 2 / MiniGL-style lift saturated in 8-bit), NOT id ref_gl (default 1: gl_rmain.c:994, gl_local.h:226, gl_light.c) and NOT a Voodoo combine stage (PG §10.3.1/§10.3.2/§10.6.1: mux/add-local/invert only, no scale). Rounding/clamp uncalibrated.',
  }),
  Object.freeze({
    setting: 'depth.z16',
    value: 'normalized Z16: depth01 from near/far planes, quantise BEFORE test, LESS wins, ties keep stored, clear = far',
    source: 'approx:chosen',
    note: 'Explicitly defined normalized-Z semantics in this package; not hardware-calibrated.',
  }),
  Object.freeze({
    setting: 'depth.wbuffer',
    value: 'W-buffer NOT implemented',
    source: 'approx:chosen',
    note: 'A true W-buffer needs the Voodoo3 1/W hardware encoding; these helpers are Z-operation only.',
  }),
] as ReadonlyArray<Readonly<ApproxEntry>>);
