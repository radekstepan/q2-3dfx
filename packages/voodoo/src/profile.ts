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
// - manual:fbzMode    — defined by the guide's fbzMode register/section.
// - manual:vidProcCfg — defined by the guide's vidProcCfg/rgbMaxDelta section.
// - manual:tLOD       — defined by the guide's textureMode/tLOD section.
// - approx:chosen     — deterministic approximation chosen by this package.
// - preset:appearance — appearance preset (looks right, not measured).

/** Where a profile entry's value comes from. */
export type ApproxSource =
  | 'manual:fbzMode'
  | 'manual:vidProcCfg'
  | 'manual:tLOD'
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
 * dither, scanout, gamma, LOD, texture upload, depth.
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
    value: 'subtract-then-filter for non-legacy reconmodes',
    source: 'manual:vidProcCfg',
    note: 'vidProcCfg specifies dither subtraction before 2x2-box / 4x1 reconstruction.',
  }),
  Object.freeze({
    setting: 'scanout.matched-pairs',
    value: '2x2sub+2x2box and 4x4sub+4x1 only; subtract matrix dictated by the mode',
    source: 'manual:vidProcCfg',
    note: 'A blanket 2x2 blur after 4x4 dither is not an established hardware pairing.',
  }),
  Object.freeze({
    setting: 'scanout.tap-alignment',
    value: '2x2 forward [x,x+1] window; 4x1 centered [x-1,x+2] window; clamp-to-edge; absolute coords',
    source: 'approx:chosen',
    note: 'Window origins provisional but deterministic; absolute coords keep worker bands seamless.',
  }),
  Object.freeze({
    setting: 'scanout.rgbMaxDelta-register',
    value: 'per-component rejection thresholds; rejected pixels keep the centre tap sharp',
    source: 'manual:vidProcCfg',
    note: 'rgbMaxDelta gate + keep-centre rule follow vidProcCfg; exact tap weights uncalibrated.',
  }),
  Object.freeze({
    setting: 'scanout.rgbMaxDelta-values',
    value: 'default 0,0,0 (no rejection = legacy unconditional box); comparison profile 8,8,8',
    source: 'approx:chosen',
    note: 'MiniGL programming of the register unestablished; thresholds are placeholders.',
  }),
  Object.freeze({
    setting: 'scanout.legacy-default',
    value: "reconmode defaults to 'legacy' (4x4-dither write + unconditional 2x2 box, no subtraction)",
    source: 'approx:chosen',
    note: 'Legacy stays default to preserve the bit-exact M4.1 path; subtract modes are opt-in until HW capture.',
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
    value: 'legacy: LUT on the 8:8:8 source before dither/quantise; strict (non-legacy recon): linear pack + reconstruct, LUT on the display plane after',
    source: 'approx:chosen',
    note: 'Strict follows the guide RAMDAC order; legacy keeps LUT-on-source so goldens stay bit-exact until HW capture.',
  }),
  Object.freeze({
    setting: 'lod.bias-sign',
    value: 'additive: lod = log2(rho) + bias (negative bias favours finer detail)',
    source: 'manual:tLOD',
    note: 'Follows the tLOD.lodbias register convention.',
  }),
  Object.freeze({
    setting: 'lod.dither-mean',
    value: 'hardware LOD dithering averages +0.375',
    source: 'manual:tLOD',
    note: 'Documented tloddither average per the programming guide.',
  }),
  Object.freeze({
    setting: 'lod.compensation',
    value: 'single +0.375 added in mipLevel for the tlodDither path only; round-to-nearest path uncompensated',
    source: 'approx:chosen',
    note: 'Applied exactly once (never in pickMipLevel); pairing rule: both flags agree. Not smooth trilinear.',
  }),
  Object.freeze({
    setting: 'lod.bias-value',
    value: 'adjustable (vd_lodbias); default -0.35',
    source: 'preset:appearance',
    note: '-0.35 is a project preset, not a universal hardware constant.',
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
