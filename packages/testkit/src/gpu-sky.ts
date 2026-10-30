// @q2/testkit — GPU-FOLLOW-3A sky helpers (DOM-free, Node-safe, browser-safe).
//
// Validates the production sky-replay contract WITHOUT touching apps/web or
// @q2/webgl-renderer internals: every check runs over PUBLIC data (retained
// strip texels, backend test hooks, stub-GL draw logs). Violations are pure
// string lists (empty = clean); tests fail loudly on any entry.

/** Minimal retained-sky shape (mirrors apps/web `RetainedSky` by value). */
export interface SkyStripView {
  texels: Uint8Array;
  tileW: number;
  tileH: number;
}

/** Minimal backend sky surface (mirrors `testSkyStrip` by value). */
export interface SkyBackendView {
  testSkyStrip(): { tileW: number; tileH: number } | null;
  testWarnings(): string[];
}

/**
 * Validate one face tile of a retained strip: it must be non-degenerate
 * (more than a flat fill), with a bounded uniform fraction so an arbitrary
 * naturally-uniform patch can never pass as "textured".
 */
export function skyTileViolations(
  strip: SkyStripView,
  faceIndex: number,
  opts: { minDistinct?: number; maxUniformFraction?: number } = {},
): string[] {
  const out: string[] = [];
  const minDistinct = opts.minDistinct ?? 16;
  const maxUniform = opts.maxUniformFraction ?? 0.95;
  if (strip.tileW <= 0 || strip.tileH <= 0) {
    out.push(`face ${faceIndex}: non-positive tile ${strip.tileW}x${strip.tileH}`);
    return out;
  }
  if (strip.texels.length !== strip.tileW * strip.tileH * 6) {
    out.push(
      `face ${faceIndex}: texel length ${strip.texels.length} != ${strip.tileW}x${strip.tileH}x6`,
    );
    return out;
  }
  if (faceIndex < 0 || faceIndex > 5) {
    out.push(`face ${faceIndex}: out of range (0..5)`);
    return out;
  }
  const w = strip.tileW;
  const h = strip.tileH;
  const off = faceIndex * w * h;
  const tile = strip.texels.subarray(off, off + w * h);
  const counts = new Map<number, number>();
  for (let i = 0; i < tile.length; i++) {
    const v = tile[i]!;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (counts.size < minDistinct) {
    out.push(`face ${faceIndex}: only ${counts.size} distinct indices (< ${minDistinct}; flat?)`);
  }
  let top = 0;
  for (const c of counts.values()) if (c > top) top = c;
  if (top / tile.length > maxUniform) {
    out.push(`face ${faceIndex}: uniform fraction ${(top / tile.length).toFixed(3)} > ${maxUniform}`);
  }
  return out;
}

/**
 * Validate the full six-face strip: dims, length, every face non-flat.
 * Face 0 (`rt`) is the negative-control anchor: real `unit1_rt` carries ~100
 * distinct indices, so a deliberately omitted registration fails here even
 * when the page stays nonblack/colorful. Other faces (notably `dn`) are
 * naturally sparse in id art, so they only need to be non-flat (>= 2
 * distinct) — an arbitrary uniform patch can never pass the `rt` anchor.
 */
export function skyStripViolations(strip: SkyStripView): string[] {
  const out: string[] = [];
  if (strip.tileW <= 0 || strip.tileH <= 0) {
    out.push(`strip dims ${strip.tileW}x${strip.tileH} invalid`);
    return out;
  }
  if (strip.texels.length !== strip.tileW * strip.tileH * 6) {
    out.push(`strip length ${strip.texels.length} != ${strip.tileW}x${strip.tileH}x6`);
    return out;
  }
  out.push(...skyTileViolations(strip, 0, { minDistinct: 16 }));
  for (let f = 1; f < 6; f++) out.push(...skyTileViolations(strip, f, { minDistinct: 2 }));
  return out;
}

/**
 * Validate that a backend carries the retained strip (production replay
 * happened): dims must match, no `registerSkyStrip` rejection warnings.
 * A backend with no strip (flat fallback) ALWAYS violates — even when its
 * page is nonblack/colorful — which is the negative-control contract.
 */
export function skyBackendViolations(backend: SkyBackendView, expected: SkyStripView): string[] {
  const out: string[] = [];
  const got = backend.testSkyStrip();
  if (!got) {
    out.push('backend has no sky strip (flat fallback; replay omitted?)');
    return out;
  }
  if (got.tileW !== expected.tileW || got.tileH !== expected.tileH) {
    out.push(`backend sky dims ${got.tileW}x${got.tileH} != retained ${expected.tileW}x${expected.tileH} (total-height bug?)`);
  }
  for (const w of backend.testWarnings()) {
    if (w.includes('registerSkyStrip') || w.includes('sky strip')) out.push(`backend sky warning: ${w}`);
  }
  return out;
}

/**
 * Validate stub-GL draw evidence for a sky-facing view (FOLLOW-3A repair):
 * the textured path draws SIX per-face 6-index boxes (one draw per face,
 * each with its own face texture) with `uTextured 1`; the flat fallback
 * (no strip) must NOT draw textured boxes. `calls` is the stub-GL call log
 * (e.g. `drawElements TRIANGLES 6 @0`, `uniform1i uTextured 1`).
 *
 * History: the old single-strip path drew one 36-index box; per-face
 * isolation (the border repair) draws six 6-index faces instead. A lone
 * 36-index draw is now a violation on the textured leg (stale path).
 */
export function skyDrawViolations(calls: string[], expectTextured: boolean): string[] {
  const out: string[] = [];
  const faceDraws = calls.filter((c) => c === 'drawElements TRIANGLES 6 @0').length;
  const boxDraws = calls.filter((c) => c === 'drawElements TRIANGLES 36 @0').length;
  const hasTextured = calls.includes('uniform1i uTextured 1');
  if (expectTextured) {
    if (boxDraws > 0) out.push('stale single-strip skybox draw (drawElements TRIANGLES 36 @0; want six per-face 6-index draws)');
    if (faceDraws < 6) out.push(`missing per-face textured skybox draws (want 6x drawElements TRIANGLES 6 @0, got ${faceDraws})`);
    if (!hasTextured) out.push('missing textured skybox sampler (uniform1i uTextured 1)');
    if (calls.filter((c) => c.startsWith('drawElements')).length === 0) {
      out.push('no draws at all (page would be black/clear-only)');
    }
  } else if (faceDraws > 0 && hasTextured) {
    // A flat hull range can coincidentally be 6 indices at offset 0, so a
    // bare 6-index draw is not proof of texturing — only a 6-index draw
    // with the textured sampler set is.
    out.push('unexpected textured skybox draw on the flat-fallback leg');
  } else if (boxDraws > 0) {
    out.push('unexpected stale strip skybox draw on the flat-fallback leg');
  }
  return out;
}
