// @q2/testkit — deterministic matched baseline workloads (PERF-NEXT-1, testkit lane).
//
// The three 640x480 acceptance workloads as shared fixtures callable from
// bench AND tests, so both record the same scene/camera/entities/cvars:
//   - stationary: spawn-north fixed camera + fixed entity set.
//   - combat:     stationary + eye-anchored depthHack viewmodel gun + per-rep
//                 pumped muzzle/explosion dlights (mirrors the live loop).
//   - moving:     combat entities + deterministic yaw-step sweep (pure
//                 function of the rep index, so per-frame hashes stay
//                 comparable across builds/runs).
// 320x240 helpers are provided for DIAGNOSTIC use only (see BENCH_DIAG_*):
// acceptance evidence is always 640x480.
//
// Fidelity profile: pinBenchCvars() pins the exact vd_*/sw_* profile the
// bench harness measures under (mirrors tools/bench pinPerfCvars by value —
// testkit cannot import tools/* — so bench, goldens and gates share one
// definition). fidelityCvarSnapshot() records the pinned profile for
// evidence rows. NOTE: vd_lodbias is pinned to -0.35 to match the bench's
// current pinned profile; BRAIN.md §8 notes the alias-bias reassessment to
// 0 as follow-up work — if the bench lane moves the profile, move this
// function in the same change and re-record hashes.

import { getCVarString, resetCVars, setCVar, setCVarFromString } from '@q2/config';
import type { Entity, RefDef } from '@q2/renderer-api';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { PakFile } from '@q2/filesystem';
import { parseMD2, parsePCX, parseWAL } from '@q2/formats';
import {
  bspToMiniWorld,
  type BspTexelSource,
  type DynamicLight,
  type MiniWorld,
  type SoftwareRenderer,
} from '@q2/sw-renderer';
import { base1RefDef, base1Views } from './base1-views.js';

/** Matched acceptance workloads (640x480 software/Voodoo, serial + pooled). */
export type BenchWorkload = 'stationary' | 'combat' | 'moving';

export const BENCH_WORKLOADS: BenchWorkload[] = ['stationary', 'combat', 'moving'];

/** Acceptance resolution. Evidence rows at any other size are not acceptance. */
export const BENCH_ACCEPT_WIDTH = 640;
export const BENCH_ACCEPT_HEIGHT = 480;

/**
 * Diagnostic-only resolution. Unit-test smokes and bring-up probes may use
 * it for speed, but NO baseline/acceptance evidence may be recorded at this
 * size (card PERF-NEXT-1: 320x240 is diagnostic only).
 */
export const BENCH_DIAG_WIDTH = 320;
export const BENCH_DIAG_HEIGHT = 240;

/** True when (w, h) is the diagnostic-only size (never acceptance). */
export function isDiagnosticResolution(w: number, h: number): boolean {
  return w === BENCH_DIAG_WIDTH && h === BENCH_DIAG_HEIGHT;
}

/** True when (w, h) is the acceptance size. */
export function isAcceptanceResolution(w: number, h: number): boolean {
  return w === BENCH_ACCEPT_WIDTH && h === BENCH_ACCEPT_HEIGHT;
}

/** Worker sweep for trustworthy reporting (serial + pooled). No hard-coded subsets. */
export const BENCH_WORKER_SWEEP: number[] = [0, 1, 3, 7];

/**
 * Parse a worker-sweep spec such as "0,1,3,7" (env COMPARE_WORKERS /
 * RGB_BENCH_WORKERS shape). Clamps to 0..8, dedupes, preserves order.
 * Empty/garbage input falls back to BENCH_WORKER_SWEEP.
 */
export function normalizeWorkerSweep(raw: string | undefined): number[] {
  const out: number[] = [];
  for (const part of (raw ?? '').split(',')) {
    if (part.trim() === '') continue;
    const n = Math.floor(Number(part));
    if (Number.isFinite(n) && n >= 0 && n <= 8 && !out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : [...BENCH_WORKER_SWEEP];
}

/** Default deterministic yaw step for the moving workload (degrees per rep). */
export const BENCH_YAW_STEP_DEG = 2;

/** Spawn view all three workloads share (spawn-north, time 1.5, fov 90). */
export function benchSpawnView(): RefDef {
  const bv = base1Views().find((v) => v.label === 'spawn-north');
  if (!bv) throw new Error('testkit: base1Views() lost spawn-north');
  return base1RefDef(bv);
}

/** Camera origin shared by every workload (entity placement anchor). */
export function benchSpawnOrigin(): [number, number, number] {
  const bv = base1Views().find((v) => v.label === 'spawn-north');
  if (!bv) throw new Error('testkit: base1Views() lost spawn-north');
  return [...bv.origin] as [number, number, number];
}

/** Camera yaw shared by every workload (entity placement anchor). */
export function benchSpawnYaw(): number {
  const bv = base1Views().find((v) => v.label === 'spawn-north');
  if (!bv) throw new Error('testkit: base1Views() lost spawn-north');
  return bv.angles[1]!;
}

/**
 * Deterministic RefDef for a (workload, rep) pair. Stationary/combat hold
 * the fixed camera; moving adds rep * yawStepDeg to the spawn yaw — a pure
 * function of the rep index, so per-frame hashes stay comparable across
 * builds and runs.
 */
export function benchViewFor(workload: BenchWorkload, rep: number, yawStepDeg = BENCH_YAW_STEP_DEG): RefDef {
  const view = benchSpawnView();
  if (workload === 'moving') {
    const a = view.angles.slice() as Float32Array;
    a[1] = a[1]! + rep * yawStepDeg;
    view.angles = a;
  }
  return view;
}

// --- Fidelity profile -------------------------------------------------------

/** Pinned cvars, mirrored by value from tools/bench pinPerfCvars. */
export const BENCH_FIDELITY_CVARS: Record<string, string> = {
  sw_workers: '0',
  sw_accum: '0',
  vd_gamma: '1.3',
  vd_dither: '1',
  vd_16bit: '1',
  vd_postfilter: '1',
  vd_bilinear: '1',
  vd_mipdither: '1',
  vd_lodbias: '-0.35',
  vd_fog: '1',
  vd_overbright: '1',
  vd_palettetex: '1',
  vd_maxtexsize: '256',
  vd_zbits: '16',
  vd_dithermode: '4x4',
  vd_reconmode: '2x2sub+2x2box',
  vd_rgbmaxdelta: '8,8,8',
};

/** Pin the fixed fidelity profile (reset, then set every pinned cvar). */
export function pinBenchCvars(): void {
  resetCVars();
  setCVar('sw_workers', 0);
  setCVar('sw_accum', 0);
  setCVar('vd_gamma', 1.3);
  setCVar('vd_dither', 1);
  setCVar('vd_16bit', 1);
  setCVar('vd_postfilter', 1);
  setCVar('vd_bilinear', 1);
  setCVar('vd_mipdither', 1);
  setCVar('vd_lodbias', -0.35);
  setCVar('vd_fog', 1);
  setCVar('vd_overbright', 1);
  setCVar('vd_palettetex', 1);
  setCVar('vd_maxtexsize', 256);
  setCVar('vd_zbits', 16);
  setCVarFromString('vd_dithermode', '4x4');
  setCVarFromString('vd_reconmode', '2x2sub+2x2box');
  setCVarFromString('vd_rgbmaxdelta', '8,8,8');
}

/**
 * Snapshot the pinned fidelity cvars for an evidence row. Keys are the
 * BENCH_FIDELITY_CVARS names; values are the live cvar strings.
 */
export function fidelityCvarSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(BENCH_FIDELITY_CVARS)) out[name] = getCVarString(name);
  return out;
}

/** True when the live cvars match the pinned profile (string comparison). */
export function fidelityProfileMatches(): boolean {
  const snap = fidelityCvarSnapshot();
  return Object.entries(BENCH_FIDELITY_CVARS).every(([k, v]) => snap[k] === v);
}

// --- Real-asset world + entity fixtures (Q2_PAK-gated callers) --------------

/** Real base1 asset bundle backing the matched workloads. */
export interface BenchWorld {
  world: MiniWorld;
  palette: Uint8Array;
  soldierMd2: ArrayBuffer;
  soldierSkin: { pixels: Uint8Array; width: number; height: number };
  gunMd2: ArrayBuffer;
  gunSkin: { pixels: Uint8Array; width: number; height: number };
}

/**
 * Load the base1 asset bundle from raw pak bytes (no node:fs — the caller
 * reads the file; PakFile works on the buffer, so this stays
 * platform-neutral). Throws when a required lump is missing.
 */
export function loadBenchWorld(pakBytes: ArrayBuffer): BenchWorld {
  const pak = new PakFile(pakBytes);
  const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
  const walCache = new Map<string, BspTexelSource | null>();
  const texelFor = (walName: string): BspTexelSource | null => {
    if (walCache.has(walName)) return walCache.get(walName)!;
    let src: BspTexelSource | null = null;
    try {
      const wal = parseWAL(pak.readFile(`textures/${walName}.wal`));
      src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
    } catch {
      src = null;
    }
    walCache.set(walName, src);
    return src;
  };
  const skin = parsePCX(pak.readFile('models/monsters/soldier/skin.pcx'));
  const gunSkin = parsePCX(pak.readFile('models/weapons/v_blast/skin.pcx'));
  return {
    world: bspToMiniWorld(map, { texelFor }),
    palette: parsePCX(pak.readFile('pics/colormap.pcx')).palette,
    soldierMd2: pak.readFile('models/monsters/soldier/tris.md2'),
    soldierSkin: { pixels: skin.pixels, width: skin.width, height: skin.height },
    gunMd2: pak.readFile('models/weapons/v_blast/tris.md2'),
    gunSkin: { pixels: gunSkin.pixels, width: gunSkin.width, height: gunSkin.height },
  };
}

/**
 * Camera-relative fixed entity set, placed in-frustum for the spawn-north
 * camera: 1 alias (real soldier MD2 frame 4) + 1 sprite + 1 tracer beam.
 * Mirrors tools/bench fixedEntities by value (bench cannot be imported from
 * here — tools/* are leaves).
 */
export function fixedBenchEntities(
  r: SoftwareRenderer,
  bw: BenchWorld,
  origin: [number, number, number],
  yawDeg: number,
): Entity[] {
  const yaw = (yawDeg * Math.PI) / 180;
  const fx = Math.cos(yaw), fy = Math.sin(yaw);
  const rx = -fy, ry = fx;
  const [ox, oy, oz] = origin;
  const md2 = parseMD2(bw.soldierMd2.slice(0));
  const mh = r.registerModel({ name: 'soldier', kind: 'md2', data: md2 });
  const sh = r.registerSkinPixels('soldier-skin', bw.soldierSkin.pixels, bw.soldierSkin.width, bw.soldierSkin.height);
  const th = r.registerModel({ name: 'tracer', kind: 'tracer' as unknown as 'sp2', data: null });
  const sx = ox + fx * 48, sy = oy + fy * 48;
  const sp2 = r.registerModel({ name: 'shot-sprite', kind: 'sp2', data: null });
  return [
    {
      model: mh, origin: new Float32Array([sx, sy, oz - 30]),
      angles: new Float32Array([0, yawDeg + 180, 0]), frame: 4, skin: sh,
    },
    {
      model: sp2, origin: new Float32Array([sx, sy, oz + 18]),
      angles: new Float32Array([0, 0, 0]), frame: 0, skin: sh,
    },
    {
      model: th,
      origin: new Float32Array([ox + fx * 40 + rx * 25, oy + fy * 40 + ry * 25, oz - 10]),
      angles: new Float32Array([0, yawDeg + 90, 0]), frame: 96, skin: 231,
    },
  ];
}

/**
 * Combat entity set: fixed set + eye-anchored depthHack viewmodel gun
 * (v_blast, the representative gameplay foreground path: near-clipped
 * foreground alias). Gun pose is frame 4 — frame 0 is degenerate head-on
 * (zero covered pixels; pinned by fg-models.test.ts), so frame 4 is the
 * representative visible pose. NOTE: tools/bench fixedEntities currently
 * registers the gun at frame 0; the bench lane should align to frame 4 (or
 * record the difference) before controlled comparisons.
 */
export function combatBenchEntities(
  r: SoftwareRenderer,
  bw: BenchWorld,
  origin: [number, number, number],
  yawDeg: number,
): Entity[] {
  const out = fixedBenchEntities(r, bw, origin, yawDeg);
  const [ox, oy, oz] = origin;
  const gunMd2 = parseMD2(bw.gunMd2.slice(0));
  const gh = r.registerModel({ name: 'v-blast', kind: 'md2', data: gunMd2 });
  const gs = r.registerSkinPixels('v-blast-skin', bw.gunSkin.pixels, bw.gunSkin.width, bw.gunSkin.height);
  out.push({
    model: gh, origin: new Float32Array([ox, oy, oz]),
    angles: new Float32Array([0, yawDeg, 0]), frame: 4, skin: gs,
    depthHack: true,
  });
  return out;
}

/** Entity set for a workload id (moving uses the combat set). */
export function benchEntitiesFor(
  workload: BenchWorkload,
  r: SoftwareRenderer,
  bw: BenchWorld,
  origin: [number, number, number],
  yawDeg: number,
): Entity[] {
  return workload === 'stationary'
    ? fixedBenchEntities(r, bw, origin, yawDeg)
    : combatBenchEntities(r, bw, origin, yawDeg);
}

/**
 * Combat dynamic lights, re-pumped every frame like the live loop: a muzzle
 * flash at the soldier position + an explosion flash downrange.
 * Expire-then-add mirrors the web pump (stale ttl entries never accumulate).
 */
export function pumpBenchLights(
  r: SoftwareRenderer,
  origin: [number, number, number],
  yawDeg: number,
): void {
  const yaw = (yawDeg * Math.PI) / 180;
  const fx = Math.cos(yaw), fy = Math.sin(yaw);
  const [ox, oy, oz] = origin;
  r.testExpireDynamicLights();
  const muzzle: DynamicLight = {
    origin: new Float32Array([ox + fx * 48, oy + fy * 48, oz - 20]),
    intensity: 250, color: new Float32Array([1, 0.55, 0.15]),
  };
  const boom: DynamicLight = {
    origin: new Float32Array([ox + fx * 90, oy + fy * 90, oz - 10]),
    intensity: 350, color: new Float32Array([1, 0.9, 0.7]),
  };
  r.testAddDynamicLight(muzzle);
  r.testAddDynamicLight(boom);
}

/** 12-particle spark cloud around (cx, cy, cz) for a MiniWorld copy (base1). */
export function benchSparkParticles(
  cx: number, cy: number, cz: number,
): MiniWorld['particles'] {
  const colors = [8, 70, 200, 231, 250, 180, 33, 99, 150, 210, 240, 15];
  return colors.map((color, i) => ({
    origin: new Float32Array([cx + ((i * 37) % 17) - 8, cy + ((i * 53) % 17) - 8, cz + 10 + ((i * 29) % 25)]),
    color,
  }));
}

/**
 * MiniWorld copy carrying the combat spark particles (base1 only — the
 * procedural devroom world is shared and particle-free). Pure: the input
 * world is never mutated.
 */
export function withBenchParticles(world: MiniWorld, cx: number, cy: number, cz: number): MiniWorld {
  return { ...world, particles: benchSparkParticles(cx, cy, cz) };
}
