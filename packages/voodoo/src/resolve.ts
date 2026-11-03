// @q2/voodoo — M4.1 pure policy pins (RELEASE-8: frame driver removed).
//
// Pure per-value/per-pixel policy only: gamma LUT, RGB565 quantise/expand,
// scanout profile parsing + reconstruction threshold gates, and depth policy.
// The per-frame CPU execution driver (resolveRGB565/resolveRGB888,
// applyDisplayGamma, applyPostFilter, applyReconstruction2x2/4x1,
// resolveFusedFrame, resolveFrame) is RETIRED under RELEASE-8: the WebGL2
// backend owns appearance via packages/webgl-renderer/src/appearance.ts
// (duplicated by value).
// Conventions: colour is Uint32 0xAABBGGRR (see @q2/renderer-api Framebuffer).
// Policy helpers allocate nothing unless documented.


// --- Gamma ---------------------------------------------------------------

/** Cached LUT so the per-frame path allocates nothing. */
let cachedGamma = Number.NaN;
let cachedLUT: Uint8Array = new Uint8Array(256);

/**
 * Glide-style gamma lift LUT. out[i] = round(255 * (i/255)^(1/gamma)).
 * gamma = 1 is the identity. Glide default ~1.3 brightens midtones
 * (LUT[128] == 150 at gamma 1.3).
 */
export function gammaLUT(gamma: number): Uint8Array {
  if (!(gamma > 0) || !Number.isFinite(gamma)) {
    throw new Error(`[voodoo] gammaLUT: gamma must be > 0, got ${gamma}`);
  }
  if (gamma === cachedGamma) return cachedLUT;
  const lut = new Uint8Array(256);
  const inv = 1 / gamma;
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.min(255, Math.round(255 * Math.pow(i / 255, inv)));
  }
  cachedGamma = gamma;
  cachedLUT = lut;
  return lut;
}


// --- RGB565 quantise -----------------------------------------------------

const R5_MASK = 0b11111000;
const G6_MASK = 0b11111100;

/** Pack 8:8:8 into RGB565: (r5 << 11) | (g6 << 5) | b5, truncating. */
export function quantiseRGB565(r: number, g: number, b: number): number {
  return (((r & R5_MASK) << 8) | ((g & G6_MASK) << 3) | ((b & R5_MASK) >> 3)) & 0xffff;
}

/** Expand RGB565 back to 8:8:8 packed 0xFFBBGGRR with bit replication. */
export function expandRGB565(v: number): number {
  const r5 = (v >> 11) & 31;
  const g6 = (v >> 5) & 63;
  const b5 = v & 31;
  const r = (r5 << 3) | (r5 >> 2);
  const g = (g6 << 2) | (g6 >> 4);
  const b = (b5 << 3) | (b5 >> 2);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

// --- Scanout profile data (vd_dithermode / vd_reconmode / vd_rgbmaxdelta) -----
//
// Read-path-only driver-profile selectors (registered in @q2/config).
// Values are snapshots in VoodooState. Every
// combination is a DETERMINISTIC APPROXIMATION until an HW capture
// establishes the MiniGL programming of fbzMode / vidProcCfg / rgbMaxDelta.

/** Ordered-dither matrix at target writes: '4x4' (default) or '2x2'. */
export type DitherMode = '2x2' | '4x4';

/**
 * Scanout reconstruction profile (vidProcCfg):
 * - '2x2sub+2x2box' (DEFAULT): subtract the 2x2 dither pattern, then 2x2
 *   box with rgbMaxDelta edge rejection — the matched hardware pairing.
 * - '4x4sub+4x1': subtract the 4x4 dither pattern, then a horizontal 4x1 box
 *   (centered window [x-1, x+2], clamp-to-edge) with rgbMaxDelta rejection.
 * - 'legacy': accepted alias for the unconditional 2x2 box with NO dither
 *   subtraction (compat/tests only) — same linear-pack + display-gamma
 *   placement as every other mode, just no subtract and no edge rejection.
 * The subtract matrix is dictated by the MODE, never by vd_dithermode: the
 * scanout filter is programmed for the mode's pattern regardless of the
 * write matrix. A mismatched write dither (e.g. 2x2 writes under 4x4sub+4x1
 * scanout) still subtracts the mode's pattern — deterministic and tolerated,
 * not an error. A dither-off write path subtracts nothing.
 */
export type ReconMode = 'legacy' | '2x2sub+2x2box' | '4x4sub+4x1';

/** Parse vd_dithermode; anything but '2x2' falls back to '4x4'. */
export function parseDitherMode(s: string): DitherMode {
  return s === '2x2' ? '2x2' : '4x4';
}

/**
 * Parse vd_reconmode; 'legacy' stays an accepted alias for the
 * unconditional box (no subtraction). Unknown strings fall back to the
 * hardware-correct default '2x2sub+2x2box'.
 */
export function parseReconMode(s: string): ReconMode {
  if (s === 'legacy') return 'legacy';
  return s === '4x4sub+4x1' ? '4x4sub+4x1' : '2x2sub+2x2box';
}





/**
 * Quantise stored 1/z depth to `bits` bits (vd_zbits, default 16):
 * q = round(v * (2^bits - 1)) / (2^bits - 1). In-place, zero-alloc.
 * bits >= 24 is a no-op (Float32 mantissa); bits <= 0 is a no-op.
 *
 * COMPAT ONLY — DISPLAY/BANDING APPROXIMATION, NOT a depth-buffer emulation
 * (astra §2.5). This runs post-hoc on already-resolved depth and therefore
 * cannot affect visibility: no depth test consults its output. For TRUE
 * pre-test depth policy see quantiseDepthBeforeTest + depthTestLess below,
 * which quantise to 0..2^bits-1 BEFORE each depth test/write (with a defined
 * clear value, compare op and tie rule derived from the projection near/far
 * planes), against a future internal quantized plane.
 * Framebuffer.depth keeps its documented 1/z semantics (frozen contract —
 * this helper never changes its meaning, only its banding).
 */
export function quantiseDepth(depth: Float32Array, bits = 16): void {
  if (!(bits > 0) || bits >= 24) return;
  const scale = (1 << bits) - 1;
  const inv = 1 / scale;
  for (let i = 0; i < depth.length; i++) {
    depth[i] = Math.round(depth[i]! * scale) * inv;
  }
}

// --- Pre-test Z-buffer policy (true depth emulation) -------------------------

/**
 * Normalized-depth clear value: the far plane (1.0) clears the quantized
 * plane to all-ones (0xFFFF at 16 bits). New geometry must be strictly
 * nearer to win (see depthTestLess).
 */
export const DEPTH_CLEAR_01 = 1.0;

/**
 * Quantise NORMALIZED depth to an integer depth-buffer value BEFORE the depth
 * test/write (guide §4 "Alpha, depth, fog and HUD"). depth01 is derived from
 * the SAME projection near/far planes used for clipping (0 = near, 1 = far),
 * clamped into range; bits is the vd_zbits profile (16 on hardware).
 * Returns round(depth01 * (2^bits - 1)) in [0, 2^bits - 1] (0..65535 at 16).
 * Pure (no allocation, no in-place mutation) — the rasterizer keeps a separate
 * internal quantized plane; Framebuffer.depth's 1/z semantics are untouched.
 * Throws on non-finite depth or non-integer bits outside 1..24.
 */
export function quantiseDepthBeforeTest(depth01: number, bits = 16): number {
  if (!Number.isFinite(depth01)) {
    throw new Error(`[voodoo] quantiseDepthBeforeTest: depth must be finite, got ${depth01}`);
  }
  if (!Number.isInteger(bits) || bits < 1 || bits > 24) {
    throw new Error(`[voodoo] quantiseDepthBeforeTest: bits must be an int 1..24, got ${bits}`);
  }
  const clamped = depth01 < 0 ? 0 : depth01 > 1 ? 1 : depth01;
  return Math.round(clamped * ((1 << bits) - 1));
}

/**
 * Z-buffer compare: LESS wins, ties keep the stored value.
 *
 * A new fragment writes iff quantNew < quantStored; coplanar/equal depths
 * keep the FIRST writer (stable, no z-fighting churn — coplanar surfaces
 * resolve deterministically in draw order). The plane clears to the quantized
 * DEPTH_CLEAR_01 (far), so any fragment nearer than far passes on a fresh
 * buffer. Pure.
 */
export function depthTestLess(quantNew: number, quantStored: number): boolean {
  return quantNew < quantStored;
}

// --- Internal quantized depth plane (true pre-test depthbuffer) --------------
//
// Z vs W MAPPING CONTRACT (guide §4 "Alpha, depth, fog and HUD").
//
// These helpers implement a Z-buffer: depth01 is NORMALIZED window depth,
// 0 = near plane, 1 = far plane, derived from the SAME projection near/far
// planes used for clipping. The future Voodoo rasterizer MUST derive depth01
// from clip space per fragment; with the engine's stored reciprocal depth
// invZ = 1/z (positive forward distance, i.e. Framebuffer.depth semantics):
//
//   depth01 = far/(far-near) - (far*near/(far-near)) * invZ
//
// (0 at invZ = 1/near, 1 at invZ = 1/far; clamp outside [near, far] —
// clipped geometry never produces it). Quantizing raw 1/z WITHOUT this
// near/far mapping is NOT either hardware operation: it is neither window-Z
// nor 1/W. W-BUFFER NOT IMPLEMENTED: a true W-buffer would instead quantize
// 1/W with the Voodoo3 hardware encoding (nonlinear, card-specific); that
// encoding is NOT implemented here — these helpers are Z-operation only,
// labeled accordingly.
//
// NEAR/FAR DERIVATION CONTRACT for the rasterizer: near/far come from the
// active projection setup (the same values feeding clipping); clear value is
// far (DEPTH_CLEAR_01 -> all-ones); compare is LESS; ties keep the stored
// value (first writer wins). Framebuffer.depth keeps its documented 1/z
// semantics untouched (frozen contract) — the quantized plane is a SEPARATE
// internal buffer owned by the Voodoo backend, never aliased to fb.depth.
//
//BITS: vd_zbits profile (16 = hardware); quantise to (1<<bits)-1.

/** Clear value for the quantized plane: all-ones (far) at any bit depth. */
export function depthClearValue(bits = 16): number {
  if (!Number.isInteger(bits) || bits < 1 || bits > 24) {
    throw new Error(`[voodoo] depthClearValue: bits must be an int 1..24, got ${bits}`);
  }
  return (1 << bits) - 1;
}

/**
 * Allocate the internal quantized depth plane, cleared to far (all-ones).
 * w/h must be positive ints. The rasterizer owns this buffer; it is never
 * Framebuffer.depth.
 */
export function createDepth16(w: number, h: number, bits = 16): Uint16Array {
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
    throw new Error(`[voodoo] createDepth16: w/h must be positive ints, got ${w}x${h}`);
  }
  return new Uint16Array(w * h).fill(depthClearValue(bits));
}

/** Clear the quantized plane to far (all-ones at `bits`). Zero-alloc. */
export function clearDepth16(plane: Uint16Array, bits = 16): void {
  plane.fill(depthClearValue(bits));
}

/**
 * Pre-test depth write: quantise depth01 (Z-operation, see contract above)
 * to `bits` BEFORE the test, compare LESS against the stored quantized
 * value, write on win. Ties keep the stored value (first writer wins —
 * coplanar geometry is stable, no churn). Returns true iff the fragment
 * passes (and was written). Throws on OOB pixels or non-finite depth
 * (rasterizer bugs fail loudly, never silently wrap).
 */
export function testAndWriteDepth16(
  plane: Uint16Array,
  w: number,
  h: number,
  x: number,
  y: number,
  depth01: number,
  bits = 16,
): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= w || y >= h) {
    throw new Error(`[voodoo] testAndWriteDepth16: pixel (${x},${y}) outside ${w}x${h}`);
  }
  const q = quantiseDepthBeforeTest(depth01, bits);
  const i = y * w + x;
  if (q < plane[i]!) {
    plane[i] = q;
    return true;
  }
  return false;
}

// --- Scanout reconstruction thresholds (vidProcCfg/rgbMaxDelta) --------------

/**
 * Per-component substitution thresholds for scanout reconstruction,
 * mirroring the rgbMaxDelta register (prog guide §6.5.2 vidProcCfg,
 * 6-bit fields: rmax bits 21:16, gmax 13:8, bmax 5:0): when a tap's
 * absolute deviation from the CENTRE exceeds the threshold in any channel,
 * that component is replaced with the centre's component before filtering.
 *
 * APPROXIMATION UNTIL HW CAPTURE: the Quake II MiniGL programming of this
 * register is not yet established from a hardware capture, so the default
 * below is a placeholder (smooth gradients pass, hard edges substitute);
 * the all-zero value disables the gate (unconditional box).
 */
export interface RgbMaxDelta {
  r: number;
  g: number;
  b: number;
}

/** Default reconstruction thresholds: smooth gradients pass, hard edges
 * reject. This IS the live default (see defaultVoodooState); the all-zero
 * value disables rejection (= unconditional box, e.g. under the 'legacy'
 * alias). Use parseRgbMaxDelta(getCVarString('vd_rgbmaxdelta')) for the
 * frame value. */
export function defaultRgbMaxDelta(): RgbMaxDelta {
  return { r: 8, g: 8, b: 8 };
}

/**
 * Parse vd_rgbmaxdelta ('r,g,b', each 0..63 clamped; unparseable or missing
 * components fall back to 0). Hardware fields are 6-bit (PG §6.5.2
 * rgbMaxDelta bits 21:16/13:8/5:0: rmax 21:16, gmax 13:8, bmax 5:0), so
 * values >63 clamp to 63. '0,0,0' disables rejection:
 * substitute/reconstruct helpers return the unconditional box, i.e. an
 * unconditional average. The live voodoo default is {8,8,8} (see
 * defaultRgbMaxDelta); the parse fallback stays per-component 0 so an
 * explicitly cleared cvar ('0,0,0' as registered in @q2/config) keeps
 * parsing to itself.
 */
export function parseRgbMaxDelta(s: string): RgbMaxDelta {
  const parts = s.split(',');
  const nums: number[] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = Number((parts[i] ?? '').trim());
    nums[i] = !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 63 ? 63 : Math.round(v);
  }
  return { r: nums[0]!, g: nums[1]!, b: nums[2]! };
}

/**
 * Edge-rejection gate for scanout reconstruction (vidProcCfg/rgbMaxDelta,
 * PG §6.5.2 / SP §11.1.2).
 *
 * Hardware rule: on a threshold breach *"the particular component will be
 * replaced with that corresponding component of the center pixel before the
 * pixel is used in the filter"* — per-component substitute-with-centre,
 * then filter. The metric is per-tap absolute deviation from the CENTRE,
 * not block max−min spread. Centre is p00 for the 2x2 window (the output
 * pixel, matching GLSL recon2x2) and p1 for the 4x1 row (matching GLSL
 * recon4x1's centred [x-1,x+2] window).
 *
 * These boolean helpers report whether substitution would occur (true =
 * every tap within thresholds, i.e. the box averages raw taps). The actual
 * substitute-then-filter output is computed by substituteTap /
 * reconstructFiltered2x2 / reconstructFilteredRow below, which the GLSL
 * mirror implements per-component. Pure, zero-alloc.
 *
 * ALL-ZERO DISABLES THE GATE: maxDelta {0,0,0} returns true
 * unconditionally — an unconditional box (e.g. under the 'legacy' alias).
 * Nonzero thresholds check per tap per channel; a channel threshold of 0
 * while others are nonzero still substitutes on any deviation > 0 for that
 * channel, so enable the gate with all three components (e.g. the {8,8,8}
 * comparison profile). Threshold programming is a DETERMINISTIC
 * APPROXIMATION until HW capture.
 */
export function passesReconstructionThreshold(
  p00: number,
  p10: number,
  p01: number,
  p11: number,
  maxDelta: RgbMaxDelta,
): boolean {
  if (maxDelta.r === 0 && maxDelta.g === 0 && maxDelta.b === 0) return true;
  const cr = p00 & 255;
  const cg = (p00 >> 8) & 255;
  const cb = (p00 >> 16) & 255;
  const others = [p10, p01, p11];
  for (const p of others) {
    if (Math.abs((p & 255) - cr) > maxDelta.r) return false;
    if (Math.abs(((p >> 8) & 255) - cg) > maxDelta.g) return false;
    if (Math.abs(((p >> 16) & 255) - cb) > maxDelta.b) return false;
  }
  return true;
}

/**
 * Row variant of the edge-rejection gate for the 4x1 filter: same
 * per-component substitute rule, centre is p1 (the output pixel of the
 * centred [x-1,x+2] window). All-zero disables. Pure, zero-alloc.
 */
export function passesReconstructionThresholdRow(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  maxDelta: RgbMaxDelta,
): boolean {
  if (maxDelta.r === 0 && maxDelta.g === 0 && maxDelta.b === 0) return true;
  const cr = p1 & 255;
  const cg = (p1 >> 8) & 255;
  const cb = (p1 >> 16) & 255;
  const others = [p0, p2, p3];
  for (const p of others) {
    if (Math.abs((p & 255) - cr) > maxDelta.r) return false;
    if (Math.abs(((p >> 8) & 255) - cg) > maxDelta.g) return false;
    if (Math.abs(((p >> 16) & 255) - cb) > maxDelta.b) return false;
  }
  return true;
}

/** Extract R channel from packed 0xFFBBGGRR. */
function chanR(p: number): number {
  return p & 255;
}
/** Extract G channel from packed 0xFFBBGGRR. */
function chanG(p: number): number {
  return (p >> 8) & 255;
}
/** Extract B channel from packed 0xFFBBGGRR. */
function chanB(p: number): number {
  return (p >> 16) & 255;
}

/** Pack R/G/B channels into 0xFFBBGGRR (alpha always opaque). */
function packRGB(r: number, g: number, b: number): number {
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Per-component substitute of one tap against the centre (PG §6.5.2):
 * each channel whose absolute deviation from the centre exceeds the
 * matching maxDelta component is replaced with the centre's component;
 * channels within threshold keep the tap's value. All-zero maxDelta
 * disables substitution (returns the tap unchanged — the caller averages
 * raw taps into the unconditional box). Pure.
 */
export function substituteTap(tap: number, centre: number, maxDelta: RgbMaxDelta): number {
  if (maxDelta.r === 0 && maxDelta.g === 0 && maxDelta.b === 0) return tap;
  const tr = chanR(tap);
  const tg = chanG(tap);
  const tb = chanB(tap);
  const cr = chanR(centre);
  const cg = chanG(centre);
  const cb = chanB(centre);
  const r = Math.abs(tr - cr) > maxDelta.r ? cr : tr;
  const g = Math.abs(tg - cg) > maxDelta.g ? cg : tg;
  const b = Math.abs(tb - cb) > maxDelta.b ? cb : tb;
  return packRGB(r, g, b);
}

/**
 * Substitute-then-filter for the 2x2 window (centre p00): substitute p10,
 * p01, p11 against p00 per-component, then box-average with the shader's
 * floor((sum+2)/4) rule. All-zero maxDelta averages raw taps
 * (unconditional box). Pure.
 */
export function reconstructFiltered2x2(
  p00: number,
  p10: number,
  p01: number,
  p11: number,
  maxDelta: RgbMaxDelta,
): number {
  const a = p00;
  const b = substituteTap(p10, p00, maxDelta);
  const c = substituteTap(p01, p00, maxDelta);
  const d = substituteTap(p11, p00, maxDelta);
  const r = ((chanR(a) + chanR(b) + chanR(c) + chanR(d) + 2) / 4) | 0;
  const g = ((chanG(a) + chanG(b) + chanG(c) + chanG(d) + 2) / 4) | 0;
  const bl = ((chanB(a) + chanB(b) + chanB(c) + chanB(d) + 2) / 4) | 0;
  return packRGB(r, g, bl);
}

/**
 * Substitute-then-filter for the centred 4x1 row (centre p1): substitute
 * p0, p2, p3 against p1 per-component, then box-average with
 * floor((sum+2)/4). All-zero maxDelta averages raw taps. Pure.
 */
export function reconstructFilteredRow(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  maxDelta: RgbMaxDelta,
): number {
  const a = substituteTap(p0, p1, maxDelta);
  const b = p1;
  const c = substituteTap(p2, p1, maxDelta);
  const d = substituteTap(p3, p1, maxDelta);
  const r = ((chanR(a) + chanR(b) + chanR(c) + chanR(d) + 2) / 4) | 0;
  const g = ((chanG(a) + chanG(b) + chanG(c) + chanG(d) + 2) / 4) | 0;
  const bl = ((chanB(a) + chanB(b) + chanB(c) + chanB(d) + 2) / 4) | 0;
  return packRGB(r, g, bl);
}
