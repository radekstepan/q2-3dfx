// @q2/bsp — trace.ts — pointLeaf + traceBox (qcommon/cmodel.c port).
//
// Faithful port of CM_PointLeafnum_r, CM_ClipBoxToBrush,
// CM_RecursiveHullCheck and CM_BoxTrace, operating on the flat BspMap
// arrays from ./bsp38.ts. Conventions match the C code exactly, including
// DIST_EPSILON = 1/32 and the enter/leave fraction bias.
import type { Bsp38 } from '@q2/formats';
import type { Vec3 } from '@q2/math';
import { BoxOnPlaneSide } from '@q2/math';
import { LEAF_STRIDE, NODE_STRIDE, BRUSH_STRIDE, BRUSHSIDE_STRIDE } from './bsp38.js';
import type { BspMap } from './bsp38.js';
import { asBspMap } from './pvs.js';

export const DIST_EPSILON = 0.03125;

/** Swept-box trace result. First five fields are the frozen §6 contract. */
export interface Trace {
  fraction: number;
  endpos: Vec3;
  planeNormal: Vec3;
  contents: number;
  entityNum: number;
  /** C trace_t extras (always populated). */
  startsolid: boolean;
  allsolid: boolean;
  planeDist: number;
}

function v3(x = 0, y = 0, z = 0): Vec3 {
  return new Float32Array([x, y, z]) as Vec3;
}

/** Leaf index containing point p, walking from headnode 0 (CM_PointLeafnum_r). */
export function pointLeaf(world: Bsp38, p: Vec3): number {
  const w = asBspMap(world);
  if (w.nodes.length === 0) return 0;
  let num = w.modelsExtra.length >= 3 ? w.modelsExtra[0]! : 0; // model 0 headnode
  for (;;) {
    if (num < 0) return -1 - num;
    const d = num * NODE_STRIDE;
    const plane = w.nodes[d]!;
    const nx = w.planes[plane * 4]!;
    const ny = w.planes[plane * 4 + 1]!;
    const nz = w.planes[plane * 4 + 2]!;
    const dist = w.planes[plane * 4 + 3]!;
    const type = w.planeTypes[plane]!;
    let dd: number;
    if (type < 3) dd = p[type]! - dist;
    else dd = nx * p[0]! + ny * p[1]! + nz * p[2]! - dist;
    num = dd < 0 ? w.nodes[d + 2]! : w.nodes[d + 1]!;
  }
}

// Per-world brush multi-check avoidance (C checkcount).
interface CheckState { marks: Int32Array; count: number }
const checkStates = new WeakMap<object, CheckState>();
function checkStateFor(w: BspMap): CheckState {
  let s = checkStates.get(w);
  const nBrushes = w.brushes.length / BRUSH_STRIDE;
  if (!s || s.marks.length !== nBrushes) {
    s = { marks: new Int32Array(nBrushes), count: 0 };
    checkStates.set(w, s);
  }
  s.count++;
  if (s.count === 0x7fffffff) {
    s.marks.fill(0);
    s.count = 1;
  }
  return s;
}

interface TraceCtx {
  w: BspMap;
  start: Vec3; end: Vec3; mins: Vec3; maxs: Vec3;
  extents: Vec3;
  contents: number;
  isPoint: boolean;
  fraction: number;
  planeNormal: Vec3;
  planeDist: number;
  brushContents: number;
  startsolid: boolean;
  allsolid: boolean;
  check: CheckState;
}

function clipBoxToBrush(ctx: TraceCtx, brushNum: number): void {
  const { w, mins, maxs, start: p1, end: p2 } = ctx;
  const b = brushNum * BRUSH_STRIDE;
  const first = w.brushes[b]!;
  const numsides = w.brushes[b + 1]!;
  const contents = w.brushes[b + 2]!;
  if (numsides === 0) return;

  let enterfrac = -1;
  let leavefrac = 1;
  let clipPlane = -1;
  let getout = false;
  let startout = false;

  for (let i = 0; i < numsides; i++) {
    const s = (first + i) * BRUSHSIDE_STRIDE;
    const plane = w.brushsides[s]!;
    const nx = w.planes[plane * 4]!;
    const ny = w.planes[plane * 4 + 1]!;
    const nz = w.planes[plane * 4 + 2]!;
    const pdist = w.planes[plane * 4 + 3]!;

    let dist: number;
    if (!ctx.isPoint) {
      const ox = nx < 0 ? maxs[0]! : mins[0]!;
      const oy = ny < 0 ? maxs[1]! : mins[1]!;
      const oz = nz < 0 ? maxs[2]! : mins[2]!;
      dist = pdist - (ox * nx + oy * ny + oz * nz);
    } else {
      dist = pdist;
    }

    const d1 = (p1[0]! * nx + p1[1]! * ny + p1[2]! * nz) - dist;
    const d2 = (p2[0]! * nx + p2[1]! * ny + p2[2]! * nz) - dist;

    if (d2 > 0) getout = true;
    if (d1 > 0) startout = true;
    if (d1 > 0 && d2 >= d1) return;
    if (d1 <= 0 && d2 <= 0) continue;

    if (d1 > d2) {
      const f = (d1 - DIST_EPSILON) / (d1 - d2);
      if (f > enterfrac) {
        enterfrac = f;
        clipPlane = plane;
      }
    } else {
      const f = (d1 + DIST_EPSILON) / (d1 - d2);
      if (f < leavefrac) leavefrac = f;
    }
  }

  if (!startout) {
    ctx.startsolid = true;
    if (!getout) ctx.allsolid = true;
    return;
  }
  if (enterfrac < leavefrac && enterfrac > -1 && enterfrac < ctx.fraction) {
    const f = enterfrac < 0 ? 0 : enterfrac;
    ctx.fraction = f;
    ctx.planeNormal = new Float32Array([
      w.planes[clipPlane * 4]!,
      w.planes[clipPlane * 4 + 1]!,
      w.planes[clipPlane * 4 + 2]!,
    ]) as Vec3;
    ctx.planeDist = w.planes[clipPlane * 4 + 3]!;
    ctx.brushContents = contents;
  }
}

function testBoxInBrush(ctx: TraceCtx, brushNum: number): void {
  const { w, mins, maxs, start: p1 } = ctx;
  const b = brushNum * BRUSH_STRIDE;
  const first = w.brushes[b]!;
  const numsides = w.brushes[b + 1]!;
  const contents = w.brushes[b + 2]!;
  if (numsides === 0) return;
  for (let i = 0; i < numsides; i++) {
    const s = (first + i) * BRUSHSIDE_STRIDE;
    const plane = w.brushsides[s]!;
    const nx = w.planes[plane * 4]!;
    const ny = w.planes[plane * 4 + 1]!;
    const nz = w.planes[plane * 4 + 2]!;
    const pdist = w.planes[plane * 4 + 3]!;
    const ox = nx < 0 ? maxs[0]! : mins[0]!;
    const oy = ny < 0 ? maxs[1]! : mins[1]!;
    const oz = nz < 0 ? maxs[2]! : mins[2]!;
    const dist = pdist - (ox * nx + oy * ny + oz * nz);
    if (p1[0]! * nx + p1[1]! * ny + p1[2]! * nz - dist > 0) return;
  }
  ctx.startsolid = true;
  ctx.allsolid = true;
  ctx.fraction = 0;
  ctx.brushContents = contents;
}

function traceToLeaf(ctx: TraceCtx, leafnum: number): void {
  const { w } = ctx;
  const d = leafnum * LEAF_STRIDE;
  if ((w.leafs[d]! & ctx.contents) === 0) return;
  const first = w.leafs[d + 11]!;
  const n = w.leafs[d + 12]!;
  for (let k = 0; k < n; k++) {
    const brushnum = w.leafbrushes[first + k]!;
    if (ctx.check.marks[brushnum] === ctx.check.count) continue;
    ctx.check.marks[brushnum] = ctx.check.count;
    if ((w.brushes[brushnum * BRUSH_STRIDE + 2]! & ctx.contents) === 0) continue;
    clipBoxToBrush(ctx, brushnum);
    if (ctx.fraction === 0) return;
  }
}

function testInLeaf(ctx: TraceCtx, leafnum: number): void {
  const { w } = ctx;
  const d = leafnum * LEAF_STRIDE;
  if ((w.leafs[d]! & ctx.contents) === 0) return;
  const first = w.leafs[d + 11]!;
  const n = w.leafs[d + 12]!;
  for (let k = 0; k < n; k++) {
    const brushnum = w.leafbrushes[first + k]!;
    if (ctx.check.marks[brushnum] === ctx.check.count) continue;
    ctx.check.marks[brushnum] = ctx.check.count;
    if ((w.brushes[brushnum * BRUSH_STRIDE + 2]! & ctx.contents) === 0) continue;
    testBoxInBrush(ctx, brushnum);
    if (ctx.fraction === 0) return;
  }
}

function recursiveHullCheck(ctx: TraceCtx, num: number, p1f: number, p2f: number, p1: Vec3, p2: Vec3): void {
  if (ctx.fraction <= p1f) return;
  const { w } = ctx;
  if (num < 0) {
    traceToLeaf(ctx, -1 - num);
    return;
  }
  const d = num * NODE_STRIDE;
  const plane = w.nodes[d]!;
  const nx = w.planes[plane * 4]!;
  const ny = w.planes[plane * 4 + 1]!;
  const nz = w.planes[plane * 4 + 2]!;
  const pdist = w.planes[plane * 4 + 3]!;
  const type = w.planeTypes[plane]!;

  let t1: number, t2: number, offset: number;
  if (type < 3) {
    const ax = type === 0 ? 0 : type === 1 ? 1 : 2;
    t1 = p1[ax]! - pdist;
    t2 = p2[ax]! - pdist;
    offset = ctx.extents[ax]!;
  } else {
    t1 = p1[0]! * nx + p1[1]! * ny + p1[2]! * nz - pdist;
    t2 = p2[0]! * nx + p2[1]! * ny + p2[2]! * nz - pdist;
    offset = ctx.isPoint
      ? 0
      : Math.abs(ctx.extents[0]! * nx) + Math.abs(ctx.extents[1]! * ny) + Math.abs(ctx.extents[2]! * nz);
  }

  if (t1 >= offset && t2 >= offset) {
    recursiveHullCheck(ctx, w.nodes[d + 1]!, p1f, p2f, p1, p2);
    return;
  }
  if (t1 < -offset && t2 < -offset) {
    recursiveHullCheck(ctx, w.nodes[d + 2]!, p1f, p2f, p1, p2);
    return;
  }

  let side: number, frac: number, frac2: number;
  if (t1 < t2) {
    const idist = 1 / (t1 - t2);
    side = 1;
    frac2 = (t1 + offset + DIST_EPSILON) * idist;
    frac = (t1 - offset + DIST_EPSILON) * idist;
  } else if (t1 > t2) {
    const idist = 1 / (t1 - t2);
    side = 0;
    frac2 = (t1 - offset - DIST_EPSILON) * idist;
    frac = (t1 + offset + DIST_EPSILON) * idist;
  } else {
    side = 0;
    frac = 1;
    frac2 = 0;
  }

  frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  let midf = p1f + (p2f - p1f) * frac;
  const mid = v3(
    p1[0]! + frac * (p2[0]! - p1[0]!),
    p1[1]! + frac * (p2[1]! - p1[1]!),
    p1[2]! + frac * (p2[2]! - p1[2]!),
  );
  recursiveHullCheck(ctx, side === 0 ? w.nodes[d + 1]! : w.nodes[d + 2]!, p1f, midf, p1, mid);

  frac2 = frac2 < 0 ? 0 : frac2 > 1 ? 1 : frac2;
  midf = p1f + (p2f - p1f) * frac2;
  mid[0] = p1[0]! + frac2 * (p2[0]! - p1[0]!);
  mid[1] = p1[1]! + frac2 * (p2[1]! - p1[1]!);
  mid[2] = p1[2]! + frac2 * (p2[2]! - p1[2]!);
  recursiveHullCheck(ctx, side === 0 ? w.nodes[d + 2]! : w.nodes[d + 1]!, midf, p2f, mid, p2);
}

// Fills leafs[] with every leaf touched by [mins,maxs]; returns count.
function boxLeafnums(w: BspMap, mins: Vec3, maxs: Vec3, headnode: number, out: number[]): number {
  const n = new Float32Array([mins[0], mins[1], mins[2]]);
  const x = new Float32Array([maxs[0], maxs[1], maxs[2]]);
  const walk = (nodenum: number): void => {
    let cur = nodenum;
    for (;;) {
      if (cur < 0) {
        if (out.length < 1024) out.push(-1 - cur);
        return;
      }
      const d = cur * NODE_STRIDE;
      const plane = w.nodes[d]!;
      const normal = new Float32Array([
        w.planes[plane * 4]!, w.planes[plane * 4 + 1]!, w.planes[plane * 4 + 2]!,
      ]) as Vec3;
      const s = BoxOnPlaneSide(n as Vec3, x as Vec3, normal, w.planes[plane * 4 + 3]!);
      if (s === 1) cur = w.nodes[d + 1]!;
      else if (s === 2) cur = w.nodes[d + 2]!;
      else {
        walk(w.nodes[d + 1]!);
        cur = w.nodes[d + 2]!;
      }
    }
  };
  walk(headnode);
  return out.length;
}

/**
 * Swept-box trace through model 0 (CM_BoxTrace, headnode = models[0].headnode).
 * mask filters brush/leaf contents (e.g. CONTENTS_SOLID = 1).
 */
export function traceBox(world: Bsp38, start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, mask: number): Trace {
  const w = asBspMap(world);
  const nNodes = w.nodes.length / NODE_STRIDE;
  const endpos = v3();
  const finish = (ctx: TraceCtx | null, fraction: number): Trace => {
    const f = ctx ? ctx.fraction : fraction;
    endpos[0] = start[0]! + f * (end[0]! - start[0]!);
    endpos[1] = start[1]! + f * (end[1]! - start[1]!);
    endpos[2] = start[2]! + f * (end[2]! - start[2]!);
    return {
      fraction: f,
      endpos,
      planeNormal: ctx ? ctx.planeNormal : v3(),
      contents: ctx ? ctx.brushContents : 0,
      entityNum: 0,
      startsolid: ctx ? ctx.startsolid : false,
      allsolid: ctx ? ctx.allsolid : false,
      planeDist: ctx ? ctx.planeDist : 0,
    };
  };

  if (nNodes === 0) {
    endpos[0] = end[0]!; endpos[1] = end[1]!; endpos[2] = end[2]!;
    return { fraction: 1, endpos, planeNormal: v3(), contents: 0, entityNum: 0, startsolid: false, allsolid: false, planeDist: 0 };
  }

  const headnode = w.modelsExtra.length >= 3 ? w.modelsExtra[0]! : 0;
  const ctx: TraceCtx = {
    w, start, end, mins, maxs,
    extents: v3(),
    contents: mask,
    isPoint: false,
    fraction: 1,
    planeNormal: v3(),
    planeDist: 0,
    brushContents: 0,
    startsolid: false,
    allsolid: false,
    check: checkStateFor(w),
  };

  // Position-test special case (start == end).
  if (start[0] === end[0] && start[1] === end[1] && start[2] === end[2]) {
    const c1 = v3(start[0]! + mins[0]! - 1, start[1]! + mins[1]! - 1, start[2]! + mins[2]! - 1);
    const c2 = v3(start[0]! + maxs[0]! + 1, start[1]! + maxs[1]! + 1, start[2]! + maxs[2]! + 1);
    const leafsHit: number[] = [];
    boxLeafnums(w, c1, c2, headnode, leafsHit);
    for (const l of leafsHit) {
      testInLeaf(ctx, l);
      if (ctx.allsolid) break;
    }
    endpos[0] = start[0]!; endpos[1] = start[1]!; endpos[2] = start[2]!;
    return {
      fraction: ctx.fraction, endpos, planeNormal: ctx.planeNormal,
      contents: ctx.brushContents, entityNum: 0,
      startsolid: ctx.startsolid, allsolid: ctx.allsolid, planeDist: ctx.planeDist,
    };
  }

  if (mins[0] === 0 && mins[1] === 0 && mins[2] === 0 && maxs[0] === 0 && maxs[1] === 0 && maxs[2] === 0) {
    ctx.isPoint = true;
  } else {
    ctx.extents[0] = Math.max(-mins[0]!, maxs[0]!);
    ctx.extents[1] = Math.max(-mins[1]!, maxs[1]!);
    ctx.extents[2] = Math.max(-mins[2]!, maxs[2]!);
  }

  recursiveHullCheck(ctx, headnode, 0, 1, start, end);
  return finish(ctx, ctx.fraction);
}
