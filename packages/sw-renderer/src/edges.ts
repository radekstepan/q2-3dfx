// @q2/sw-renderer edges — r_edge.c equivalent: edge list, R_ScanEdges
// span emission, z-sorted spans. BSP-order coplanar handling.
//
// Pipeline per surface polygon: near-clip in view space -> project ->
// scan-convert convex polygon into spans carrying (iz, uz, vz) gradients ->
// per-row z-sort (descending 1/z, stable in BSP front-to-back order) so
// coplanar faces resolve by traversal order with the strict `>` depth test.

import type { Camera } from './camera.js';
import { SPAN_OPAQUE, F_PER_SPAN, I_PER_SPAN, createSpan, type Span } from './spans.js';

export interface ProjectedVert {
  x: number; y: number;
  iz: number; uz: number; vz: number;
  lu: number; lv: number;
}

/** Preallocated scratch for the edge emitter: zero allocation per frame. */
export interface EdgeScratch {
  view: Float32Array;      // view-space xyz per vert (3*maxVerts)
  clipped: Float32Array;   // clipped view-space xyz (3*(maxVerts+8))
  attrA: Float32Array;     // u,v,lu,lv per vert (4*maxVerts)
  attrB: Float32Array;     // clipped attributes (4*(maxVerts+8))
  poly: ProjectedVert[];
}

export function createEdgeScratch(maxVerts = 64): EdgeScratch {
  const poly: ProjectedVert[] = [];
  for (let i = 0; i < maxVerts + 8; i++) {
    poly.push({ x: 0, y: 0, iz: 0, uz: 0, vz: 0, lu: 0, lv: 0 });
  }
  return {
    view: new Float32Array(maxVerts * 3),
    clipped: new Float32Array((maxVerts + 8) * 3),
    attrA: new Float32Array(maxVerts * 4),
    attrB: new Float32Array((maxVerts + 8) * 4),
    poly,
  };
}

export interface PolyInput {
  /** world-space xyz, n*3 */
  verts: Float32Array;
  /** texture texels u,v per vert, n*2 */
  uvs: Float32Array;
  /** luxel coords per vert, n*2 */
  lux: Float32Array;
  n: number;
}

/**
 * Transform to view space, Sutherland-Hodgman clip against the near plane,
 * then project. Returns projected vert count (0 = fully clipped).
 * Per-vertex (iz, uz, vz) vary linearly in screen space -> perspective correct.
 */
export function projectClippedPoly(
  input: PolyInput,
  cam: Camera,
  width: number,
  height: number,
  scratch: EdgeScratch,
): number {
  const { verts, uvs, lux, n } = input;
  const ox = cam.origin[0]!, oy = cam.origin[1]!, oz = cam.origin[2]!;
  const f = cam.forward, r = cam.right, u = cam.up;
  // to view space (vx = right, vy = up, vz = forward depth)
  // PERF-FINISH-A item D: track the all-inside case (every vert in front
  // of the near plane) while transforming — the common case for world
  // polys. The Sutherland-Hodgman clip below is an exact copy for
  // all-inside polys (kept verts move with no arithmetic), so skipping it
  // and projecting straight from the view + attribute scratch is
  // bit-identical while saving a full copy/interp pass.
  let allIn = true;
  for (let i = 0; i < n; i++) {
    const px = verts[i * 3]! - ox, py = verts[i * 3 + 1]! - oy, pz = verts[i * 3 + 2]! - oz;
    const vx = px * r[0]! + py * r[1]! + pz * r[2]!;
    const vy = px * u[0]! + py * u[1]! + pz * u[2]!;
    const vz = px * f[0]! + py * f[1]! + pz * f[2]!;
    scratch.view[i * 3] = vx;
    scratch.view[i * 3 + 1] = vy;
    scratch.view[i * 3 + 2] = vz;
    if (vz < cam.near) allIn = false;
  }
  // near clip: keep vz >= near (Sutherland-Hodgman on view-space polygon,
  // interpolating uvs/lux linearly along cut edges)
  const near = cam.near;
  for (let i = 0; i < n; i++) {
    scratch.attrA[i * 4] = uvs[i * 2]!;
    scratch.attrA[i * 4 + 1] = uvs[i * 2 + 1]!;
    scratch.attrA[i * 4 + 2] = lux[i * 2]!;
    scratch.attrA[i * 4 + 3] = lux[i * 2 + 1]!;
  }
  if (allIn) {
    return projectViewScratch(
      scratch.view, scratch.attrA, n, cam, width, height, scratch.poly,
    );
  }
  const count = clipNearPlane(
    scratch.view, scratch.attrA, n, near, scratch.clipped, scratch.attrB,
  );
  if (count < 3) return 0;
  return projectViewScratch(
    scratch.clipped, scratch.attrB, count, cam, width, height, scratch.poly,
  );
}

/**
 * Project view-space positions + attributes to screen space (the shared
 * tail of projectClippedPoly): 1/z perspective divide, viewport reject.
 * Pure function of its inputs — the all-inside fast path and the clipped
 * path converge here with identical arithmetic, so output is identical.
 */
function projectViewScratch(
  pos: Float32Array, attr: Float32Array, count: number,
  cam: Camera, width: number, height: number,
  inv: ProjectedVert[],
): number {
  // project
  let out = 0;
  for (let i = 0; i < count; i++) {
    const vx = pos[i * 3]!, vy = pos[i * 3 + 1]!, vz = pos[i * 3 + 2]!;
    if (vz < cam.near * 0.5) return 0; // safety: should not happen post-clip
    const iz = 1 / vz;
    const uu = attr[i * 4]!, vv = attr[i * 4 + 1]!;
    const p = inv[out++]!;
    p.x = cam.xCenter + (vx * cam.focalX) * iz;
    p.y = cam.yCenter - (vy * cam.focalY) * iz;
    p.iz = iz;
    p.uz = uu * iz;
    p.vz = vv * iz;
    p.lu = attr[i * 4 + 2]!;
    p.lv = attr[i * 4 + 3]!;
  }
  // viewport reject: all verts off one side
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < out; i++) {
    const p = inv[i]!;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (maxX < 0 || minX >= width || maxY < 0 || minY >= height) return 0;
  return out;
}

function clipNearPlane(
  pos: Float32Array, inAttr: Float32Array, count: number, near: number,
  out: Float32Array, outAttr: Float32Array,
): number {
  let prev = count - 1;
  let prevIn = pos[prev * 3 + 2]! >= near;
  let outCount = 0;
  for (let cur = 0; cur < count; cur++) {
    const curIn = pos[cur * 3 + 2]! >= near;
    if (curIn !== prevIn) {
      // emit intersection on edge prev->cur
      const az = pos[prev * 3 + 2]!, bz = pos[cur * 3 + 2]!;
      const t = (near - az) / (bz - az);
      out[outCount * 3] = pos[prev * 3]! + (pos[cur * 3]! - pos[prev * 3]!) * t;
      out[outCount * 3 + 1] = pos[prev * 3 + 1]! + (pos[cur * 3 + 1]! - pos[prev * 3 + 1]!) * t;
      out[outCount * 3 + 2] = near;
      for (let k = 0; k < 4; k++) {
        outAttr[outCount * 4 + k] = inAttr[prev * 4 + k]! + (inAttr[cur * 4 + k]! - inAttr[prev * 4 + k]!) * t;
      }
      outCount++;
    }
    if (curIn) {
      out[outCount * 3] = pos[cur * 3]!;
      out[outCount * 3 + 1] = pos[cur * 3 + 1]!;
      out[outCount * 3 + 2] = pos[cur * 3 + 2]!;
      for (let k = 0; k < 4; k++) outAttr[outCount * 4 + k] = inAttr[cur * 4 + k]!;
      outCount++;
    }
    prev = cur;
    prevIn = curIn;
  }
  return outCount;
}

/**
 * Optional flat-span output for frame-level accumulation (M8.1): when
 * present, every emitted span is ALSO packed into the flat (F64/I32)
 * staging arrays at [base, base+cap) with the batch's kind/ord (objects
 * are tagged identically, so the post-emit tagging loop can be skipped).
 * `lightOverride` replaces s.light in the flat copy (flat sky fills ride
 * the palette color, set after emission for the object path). `written`
 * is an in-out count of flat spans actually stored (cap guard); the caller
 * falls back to the object path when it disagrees with the object count.
 */
export interface EmitFlat {
  F: Float64Array;
  I: Int32Array;
  base: number;
  cap: number;
  kind: number;
  ord: number;
  /** Null = keep the emitted value; set = the batch's post-tagging value. */
  light: number | null;
  dlight: number | null;
  lv: number | null;
  written: number;
}

/**
 * Scan-convert a convex projected polygon into spans appended to `pool`
 * starting at poolCount. Returns the new pool count. Caller clamps pool
 * growth (drops overflow spans, counted in stats).
 */
export function emitSpansForPoly(
  poly: ProjectedVert[],
  count: number,
  surfOrder: number,
  pool: Span[],
  poolCount: number,
  maxSpans: number,
  light: number,
  dlight: number,
  clipH: number,
  flat?: EmitFlat,
): number {
  void surfOrder;
  if (count < 3) {
    if (flat) flat.written = 0;
    return poolCount;
  }
  const fw = flat;
  let fcount = 0;
  // find y range
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const y = poly[i]!.y;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const y0 = Math.max(0, Math.ceil(minY - 0.5));
  const y1 = Math.min(clipH - 1, Math.floor(maxY - 0.5));
  // Vertical texture gradients for the Voodoo LOD footprint (rho): a
  // least-squares plane fit of (u, v) over screen (x, y), computed once
  // per polygon (not per span/row). Solves the 2x2 normal equations for
  // [du/dx, du/dy] and [dv/dx, dv/dy]; only the vertical pair is stored
  // (the horizontal pair is re-derived per span from the
  // iz/uz/vz steps, bit-identical to the fit). Degenerate (collinear)
  // polys fall back to 0 (no vertical contribution — same rho as the old
  // horizontal-only footprint). Zero allocation: pure scalar arithmetic.
  let dudyP = 0, dvdyP = 0;
  {
    let mx = 0, my = 0, mu = 0, mv = 0;
    for (let i = 0; i < count; i++) {
      const p = poly[i]!;
      mx += p.x; my += p.y;
      const iu = p.iz !== 0 ? 1 / p.iz : 0;
      mu += p.uz * iu; mv += p.vz * iu;
    }
    const inv = 1 / count;
    mx *= inv; my *= inv; mu *= inv; mv *= inv;
    let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
    for (let i = 0; i < count; i++) {
      const p = poly[i]!;
      const dx = p.x - mx, dy = p.y - my;
      const iu = p.iz !== 0 ? 1 / p.iz : 0;
      const du = p.uz * iu - mu, dv = p.vz * iu - mv;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
      sxu += dx * du; syu += dy * du;
      sxv += dx * dv; syv += dy * dv;
    }
    const det = sxx * syy - sxy * sxy;
    const adet = det < 0 ? -det : det;
    if (det !== 0 && det === det && adet > 1e-12) {
      dudyP = (sxx * syu - sxy * sxu) / det;
      dvdyP = (sxx * syv - sxy * sxv) / det;
    }
  }
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    let xl = Infinity, xr = -Infinity;
    let lz = 0, rz = 0, luz = 0, ruz = 0, lvz = 0, rvz = 0, llu = 0, rlu = 0, llv = 0, rlv = 0;
    for (let i = 0; i < count; i++) {
      const p0 = poly[i]!;
      const p1 = poly[(i + 1) % count]!;
      const yA = p0.y, yB = p1.y;
      if ((yA <= yc && yB > yc) || (yB <= yc && yA > yc)) {
        const t = (yc - yA) / (yB - yA);
        const x = p0.x + (p1.x - p0.x) * t;
        const iz = p0.iz + (p1.iz - p0.iz) * t;
        const uz = p0.uz + (p1.uz - p0.uz) * t;
        const vz = p0.vz + (p1.vz - p0.vz) * t;
        const lu = p0.lu + (p1.lu - p0.lu) * t;
        const lv = p0.lv + (p1.lv - p0.lv) * t;
        if (x < xl) { xl = x; lz = iz; luz = uz; lvz = vz; llu = lu; llv = lv; }
        if (x > xr) { xr = x; rz = iz; ruz = uz; rvz = vz; rlu = lu; rlv = lv; }
      }
    }
    if (!(xr > xl)) continue;
    const xa = Math.ceil(xl - 0.5), xb = Math.floor(xr - 0.5);
    if (xb < xa) continue;
    if (poolCount >= maxSpans) {
      if (fw) fw.written = fcount;
      return poolCount;
    }
    while (pool.length <= poolCount) pool.push(createSpan());
    const s = pool[poolCount++]!;
    const dx = xr - xl || 1;
    s.kind = fw ? fw.kind : SPAN_OPAQUE;
    s.y = y;
    s.x0 = xa;
    s.x1 = xb + 1;
    s.iz = lz;
    s.diz = (rz - lz) / dx;
    s.uz = luz;
    s.duz = (ruz - luz) / dx;
    s.vz = lvz;
    s.dvz = (rvz - lvz) / dx;
    s.light = light;
    s.dlight = dlight;
    s.lu = llu;
    s.lv = llv;
    s.dlu = (rlu - llu) / dx;
    s.dudy = dudyP;
    s.dvdy = dvdyP;
    s.turb = 0;
    if (fw) {
      // Batch tagging, fused: the caller passes the post-emit tag values
      // (kind/ord/light for sky fills), so objects AND the flat copy carry
      // the final state and the post-emit tagging loop can be skipped.
      s.kind = fw.kind;
      s.ord = fw.ord;
      if (fw.light !== null) s.light = fw.light;
      if (fw.dlight !== null) s.dlight = fw.dlight;
      if (fw.lv !== null) s.lv = fw.lv;
    }
    // Fused flat pack (M8.1): same values the pack loop would copy, written
    // while the span fields are L1-hot. Emission order is strictly
    // increasing y with one span per row, which is exactly the order the
    // row z-sort establishes — so the flat copy matches a post-sort pack.
    if (fw && fcount < fw.cap) {
      const o = (fw.base + fcount) * F_PER_SPAN;
      fw.F[o] = s.iz; fw.F[o + 1] = s.diz; fw.F[o + 2] = s.uz;
      fw.F[o + 3] = s.duz; fw.F[o + 4] = s.vz; fw.F[o + 5] = s.dvz;
      fw.F[o + 6] = s.light;
      fw.F[o + 7] = s.dlight; fw.F[o + 8] = s.lu; fw.F[o + 9] = s.lv;
      fw.F[o + 10] = s.dlu; fw.F[o + 11] = s.dudy; fw.F[o + 12] = s.dvdy;
      const q = (fw.base + fcount) * I_PER_SPAN;
      fw.I[q] = s.kind; fw.I[q + 1] = s.y; fw.I[q + 2] = s.x0;
      fw.I[q + 3] = s.x1; fw.I[q + 4] = s.turb;
      fcount++;
    }
    void rlv;
  }
  if (fw) fw.written = fcount;
  return poolCount;
}

export interface RowSpan {
  span: Span;
  /** BSP front-to-back order (lower = nearer in traversal) */
  order: number;
}

/**
 * R_ScanEdges z-sort: per-row descending 1/z, stable in BSP order so that
 * coplanar faces resolve by traversal order under the strict `>` depth test.
 */
export function sortRowSpans(rows: RowSpan[]): RowSpan[] {
  rows.sort((a, b) => {
    if (b.span.iz !== a.span.iz) return b.span.iz - a.span.iz;
    return a.order - b.order;
  });
  return rows;
}
