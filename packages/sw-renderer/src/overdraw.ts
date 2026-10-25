// @q2/sw-renderer overdraw attribution — M3.3 option (b).
//
// The 1.15x overdraw budget assumed span-level occlusion, which ref_soft never
// had: it relies on PVS + frustum + backface culling for bucketing and on the
// z-buffer for everything in-frustum-but-occluded. This module gives the
// accounting that proves the residual overdraw is exactly that C-faithful
// hidden-surface work, not bucketing waste.
//
// Key pipeline facts the accounting rests on (see frame.ts / worldNodes.ts):
// - renderView draws per-surface span batches in BSP front-to-back order, and
//   each batch is row-sorted near-first, under a strict `>` depth test. So a
//   framebuffer pixel is written AT MOST ONCE per frame: the first (nearest)
//   span wins, every later span pixel at that location fails the test.
// - candidate span pixels are only ever emitted for surfaces that passed PVS,
//   the surface-bbox frustum test, the backface test, and near/viewport clip.
// Hence: candidatePixels = writtenPixels + zRejectedPixels, where the
// z-rejected part is in-frustum occluded span fill by construction, and every
// surface the PVS admits but never emits is named by a cull counter below.

/** Per-frame overdraw accounting. All counts, no floats except the ratios. */
export interface OverdrawDetail {
  /** total world surfaces (incl. degenerate NODRAW placeholders) */
  surfaces: number;
  /** admitted by the PVS ancestor-mark walk (R_MarkLeaves equivalent) */
  pvsVisible: number;
  /** of pvsVisible: degenerate (n < 3, NODRAW placeholders, never drawn) */
  degenerate: number;
  /** of pvsVisible: dropped by the surface-bbox frustum test */
  frustumCulled: number;
  /** of pvsVisible: dropped by the backface test (turbulent stays double-sided) */
  backfaceCulled: number;
  /** of pvsVisible: projected/clipped to <3 verts or zero spans */
  clipRejected: number;
  /** of pvsVisible: produced >= 1 span (degenerate+frustum+backface+clip+emitted === pvsVisible) */
  emitted: number;
  /** largest single-surface span batch (must stay < MAX_SPANS: no silent drops) */
  maxBatchSpans: number;
  /** emitted span pixels after viewport clip (the overdraw numerator) */
  candidatePixels: number;
  /** framebuffer pixels the z-buffer accepted (each written at most once) */
  writtenPixels: number;
  /** candidatePixels - writtenPixels: in-frustum occluded span pixels */
  zRejectedPixels: number;
  /** framebuffer area (W*H) */
  area: number;
  /** candidatePixels / area (FrameStats.overdraw) */
  overdraw: number;
  /** writtenPixels / area (true screen coverage, <= 1 when world-only) */
  visibleCoverage: number;
  /** zRejectedPixels / candidatePixels (share of span fill spent on hidden surfaces) */
  occludedShare: number;
}

/** Zeroed accounting block. Diagnostic path only; never in the hot loop. */
export function createOverdrawDetail(): OverdrawDetail {
  return {
    surfaces: 0, pvsVisible: 0, degenerate: 0,
    frustumCulled: 0, backfaceCulled: 0, clipRejected: 0,
    emitted: 0, maxBatchSpans: 0,
    candidatePixels: 0, writtenPixels: 0, zRejectedPixels: 0,
    area: 0, overdraw: 0, visibleCoverage: 0, occludedShare: 0,
  };
}

/**
 * Count depth-written pixels: zb[o] > 0 means a span won the strict `>`
 * test there (planes are zero-cleared in beginFrame). Exact for world-only
 * frames (no entities / alias / sprites / particles, which also write zb).
 */
export function countWrittenZb(zb: Float32Array, n: number): number {
  const end = n < zb.length ? n : zb.length;
  let written = 0;
  for (let o = 0; o < end; o++) {
    if (zb[o]! > 0) written++;
  }
  return written;
}

/** One-line ledger rendering for bench/test logs. Pure formatting. */
export function formatOverdrawLine(label: string, d: OverdrawDetail): string {
  return (
    `overdraw ${label}: surf=${d.surfaces} pvs=${d.pvsVisible} ` +
    `emit=${d.emitted} cull(frustum/backface/clip/degenerate)=` +
    `${d.frustumCulled}/${d.backfaceCulled}/${d.clipRejected}/${d.degenerate} ` +
    `candidate=${d.candidatePixels} written=${d.writtenPixels} ` +
    `zrejected=${d.zRejectedPixels} (occluded ${(100 * d.occludedShare).toFixed(1)}%) ` +
    `coverage=${d.visibleCoverage.toFixed(3)} overdraw=${d.overdraw.toFixed(3)}`
  );
}
