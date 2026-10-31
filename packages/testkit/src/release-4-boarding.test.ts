// @q2/testkit — RELEASE-4 boarding lane: real-map trace diagnostic for the
// waiting final elevator (testkit side of the RELEASE-4 done-when box 1).
//
// Owns: `packages/testkit` ONLY. Read-only on `packages/server` /
// `packages/game` / `packages/bsp` / `packages/filesystem` / `@q2/math`
// through their real exports (production code paths, never mirrors —
// except the labelled PRE-FIX mirror below, which is the defect proof).
// `apps/web` is never imported (its base1 gate owns the full ride).
//
// What this covers (RELEASE-4 user-verdict: "elevator now stays open/waits,
// but an invisible obstruction prevents entry. Preserve the waiting repair"):
//   - Leg 1: trace the normal walking approach on REAL base1 (Q2_PAK): doorway
//     outside -> threshold (through the opened *32 slider) -> southern bypass
//     (the only walkable route west: the rock wall at x≈-1880/-1844 seals the
//     straight corridor) -> west walkway -> walkway end -> step-off drop onto
//     the waiting *12 deck. Per-ray fraction/startsolid/allsolid/entityNum/
//     model. Asserts passage (fraction ~1, clean step-off landing) POST-FIX;
//     PRE-FIX the phantom-sensitive legs fail naming the blocker (*32/*12).
//   - Leg 2: rendered-vs-collision pose: the waiting lift's visual pose
//     (train/mover origin as the renderer consumes it: ent.origin - rest,
//     the exact formula apps/web DoorSync.syncDoors applies to baked verts)
//     against SV_MoverClipBox/SV_TrainClipBox at the same tick — epsilon 1e-6.
//     Host frames cannot cover this in testkit (Host owns no ServerState and
//     the mover graft lives in apps/web), so the shared authoritative origin
//     math is pinned on both sides instead.
//   - Leg 3: no premature departure + waiting preserved: pristine boot, 400
//     empty ticks, read-only observation — train never starts, plug/sliders
//     never leave rest, no t91/t4 fires. No boarding, no button use, no ride
//     (the web gate owns the ride).
//   - Leg 4: defect-proof mirror: the PRE-FIX sweepBrushBox entry/exit logic,
//     replicated BY VALUE from HEAD, run over the same rays — it reports the
//     fraction-0 + startsolid phantom naming *32 (plug-top traverse) and *12
//     (the waiting lift) where the fixed production trace reports 1.0.
//
// Ground truths: id base1.bsp brush bounds (modelsMins/Maxs); C DIST_EPSILON
// contact bias (1/32 — a terminal touch lands at 1-eps, not exactly 1);
// G_SetMovedir slider travel; SP_func_door no-trigger rule for targetnamed
// doors (the waiting repair — preserved, never weakened here).
//
// Skips cleanly without Q2_PAK (source tools/q2-paths.sh). Software goldens
// untouched; no thresholds changed.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { PakFile } from '@q2/filesystem';
import { DIST_EPSILON, loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import { resetEdictNums } from '@q2/game';
import type { TraceFn } from '@q2/game';
import {
  MASK_PLAYERSOLID_C,
  SV_ClipTrace,
  SV_DropTraceFor,
  SV_Init,
  SV_MoverClipBox,
  SV_SpawnEntities,
  SV_Tick,
  SV_TouchDoorsAt,
  SV_TraceFor,
  SV_TrainClipBox,
  SV_UseMover,
  type ServerState,
} from '@q2/server';

const Q2_PAK = process.env.Q2_PAK;
const HAS_PAK = !!Q2_PAK && existsSync(Q2_PAK);

const PLAYER_MINS: Vec3 = v3(-16, -16, -24);
const PLAYER_MAXS: Vec3 = v3(16, 16, 32);
/** Passage epsilon: a terminal DIST_EPSILON contact lands at 1-eps, not 1. */
const PASS_EPS = 1e-3;
/** Rendered-vs-collision pose epsilon (same-origin math: exact in floats). */
const POSE_EPS = 1e-6;

// ---------------------------------------------------------------------------
// Harness: real base1 boot, production setup, ray reporting.
// ---------------------------------------------------------------------------

function modelBounds(map: BspMap, n: number): { mins: Float32Array; maxs: Float32Array } {
  const mm = map as unknown as { modelsMins: Float32Array; modelsMaxs: Float32Array };
  return {
    mins: new Float32Array([mm.modelsMins[n * 3]!, mm.modelsMins[n * 3 + 1]!, mm.modelsMins[n * 3 + 2]!]),
    maxs: new Float32Array([mm.modelsMaxs[n * 3]!, mm.modelsMaxs[n * 3 + 1]!, mm.modelsMaxs[n * 3 + 2]!]),
  };
}

function bootBase1(): { st: ServerState; map: BspMap } {
  const raw = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const pak = new PakFile(buf);
  const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
  resetEdictNums();
  const st = SV_Init();
  SV_SpawnEntities(
    st,
    map.entities,
    (model) => {
      if (!model.startsWith('*')) return null;
      const n = Number.parseInt(model.slice(1), 10);
      if (!Number.isFinite(n)) return null;
      return modelBounds(map, n);
    },
    SV_DropTraceFor(map),
  );
  return { st, map };
}

/**
 * Park the entry sliders open the production way: the hall camper's lean
 * overlaps the *32/*33 Touch_DoorTrigger volumes, so SV_TouchDoorsAt opens
 * them and the sustained camp holds them at TOP (C wait reset while camped).
 * The targetname'd *31 plug owns no trigger (waiting repair) and sits out.
 */
function parkSlidersOpen(st: ServerState, ticks = 400): void {
  const lean = { origin: v3(-1669, 1514, 120), mins: PLAYER_MINS, maxs: PLAYER_MAXS };
  for (let i = 0; i < ticks; i++) {
    SV_Tick(st, 0.1);
    SV_TouchDoorsAt(st, lean);
  }
}

function clipOf(st: ServerState, map: BspMap): TraceFn {
  return SV_ClipTrace(st, SV_TraceFor(map, MASK_PLAYERSOLID_C));
}

/** Blocker identity for reports: model, class, origin, bounds, solid. */
function ident(st: ServerState, num: number): string {
  if (num <= 0) return `world(${num})`;
  const e = st.entities.find((x) => x.num === num);
  if (!e) return `edict#${num}?`;
  const b = st.moverBounds.get(num);
  const bb = b ? ` clip=[${[...b.mins].map((v) => v.toFixed(0))}]-[${[...b.maxs].map((v) => v.toFixed(0))}]` : '';
  return `#${num} ${e.classname} ${e.model ?? ''} origin=[${[...e.origin].map((v) => v.toFixed(0))}] solid=${e.solid}${bb}`;
}

interface RayReport {
  tag: string;
  fraction: number;
  startsolid: boolean;
  allsolid: boolean;
  entityNum: number;
  identity: string;
  endpos: [number, number, number];
}

function sweep(
  st: ServerState,
  trace: TraceFn,
  tag: string,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): RayReport {
  const t = trace(v3(ax, ay, az), PLAYER_MINS, PLAYER_MAXS, v3(bx, by, bz));
  return {
    tag,
    fraction: t.fraction,
    startsolid: t.startsolid,
    allsolid: t.allsolid,
    entityNum: t.entityNum,
    identity: ident(st, t.entityNum),
    endpos: [t.endpos[0]!, t.endpos[1]!, t.endpos[2]!],
  };
}

function fmt(r: RayReport): string {
  return (
    `${r.tag}: frac=${r.fraction.toFixed(4)} ss=${r.startsolid} as=${r.allsolid} ` +
    `ent=${r.entityNum}(${r.identity}) end=[${r.endpos.map((v) => v.toFixed(1))}]`
  );
}

// ---------------------------------------------------------------------------
// PRE-FIX mirror: sweepBrushBox entry/exit, replicated BY VALUE from HEAD
// (packages/server/src/index.ts @ ff85aa6 — before the moving-away repair).
// The repair adds the "start outside + moving away -> whole sweep misses"
// early-out and drops the tminRaw startsolid; everything else is identical.
// ---------------------------------------------------------------------------

function sweepBrushBoxPreFix(
  start: Vec3, end: Vec3, mins: Vec3, maxs: Vec3, bmins: Float32Array, bmaxs: Float32Array,
): { fraction: number; normal: Vec3; allsolid: boolean; startsolid: boolean } {
  const lo = [bmins[0]! - maxs[0]!, bmins[1]! - maxs[1]!, bmins[2]! - maxs[2]!];
  const hi = [bmaxs[0]! - mins[0]!, bmaxs[1]! - mins[1]!, bmaxs[2]! - mins[2]!];
  const inside = (p: Vec3): boolean =>
    p[0]! >= lo[0]! && p[0]! <= hi[0]! &&
    p[1]! >= lo[1]! && p[1]! <= hi[1]! &&
    p[2]! >= lo[2]! && p[2]! <= hi[2]!;
  if (inside(start)) {
    if (inside(end)) {
      const n = v3(0, 0, 0);
      const pens = [
        Math.min(start[0]! - lo[0]!, hi[0]! - start[0]!),
        Math.min(start[1]! - lo[1]!, hi[1]! - start[1]!),
        Math.min(start[2]! - lo[2]!, hi[2]! - start[2]!),
      ];
      let axis = 0;
      if (pens[1]! < pens[axis]!) axis = 1;
      if (pens[2]! < pens[axis]!) axis = 2;
      const mid = (lo[axis]! + hi[axis]!) / 2;
      n[axis] = start[axis]! < mid ? -1 : 1;
      return { fraction: 0, normal: n, allsolid: true, startsolid: true };
    }
    return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: true };
  }
  let tmin = -1, tmax = 1, tminRaw = 0, axis = -1, sign = 0;
  for (let i = 0; i < 3; i++) {
    const d = end[i]! - start[i]!;
    if (Math.abs(d) < 1e-9) {
      if (start[i]! < lo[i]! || start[i]! > hi[i]!) {
        return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
      }
      continue;
    }
    let t1 = (lo[i]! - start[i]!) / d;
    let t2 = (hi[i]! - start[i]!) / d;
    let s = -1;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
      s = 1;
    }
    const bias = DIST_EPSILON / Math.abs(d);
    const t1b = t1 - bias;
    const t2b = t2 + bias;
    if (t1 > tminRaw) tminRaw = t1;
    if (t1b > tmin) {
      tmin = t1b;
      axis = i;
      sign = s;
    }
    if (t2b < tmax) tmax = t2b;
    if (tmin > tmax) return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
  }
  if (axis < 0) return { fraction: 1, normal: v3(0, 0, 1), allsolid: false, startsolid: false };
  const n = v3(0, 0, 0);
  n[axis] = sign;
  return { fraction: Math.max(0, Math.min(1, tmin)), normal: n, allsolid: false, startsolid: tminRaw <= 0 };
}

/** SV_ClipTrace consider-loop with a swappable brush-box sweep. */
function clipTraceWithPreFix(st: ServerState, worldTrace: TraceFn): TraceFn {
  return (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => {
    let best = worldTrace(start, mins, maxs, end);
    let clipEnt = -1;
    const consider = (num: number, b: { mins: Float32Array; maxs: Float32Array } | null): void => {
      if (!b) return;
      const hit = sweepBrushBoxPreFix(start, end, mins, maxs, b.mins, b.maxs);
      if (hit.fraction < best.fraction || hit.allsolid) {
        const f = hit.fraction;
        best = {
          fraction: f,
          endpos: v3(
            start[0]! + (end[0]! - start[0]!) * f,
            start[1]! + (end[1]! - start[1]!) * f,
            start[2]! + (end[2]! - start[2]!) * f,
          ),
          planeNormal: hit.normal,
          allsolid: hit.allsolid,
          startsolid: hit.startsolid,
          entityNum: best.entityNum,
          contents: best.contents,
          surfaceFlags: best.surfaceFlags,
        };
        clipEnt = num;
      }
    };
    for (const [num, b] of st.brushClips) consider(num, b);
    for (const m of st.movers) {
      if (m.ent.classname !== 'func_door' && m.ent.classname !== 'func_button' && m.ent.classname !== 'func_plat') continue;
      consider(m.ent.num, SV_MoverClipBox(st, m));
    }
    for (const tr of st.trains) consider(tr.ent.num, SV_TrainClipBox(st, tr));
    if (clipEnt >= 0) best.entityNum = clipEnt;
    return best;
  };
}

// ---------------------------------------------------------------------------
// Route definition (measured on real base1; BFS-validated walkable nodes).
// Horizontal legs run at oz=121 (walkway standing height +1: exact floor
// contact reads startsolid in the trace either way, so the PASSAGE verdict
// is taken a hair above contact — clip overlaps are 8+ units, unaffected).
// ---------------------------------------------------------------------------

interface Leg { tag: string; a: [number, number, number]; b: [number, number, number] }

const DOOR_LEG: Leg = { tag: 'doorway outside->threshold', a: [-1560, 1504, 121], b: [-1688, 1504, 121] };

// Southern bypass (BFS nodes, decimated): the only walkable westward route —
// the rock wall at x≈-1880/-1844 seals the straight corridor at walkway level.
const BYPASS_LEGS: Leg[] = [
  { tag: 'bypass hall->south', a: [-1560, 1536, 121], b: [-1603, 1413, 121] },
  { tag: 'bypass jog', a: [-1603, 1413, 121], b: [-1603, 1381, 121] },
  { tag: 'bypass corner', a: [-1603, 1381, 121], b: [-1614, 1338, 121] },
  { tag: 'bypass corner2', a: [-1614, 1338, 121], b: [-1625, 1327, 121] },
  { tag: 'bypass west', a: [-1625, 1327, 121], b: [-1689, 1327, 121] },
  { tag: 'bypass west2', a: [-1689, 1327, 121], b: [-1817, 1327, 121] },
  { tag: 'bypass west3', a: [-1817, 1327, 121], b: [-1945, 1327, 121] },
  { tag: 'bypass west4', a: [-1945, 1327, 121], b: [-1961, 1327, 121] },
  { tag: 'bypass west5', a: [-1961, 1327, 121], b: [-1977, 1327, 121] },
  { tag: 'bypass north', a: [-1977, 1327, 121], b: [-1977, 1359, 121] },
  { tag: 'bypass north2', a: [-1977, 1359, 121], b: [-1977, 1391, 121] },
  { tag: 'bypass north3', a: [-1977, 1391, 121], b: [-1977, 1423, 121] },
  { tag: 'bypass north4', a: [-1977, 1423, 121], b: [-1977, 1455, 121] },
  { tag: 'bypass north5', a: [-1977, 1455, 121], b: [-1977, 1487, 121] },
  { tag: 'bypass north6', a: [-1977, 1487, 121], b: [-1977, 1519, 121] },
  { tag: 'walkway west', a: [-1977, 1519, 121], b: [-2000, 1530, 121] },
  { tag: 'walkway end', a: [-2000, 1530, 121], b: [-2026, 1542, 121] },
];

// Phantom-sensitive legs (fail pre-fix, pass post-fix):
//   - plug-top traverse westward over the dropped *31 (past the opened *32).
//   - pocket eastward leg starting beside the waiting *12 (moving away).
const PHANTOM_LEGS: Leg[] = [
  { tag: 'plug-top traverse', a: [-1720, 1480, 150], b: [-1800, 1480, 150] },
  { tag: 'pocket past waiting lift', a: [-2030, 1536, 0], b: [-1950, 1536, 0] },
];

/** Step-off drop legs onto the waiting deck (vertical rays past the slab edge). */
const DROP_XS = [-2068, -2072, -2076];

// ---------------------------------------------------------------------------
// Leg 0 — always runs (no pak): synthetic phantom mechanism + skip notice.
// ---------------------------------------------------------------------------

describe('RELEASE-4 boarding (asset-free legs)', () => {
  it('pre-fix entry logic phantoms a behind-walk clip (synthetic)', () => {
    // A box sitting one ray-length behind the walk direction, sharing the
    // body's y/z band: the pre-fix entry math clamps the behind-entry to
    // fraction 0 with startsolid set; the fixed trace must miss it.
    const mins = v3(-16, -16, -24);
    const maxs = v3(16, 16, 32);
    // Clip box east of the start (walk goes west, away from it).
    const bmins = new Float32Array([10, -50, -48]);
    const bmaxs = new Float32Array([26, 50, 0]);
    const start = v3(-30, 0, 0);
    const end = v3(-110, 0, 0);
    const hit = sweepBrushBoxPreFix(start, end, mins, maxs, bmins, bmaxs);
    expect(hit.fraction, 'pre-fix phantom blocks (fraction 0)').toBe(0);
    expect(hit.startsolid, 'pre-fix phantom sets startsolid').toBe(true);
    console.log(
      `[release-4] synthetic phantom: pre-fix frac=${hit.fraction} ss=${hit.startsolid} (behind-walk clip blocks); ` +
        `DIST_EPSILON=${DIST_EPSILON}`,
    );
    expect(DIST_EPSILON, 'C contact bias 1/32').toBeCloseTo(1 / 32, 10);
  });

  it('reports the asset-gate status', () => {
    console.log(
      `[release-4] Q2_PAK ${HAS_PAK ? `present (${Q2_PAK}) — real-map legs run` : 'absent — real-map legs skip cleanly'}`,
    );
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legs 1-4 — real base1 (Q2_PAK).
// ---------------------------------------------------------------------------

describe.runIf(HAS_PAK)('RELEASE-4 boarding (real base1 trace diagnostic)', () => {
  it('leg 1: the walking approach is not blocked (passage + board drop)', () => {
    const { st, map } = bootBase1();
    parkSlidersOpen(st);
    // Drop the plug through its intended control (the *34 use entry — the
    // same call an E-use would make; the button brush is wall-embedded).
    SV_UseMover(st, st.movers.find((m) => m.ent.model === '*34')!);
    for (let i = 0; i < 20; i++) {
      SV_Tick(st, 0.1);
      SV_TouchDoorsAt(st, { origin: v3(-1669, 1514, 120), mins: PLAYER_MINS, maxs: PLAYER_MAXS });
    }
    const plug = st.movers.find((m) => m.ent.model === '*31')!;
    expect(plug.ent.origin[2]!, 'plug dropped for the traverse').toBeCloseTo(-156, 0);
    const clip = clipOf(st, map);
    const lines: string[] = [];
    const checkPassage = (leg: Leg): void => {
      const r = sweep(st, clip, leg.tag, ...leg.a, ...leg.b);
      lines.push(fmt(r));
      expect(
        r.fraction,
        `BLOCKED approach leg ${fmt(r)} (blocker model above)`,
      ).toBeGreaterThanOrEqual(1 - PASS_EPS);
      const [bx, by, bz] = leg.b;
      expect(
        Math.hypot(r.endpos[0]! - bx!, r.endpos[1]! - by!, r.endpos[2]! - bz!),
        `leg ${leg.tag} must reach its far end (not stop short)`,
      ).toBeLessThan(1.5);
    };
    checkPassage(DOOR_LEG);
    for (const leg of BYPASS_LEGS) checkPassage(leg);
    for (const leg of PHANTOM_LEGS) checkPassage(leg);
    // Board drop: step off past the slab edge, land on the waiting deck.
    const train = st.trains.find((t) => !t.ship)!;
    expect(train.ent.model, 'waiting lift is *12').toBe('*12');
    for (const x of DROP_XS) {
      const t = clip(v3(x, 1536, 121), PLAYER_MINS, PLAYER_MAXS, v3(x, 1536, -100));
      const r: RayReport = {
        tag: `board drop x=${x}`,
        fraction: t.fraction,
        startsolid: t.startsolid,
        allsolid: t.allsolid,
        entityNum: t.entityNum,
        identity: ident(st, t.entityNum),
        endpos: [t.endpos[0]!, t.endpos[1]!, t.endpos[2]!],
      };
      lines.push(fmt(r));
      expect(t.startsolid, `drop x=${x} must start clean`).toBe(false);
      expect(r.endpos[2]! - 24, `drop x=${x} must land on the deck top (feet 0), got ${fmt(r)}`).toBeCloseTo(0, 0);
      expect(t.entityNum, `drop x=${x} must land on the waiting lift, got ${fmt(r)}`).toBe(train.ent.num);
      expect(t.planeNormal[2]!, `drop x=${x} must land flat, got ${fmt(r)}`).toBeGreaterThan(0.7);
    }
    console.log(`[release-4] leg1 approach rays:\n  ${lines.join('\n  ')}`);
  });

  it('leg 2: waiting lift rendered-vs-collision pose matches (epsilon)', () => {
    const { st, map } = bootBase1();
    void map;
    parkSlidersOpen(st);
    SV_UseMover(st, st.movers.find((m) => m.ent.model === '*34')!);
    for (let i = 0; i < 20; i++) {
      SV_Tick(st, 0.1);
      SV_TouchDoorsAt(st, { origin: v3(-1669, 1514, 120), mins: PLAYER_MINS, maxs: PLAYER_MAXS });
    }
    // Rendered displacement (what syncDoors bakes into verts: ent.origin - rest;
    // rest = pos1 for movers, the lump origin for trains) vs collision
    // displacement (clip.mins - rest bounds) at the same tick, no ticks between.
    const lines: string[] = [];
    const checkMover = (model: string): void => {
      const m = st.movers.find((x) => x.ent.model === model)!;
      expect(m, `mover ${model} present`).toBeDefined();
      const box = SV_MoverClipBox(st, m);
      expect(box, `${model} must have collision where it renders`).not.toBeNull();
      const bounds = st.moverBounds.get(m.ent.num)!;
      const rdx = [m.ent.origin[0]! - m.pos1[0]!, m.ent.origin[1]! - m.pos1[1]!, m.ent.origin[2]! - m.pos1[2]!];
      const cdx = [box!.mins[0]! - bounds.mins[0]!, box!.mins[1]! - bounds.mins[1]!, box!.mins[2]! - bounds.mins[2]!];
      const err = Math.hypot(rdx[0]! - cdx[0]!, rdx[1]! - cdx[1]!, rdx[2]! - cdx[2]!);
      lines.push(`${model} state=${m.state} rdx=[${rdx.map((v) => v.toFixed(2))}] cdx=[${cdx.map((v) => v.toFixed(2))}] err=${err}`);
      expect(err, `${model} rendered-vs-collision desync ${err} (rdx ${rdx} vs cdx ${cdx})`).toBeLessThanOrEqual(POSE_EPS);
    };
    for (const model of ['*31', '*32', '*33', '*34']) checkMover(model);
    const tr = st.trains.find((t) => !t.ship)!;
    const tbox = SV_TrainClipBox(st, tr);
    expect(tbox, '*12 train must have collision where it renders').not.toBeNull();
    const trest = (tr.ent.extra['origin'] ?? '0 0 0').split(/\s+/).map(Number);
    const tbase = st.moverBounds.get(tr.ent.num)!;
    const trdx = [tr.ent.origin[0]! - (trest[0] ?? 0), tr.ent.origin[1]! - (trest[1] ?? 0), tr.ent.origin[2]! - (trest[2] ?? 0)];
    const tcdx = [tbox!.mins[0]! - tbase.mins[0]!, tbox!.mins[1]! - tbase.mins[1]!, tbox!.mins[2]! - tbase.mins[2]!];
    const terr = Math.hypot(trdx[0]! - tcdx[0]!, trdx[1]! - tcdx[1]!, trdx[2]! - tcdx[2]!);
    lines.push(`*12 train started=${tr.started} rdx=[${trdx.map((v) => v.toFixed(2))}] cdx=[${tcdx.map((v) => v.toFixed(2))}] err=${terr}`);
    expect(terr, `*12 rendered-vs-collision desync ${terr}`).toBeLessThanOrEqual(POSE_EPS);
    console.log(`[release-4] leg2 pose check:\n  ${lines.join('\n  ')}`);
  });

  it('leg 3: no premature departure, waiting preserved (read-only)', () => {
    const { st } = bootBase1();
    const train = st.trains.find((t) => !t.ship)!;
    const plug = st.movers.find((m) => m.ent.model === '*31')!;
    const d32 = st.movers.find((m) => m.ent.model === '*32')!;
    const d33 = st.movers.find((m) => m.ent.model === '*33')!;
    // Unattended time passage: 400 ticks, zero inputs — nobody near any
    // control, no touch, no use. Read-only observation (no driving, no ride).
    for (let i = 0; i <= 400; i++) {
      if (i > 0) SV_Tick(st, 0.1);
      if (i % 100 === 0 || i === 400) {
        expect([...train.ent.origin] as number[], `train pose frozen at tick ${i}`).toEqual([0, 0, 0]);
        expect(train.started, `train never starts without *13 (tick ${i})`).toBe(false);
        expect(train.arrived, `train never arrives without *13 (tick ${i})`).toBe(false);
        expect([...plug.ent.origin] as number[], `plug stays at pos1 (tick ${i})`).toEqual([...plug.pos1]);
        expect(plug.state, `plug never leaves bottom without t4 (tick ${i})`).toBe('bottom');
        expect([...d32.ent.origin] as number[], `*32 stays shut unattended (tick ${i})`).toEqual([...d32.pos1]);
        expect([...d33.ent.origin] as number[], `*33 stays shut unattended (tick ${i})`).toEqual([...d33.pos1]);
      }
      expect(st.firedThisTick.includes('t91'), `t91 never fires unattended (tick ${i})`).toBe(false);
      expect(st.firedThisTick.includes('t4'), `t4 never fires unattended (tick ${i})`).toBe(false);
    }
    console.log('[release-4] leg3 waiting: 400 empty ticks, train at [0,0,0] unstarted, plug/sliders at rest, no t91/t4');
  });

  it('leg 4: pre-fix mirror names the phantom blocker the fix removes', () => {
    const { st, map } = bootBase1();
    parkSlidersOpen(st);
    SV_UseMover(st, st.movers.find((m) => m.ent.model === '*34')!);
    for (let i = 0; i < 20; i++) {
      SV_Tick(st, 0.1);
      SV_TouchDoorsAt(st, { origin: v3(-1669, 1514, 120), mins: PLAYER_MINS, maxs: PLAYER_MAXS });
    }
    const world = SV_TraceFor(map, MASK_PLAYERSOLID_C);
    const oldTrace = clipTraceWithPreFix(st, world);
    const prodTrace = SV_ClipTrace(st, world);
    const lines: string[] = [];
    let phantomCount = 0;
    for (const leg of [...PHANTOM_LEGS, DOOR_LEG]) {
      const o = sweep(st, oldTrace, `OLD ${leg.tag}`, ...leg.a, ...leg.b);
      const p = sweep(st, prodTrace, `NEW ${leg.tag}`, ...leg.a, ...leg.b);
      lines.push(fmt(o));
      lines.push(fmt(p));
      if (o.fraction === 0 && o.startsolid && o.entityNum > 0) phantomCount++;
      // The production (fixed) trace must pass every approach ray: if the
      // server fix has NOT landed, this fails here and the OLD line above
      // names the blocking entity (model *N) as defect proof.
      expect(
        p.fraction,
        `PRE-FIX DEFECT PROOF: approach ray blocked post="fix" run: ${fmt(p)} (pre-fix logic: ${fmt(o)})`,
      ).toBeGreaterThanOrEqual(1 - PASS_EPS);
    }
    // The frozen pre-fix logic must exhibit the phantom on this build's
    // geometry (otherwise the mirror proves nothing).
    expect(phantomCount, `pre-fix mirror must phantom-block >=1 approach ray:\n  ${lines.join('\n  ')}`).toBeGreaterThanOrEqual(1);
    console.log(`[release-4] leg4 before/after (phantoms pinned: ${phantomCount}):\n  ${lines.join('\n  ')}`);
  });
});
