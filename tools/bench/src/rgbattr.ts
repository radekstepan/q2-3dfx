// q2-bench RGB attribution (PERF-1): reproducible BEFORE/AFTER harness for
// PERF-2 (indexed/RGB + parallel RGB) and PERF-3 (reconstruction/pack/gamma).
//
// What it measures, per (resolution, scene, entity-set, mode, workers):
//   - INSTRUMENTED attribution: renderView GEO split via
//     SoftwareRenderer.testMeasurePhases (setup / mark / traverse / cull /
//     cache / project / emit / sort — reused, no renderer changes) + DRAW +
//     alias phases, medians + p95 over N reps. Classic DRAW vs RGB spanfill
//     WITHOUT touching the renderer: the phases.draw counter lumps classic
//     + RGB (frame.ts draws classic always; RGB on top), so RGB_extra =
//     draw(rgbOn) - draw(rgbOff) on the identical scene/camera. Same for the
//     alias phase (RGB twins + seed live there). endFrame(rgbOn) -
//     endFrame(rgbOff) ~= seed + composite (palette expand is the common
//     part). These are documented estimates, not probes.
//   - UNINSTRUMENTED acceptance (the gate input, never a sum of medians):
//     full production frames measured TOGETHER per rep —
//       software: beginFrame+renderView+endFrame (software presents the
//         endFrame color plane directly; there is no scanout stage).
//       rgb serial: beginFrame+renderView+endFrame+resolveFrame (the fused
//         pack→recon→gamma production scanout with the pinned vd_* profile).
//       rgb pooled: beginFrame+renderView+endFrame(pooled resolve kick
//         inside)+pool.flushScanout (Track A parallel scanout into the
//         shared scanout buffers — the Node analogue of the browser
//         resolveDisplayAsync path; falls back to serial resolveFrame,
//         labeled, on kick failure).
//     Serial scanout stays as a LABELED control (`scanoutSerialMs` /
//     `frameSerialMs`, interleaved back-to-back with the production kick on
//     the same live frame so both legs share thermal state).
//   - Legacy stage probes (resolveRGB565 pack vs applyReconstruction2x2 vs
//     applyDisplayGamma on a COPIED buffer) are kept for attribution only
//     and labeled non-production: they run more passes than the fused
//     production path executes.
//   - Hashes: index-plane FNV + color-plane R+G FNV (same scheme as the
//     frame.ts harness: R byte then G byte per pixel) + presented-plane
//     display hash (serial vs pooled scanout parity). Software planes are
//     bit-identical with the RGB flag on or off by construction.
// Modes: serial (workers=0) plus pooled worker configs via
// RGB_BENCH_WORKERS (e.g. "0,1,3,7"); the Node BandWorkerPool runs real RGB
// raster jobs on threads (PERF-2). Fixed cameras: testkit base1Views()
// (time 1.5, fov 90, flat styles) + DEVROOM_CAMERA. Entity sets:
// none (empty, attribution floor), fixed (1 alias + 1 sprite + 1 tracer +
// base1 spark particles), combat (fixed + eye-anchored depthHack viewmodel
// gun + per-frame muzzle/explosion dynamic lights — the representative
// gameplay workload; the live-browser equivalent is play.ts buildAsyncView
// + pumps). Fixed cvars: vd profile gamma 1.3 / dither 1 / 16bit 1 /
// postfilter 1 / bilinear 1 / mipdither 1 / fog 1 / overbright 1 /
// palettetex 1 / maxtexsize 256 / zbits 16 / dithermode 4x4 / reconmode
// 2x2sub+2x2box / rgbmaxdelta 8,8,8.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadBsp } from '@q2/bsp';
import { resetCVars, setCVar, setCVarFromString } from '@q2/config';
import { parseMD2, parsePCX, parseWAL } from '@q2/formats';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import {
  SoftwareRenderer, bspToMiniWorld, createDevroom, BandWorkerPool,
  type BspTexelSource, type FramePhases, type MiniWorld,
  type DynamicLight, type ScanoutBandOptions,
} from '@q2/sw-renderer';
import { base1RefDef, base1Views, machineJson } from '@q2/testkit';
import {
  applyDisplayGamma, applyReconstruction2x2, readVoodooState, resolveRGB565,
  resolveFrame,
  type VoodooState,
} from '@q2/voodoo';

const require = createRequire(process.cwd() + '/');

/**
 * Resolve the built @q2/sw-renderer ESM bundle (worker bootstrap source).
 * Goes through the workspace symlink so no relative-path surgery is needed.
 */
export function swRendererEsmPath(): string {
  const cjs = require.resolve('@q2/sw-renderer');
  const esm = cjs.replace(/index\.js$/, 'index.mjs');
  if (!existsSync(esm)) {
    throw new Error(`@q2/sw-renderer dist ESM bundle missing at ${esm} (run yarn build first)`);
  }
  return esm;
}

export const RGB_ATTR_RESS: Array<[number, number]> = [[320, 240], [640, 480]];
export const RGB_ATTR_SCENES = ['devroom', 'spawn-north', 'trench-east'] as const;
export type RgbAttrScene = (typeof RGB_ATTR_SCENES)[number];
export type RgbAttrEntities = 'none' | 'fixed' | 'combat';
export const RGB_ATTR_ENTS: RgbAttrEntities[] = ['none', 'fixed', 'combat'];
export type RgbAttrMode = 'software' | 'rgb';

/** Fixed vd_* + sw_* profile for every PERF-1 run (serial, voodoo look). */
export function pinPerfCvars(): void {
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

function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  if (data.subarray(0, 4).toString() !== 'PACK') throw new Error('not a pak file');
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len) as ArrayBuffer;
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

export interface RgbAttrWorld {
  world: MiniWorld;
  palette: Uint8Array;
  soldierMd2: ArrayBuffer;
  soldierSkin: { pixels: Uint8Array; width: number; height: number };
  /** Representative viewmodel gun (eye-anchored depthHack, combat set). */
  gunMd2: ArrayBuffer;
  gunSkin: { pixels: Uint8Array; width: number; height: number };
}

/** Load base1.bsp + WAL texels + colormap + soldier MD2/skin + gun MD2/skin (once per process). */
export function loadRgbAttrWorld(pakPath: string): RgbAttrWorld {
  const bsp = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
  const walCache = new Map<string, BspTexelSource | null>();
  const texelFor = (walName: string): BspTexelSource | null => {
    if (walCache.has(walName)) return walCache.get(walName)!;
    let src: BspTexelSource | null = null;
    try {
      const wal = parseWAL(pakReadFile(pakPath, `textures/${walName}.wal`));
      src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
    } catch { src = null; }
    walCache.set(walName, src);
    return src;
  };
  const skin = parsePCX(pakReadFile(pakPath, 'models/monsters/soldier/skin.pcx'));
  const gunSkin = parsePCX(pakReadFile(pakPath, 'models/weapons/v_blast/skin.pcx'));
  return {
    world: bspToMiniWorld(bsp, { texelFor }),
    palette: parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx')).palette,
    soldierMd2: pakReadFile(pakPath, 'models/monsters/soldier/tris.md2'),
    soldierSkin: { pixels: skin.pixels, width: skin.width, height: skin.height },
    gunMd2: pakReadFile(pakPath, 'models/weapons/v_blast/tris.md2'),
    gunSkin: { pixels: gunSkin.pixels, width: gunSkin.width, height: gunSkin.height },
  };
}

/**
 * Fixed entity set, placed relative to the camera so it lands in-frustum on
 * every scene: 1 alias (real soldier MD2), 1 sprite (sp2, soldier skin as the
 * sprite texture), 1 tracer beam across the view. Particles ride in the
 * MiniWorld copy (base1 only — devroom's procedural world is shared).
 * With gun=true also registers the eye-anchored depthHack viewmodel
 * (representative gun path: near-clipped foreground, serial alias RGB).
 */
export function fixedEntities(
  r: SoftwareRenderer, fw: RgbAttrWorld,
  origin: [number, number, number], yawDeg: number, opts: { gun?: boolean } = {},
): Entity[] {
  const yaw = (yawDeg * Math.PI) / 180;
  const fx = Math.cos(yaw), fy = Math.sin(yaw);
  const rx = -fy, ry = fx;
  const [ox, oy, oz] = origin;
  const md2 = parseMD2(fw.soldierMd2.slice(0));
  const mh = r.registerModel({ name: 'soldier', kind: 'md2', data: md2 });
  const sh = r.registerSkinPixels('soldier-skin', fw.soldierSkin.pixels, fw.soldierSkin.width, fw.soldierSkin.height);
  const th = r.registerModel({ name: 'tracer', kind: 'tracer' as unknown as 'sp2', data: null });
  const sx = ox + fx * 48, sy = oy + fy * 48;
  const sp2 = r.registerModel({ name: 'shot-sprite', kind: 'sp2', data: null });
  const out: Entity[] = [
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
  if (opts.gun) {
    const gunMd2 = parseMD2(fw.gunMd2.slice(0));
    const gh = r.registerModel({ name: 'v-blast', kind: 'md2', data: gunMd2 });
    const gs = r.registerSkinPixels('v-blast-skin', fw.gunSkin.pixels, fw.gunSkin.width, fw.gunSkin.height);
    out.push({
      model: gh, origin: new Float32Array([ox, oy, oz]),
      angles: new Float32Array([0, yawDeg, 0]), frame: 0, skin: gs,
      depthHack: true,
    });
  }
  return out;
}

/** Combat set: fixed + viewmodel gun (representative gameplay foreground). */
export function combatEntities(
  r: SoftwareRenderer, fw: RgbAttrWorld,
  origin: [number, number, number], yawDeg: number,
): Entity[] {
  return fixedEntities(r, fw, origin, yawDeg, { gun: true });
}

/**
 * Combat dynamic lights, re-pumped every frame like the live loop
 * (play.ts pumpMuzzleLight/pumpExplosionLights): a muzzle flash at the
 * soldier position + an explosion flash nearby. Expire-then-add mirrors
 * the web pump (stale ttl entries never accumulate).
 */
export function pumpCombatLights(
  r: SoftwareRenderer, origin: [number, number, number], yawDeg: number,
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

/** 12-particle spark cloud around (cx, cy, cz) for the MiniWorld copy. */
function sparkParticles(cx: number, cy: number, cz: number): MiniWorld['particles'] {
  const colors = [8, 70, 200, 231, 250, 180, 33, 99, 150, 210, 240, 15];
  return colors.map((color, i) => ({
    origin: new Float32Array([cx + ((i * 37) % 17) - 8, cy + ((i * 53) % 17) - 8, cz + 10 + ((i * 29) % 25)]),
    color,
  }));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

/** Index-plane FNV-1a (matches the frame.ts harness hashIdx). */
function hashIdx(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Color-plane R+G FNV-1a (matches the frame.ts harness hashColor). */
function hashColorRG(color: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) {
    h ^= color[i]! & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (color[i]! >>> 8) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * VoodooState → Track A band scanout kick params. Same mapping as the web
 * shell's voodooStateToScanoutOpts (apps/web render-workers.ts): numbers
 * only, no per-pixel cvar reads in workers. Duplicated (not imported) so
 * the Node bench never pulls browser modules.
 */
export function scanoutOptsFromState(st: VoodooState): ScanoutBandOptions {
  return {
    gamma: st.gamma,
    dither: st.dither,
    ditherMode: st.dithermode === '2x2' ? 1 : 0,
    postfilter: st.postfilter,
    reconmode: st.reconmode === 'legacy' ? 0 : st.reconmode === '4x4sub+4x1' ? 2 : 1,
    maxR: st.rgbmaxdelta.r | 0,
    maxG: st.rgbmaxdelta.g | 0,
    maxB: st.rgbmaxdelta.b | 0,
    quantise: st.quantise,
  };
}

export interface DistFreshness {
  fresh: boolean;
  distMtimeMs: number;
  newestSrcMtimeMs: number;
  newestSrcFile: string;
}

/** Locate the repo root: the bench runs from dist with an unpredictable cwd
 * (workspace script → tools/bench; turbo → repo root). Probe upward for
 * the built bundle instead of trusting cwd. */
export function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    try {
      if (existsSync(join(dir, 'tools/bench/dist/index.mjs'))) return dir;
    } catch { /* keep climbing */ }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const FRESHNESS_PKGS = [
  '@q2/sw-renderer', '@q2/voodoo', '@q2/testkit',
  '@q2/renderer-api', '@q2/config',
];
/** Extra freshness scope for the playbench consumer (it loads the web shell). */
export const PLAYBENCH_FRESHNESS_PKGS = ['web', '@q2/host'];

/** Newest .ts mtime under a package's src dir (empty when unreadable). */
function newestSrcMtime(srcDir: string): { mtimeMs: number; file: string } {
  let newest = 0;
  let newestFile = '(none)';
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      let st: { mtimeMs: number; isDirectory(): boolean } | null = null;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(name)) continue;
      // Test files never ship to dist — a concurrent test edit must not
      // mark the measured bundle stale.
      if (/\.test\.tsx?$/.test(name)) continue;
      if (st.mtimeMs > newest) { newest = st.mtimeMs; newestFile = p; }
    }
  };
  walk(srcDir);
  return { mtimeMs: newest, file: newestFile };
}
/** Dist-vs-src freshness: the bench runs from dist — a stale dist silently
 * benchmarks old code. For each engine package actually loaded (resolved
 * through the workspace symlinks, so cwd-independent), compares the built
 * bundle mtime against the newest src mtime; callers print a WARN and
 * record it when stale (rebuild first). */
export function distFreshness(extraPkgs: string[] = []): DistFreshness {
  const stale: string[] = [];
  let newestSrcMtimeMs = 0;
  let newestSrcFile = '(none)';
  let distMtimeMs = 0;
  const check = (distFile: string, srcDir: string, label: string): void => {
    let distMtime = 0;
    try {
      distMtime = statSync(distFile).mtimeMs;
    } catch { /* missing dist: stale */ }
    if (distMtime > distMtimeMs) distMtimeMs = distMtime;
    const { mtimeMs, file } = newestSrcMtime(srcDir);
    if (mtimeMs > newestSrcMtimeMs) { newestSrcMtimeMs = mtimeMs; newestSrcFile = file; }
    if (!(distMtime > 0 && distMtime >= mtimeMs)) stale.push(`${label} (dist ${distMtime > 0 ? new Date(distMtime).toISOString() : 'missing'} < src ${file})`);
  };
  for (const pkg of [...FRESHNESS_PKGS, ...extraPkgs]) {
    try {
      const distFile = require.resolve(pkg);
      check(distFile, join(distFile, '..', '..', 'src'), pkg);
    } catch { stale.push(`${pkg} (unresolvable)`); }
  }
  // The bench bundle itself (resolved via the repo-root probe).
  try {
    const root = repoRoot();
    const benchDist = join(root, 'tools/bench/dist/index.mjs');
    check(benchDist, join(root, 'tools/bench/src'), 'bench');
  } catch { stale.push('bench (unresolvable)'); }
  if (stale.length > 0) {
    console.log(`WARN stale dist: ${stale.join('; ')} — rebuild before trusting numbers (yarn build)`);
  }
  return {
    fresh: stale.length === 0,
    distMtimeMs, newestSrcMtimeMs, newestSrcFile,
  };
}

export interface AttrRow {
  scene: string;
  res: string;
  entities: RgbAttrEntities;
  mode: RgbAttrMode;
  workers: number;
  renderViewMs: number;
  renderViewP95: number;
  geoMs: number;
  setup: number; mark: number; traverse: number; cull: number;
  cache: number; project: number; emit: number; sort: number;
  drawMs: number; drawP95: number;
  aliasMs: number;
  endFrameMs: number; endFrameP95: number;
  packMs: number | null; reconMs: number | null; gammaMs: number | null;
  /** Serial fused scanout: resolveFrame on the LIVE frame (labeled control). */
  fusedMs: number | null;
  /**
   * Production scanout per rep (median): pooled flushScanout when a pool is
   * attached and the kick succeeds, else serial resolveFrame. scanoutKind
   * records which ran ('serial' | 'pooled' | 'serial-fallback').
   */
  scanoutMs: number | null;
  scanoutKind: string | null;
  /** Labeled serial-scanout control, interleaved back-to-back per rep. */
  scanoutSerialMs: number | null;
  /** Acceptance metric: full PRODUCTION frame measured TOGETHER per rep. */
  frameMs: number | null;
  frameP95: number | null;
  /** Full frame with the serial scanout control (pooled configs only). */
  frameSerialMs: number | null;
  frameSerialP95: number | null;
  spans: number; pixels: number; overdraw: number;
  idxHash: string; colorHash: string;
  /** Presented-plane hash: serial resolve display vs pooled scanout buffers. */
  displayHash: string | null;
  displaySerialHash: string | null;
}

export async function runAttrConfig(
  fw: RgbAttrWorld, scene: RgbAttrScene, W: number, H: number,
  ent: RgbAttrEntities, mode: RgbAttrMode, workers: number, warmup: number, reps: number,
): Promise<AttrRow> {
  pinPerfCvars();
  const rgb = mode === 'rgb';
  const combat = ent === 'combat';
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(fw.palette);
  // The RGB switch is a shared module flag: set it explicitly EVERY config
  // (a previous rgb config would otherwise leak into the next "software"
  // row — caught by the idx/color cross-check below).
  r.setRGBWorldEnabled(rgb);
  let pool: BandWorkerPool | null = null;
  if (workers > 0) {
    setCVar('sw_workers', Math.min(8, workers + 1));
    setCVar('sw_accum', 1);
    r.syncWorkersFromCvar();
    pool = BandWorkerPool.create(workers, W, H, { indexJsPath: swRendererEsmPath() });
    if (!pool) throw new Error('pool unavailable (need worker_threads + SAB + Atomics.wait)');
    r.attachWorkerPool(pool);
  }

  let view, worldData: MiniWorld, worldName: string;
  let entOrigin: [number, number, number], entYaw: number;
  if (scene === 'devroom') {
    worldData = createDevroom();
    worldName = 'devroom';
    entOrigin = [-168, 0, 136];
    entYaw = 0;
    view = {
      origin: new Float32Array(entOrigin),
      angles: new Float32Array([0, 0, 0]),
      fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
  } else {
    const bv = base1Views().find((v) => v.label === scene)!;
    view = base1RefDef(bv);
    worldName = 'base1';
    entOrigin = bv.origin;
    entYaw = bv.angles[1]!;
    worldData = fw.world;
  }
  const entities: Entity[] = ent === 'none' ? [] : ent === 'fixed'
    ? fixedEntities(r, fw, entOrigin, entYaw)
    : combatEntities(r, fw, entOrigin, entYaw);
  let data: MiniWorld = worldData;
  if (ent !== 'none' && scene !== 'devroom') {
    const [ox, oy, oz] = entOrigin;
    const yaw = (entYaw * Math.PI) / 180;
    data = {
      ...worldData,
      particles: sparkParticles(ox + Math.cos(yaw) * 48, oy + Math.sin(yaw) * 48, oz - 20),
    };
  }
  const worldArg = { name: worldName, data };
  const pump = (): void => { if (combat) pumpCombatLights(r, entOrigin, entYaw); };

  for (let i = 0; i < warmup; i++) {
    pump();
    r.beginFrame(); r.renderView(view, worldArg, entities); r.endFrame();
  }
  const acc: Record<keyof FramePhases, number[]> = {
    setup: [], mark: [], traverse: [], cull: [], cache: [],
    project: [], emit: [], sort: [], draw: [], alias: [],
  };
  const rv: number[] = [];
  const ef: number[] = [];
  let spans = 0, pixels = 0, overdraw = 0;
  for (let i = 0; i < reps; i++) {
    // Wall renderView with hrtime (stats.ms is Date.now-coarse): covers the
    // beginFrame + renderView inside testMeasurePhases; endFrame timed below.
    // INSTRUMENTED attribution — the acceptance metric is frameMs below.
    pump();
    const rt = process.hrtime.bigint();
    const m = r.testMeasurePhases(view, worldArg, entities);
    rv.push(Number(process.hrtime.bigint() - rt) / 1e6);
    spans = m.stats.spans; pixels = m.stats.pixels; overdraw = m.stats.overdraw;
    for (const k of Object.keys(acc) as (keyof FramePhases)[]) acc[k]!.push(m.phases[k]);
    const t = process.hrtime.bigint();
    r.endFrame();
    ef.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const med = (xs: number[]): number => median(xs);
  const medAcc = (k: keyof FramePhases): number => median(acc[k]);
  const geo = medAcc('setup') + medAcc('mark') + medAcc('traverse') + medAcc('cull') +
    medAcc('cache') + medAcc('project') + medAcc('emit') + medAcc('sort');

  // Voodoo resolve split on the produced frame (harness-level probe): the
  // endFrame above already composited RGB565-expanded pixels into color, so
  // resolve from that plane with the pinned vd profile (gamma 1 pack, then
  // recon, then display gamma). NON-PRODUCTION: the shipped pipeline runs
  // the fused resolveFrame (see fusedMs/scanoutMs/frameMs); this split runs
  // more passes on a copied buffer and is attribution only.
  let packMs: number | null = null, reconMs: number | null = null, gammaMs: number | null = null;
  if (rgb) {
    const st = readVoodooState();
    const src = r.getFramebuffer().color.slice();
    const dst565 = new Uint16Array(W * H);
    const display = new Uint32Array(W * H);
    const pk: number[] = [], rc: number[] = [], gm: number[] = [];
    for (let i = 0; i < reps; i++) {
      let t = process.hrtime.bigint();
      resolveRGB565(src, dst565, W, H, { gamma: 1, dither: st.dither, ditherMode: st.dithermode, quantise: st.quantise });
      pk.push(Number(process.hrtime.bigint() - t) / 1e6);
      t = process.hrtime.bigint();
      applyReconstruction2x2(dst565, display, W, H, st.rgbmaxdelta, st.dither ? '2x2' : null);
      rc.push(Number(process.hrtime.bigint() - t) / 1e6);
      t = process.hrtime.bigint();
      applyDisplayGamma(display, W, H, st.gamma);
      gm.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    packMs = med(pk); reconMs = med(rc); gammaMs = med(gm);
  }

  // Production scanout + full-frame acceptance (UNINSTRUMENTED: measured
  // together per rep, never summed medians).
  //   software: frame = begin+render+end (the color plane IS the presented
  //     frame; there is no scanout stage in the software path).
  //   rgb serial: frame = begin+render+end+resolveFrame (fused production).
  //   rgb pooled: frame = begin+render+end(pooled resolve kick)+flushScanout
  //     (Track A parallel scanout — the Node analogue of the browser
  //     resolveDisplayAsync path). The serial resolveFrame stays as a
  //     LABELED control, interleaved back-to-back per rep.
  let fusedMs: number | null = null;
  let scanoutMs: number | null = null, scanoutKind: string | null = null;
  let scanoutSerialMs: number | null = null;
  let frameMs: number | null = null, frameP95: number | null = null;
  let frameSerialMs: number | null = null, frameSerialP95: number | null = null;
  let displayHash: string | null = null, displaySerialHash: string | null = null;
  if (!rgb) {
    const fr: number[] = [];
    for (let i = 0; i < reps; i++) {
      pump();
      const t = process.hrtime.bigint();
      r.beginFrame();
      r.renderView(view, worldArg, entities);
      r.endFrame();
      fr.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    frameMs = med(fr); frameP95 = p95(fr);
  } else {
    const st = readVoodooState();
    const opts = scanoutOptsFromState(st);
    const serialDst = new Uint16Array(W * H);
    const serialDisp = new Uint32Array(W * H);
    // Serial fused control (labeled, always available).
    const fs: number[] = [];
    for (let i = 0; i < reps; i++) {
      const live = r.getFramebuffer().color;
      const t = process.hrtime.bigint();
      resolveFrame(live, serialDst, serialDisp, W, H, st);
      fs.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    fusedMs = med(fs);
    displaySerialHash = hashColorRG(serialDisp);
    if (pool) {
      // PRODUCTION pooled scanout, interleaved A/B with the serial control
      // on the same live frame (shared thermal state per rep).
      const prod: number[] = [], ctrl: number[] = [];
      let pooledOk = true;
      let pooledDisp: Uint32Array | null = null;
      for (let i = 0; i < reps; i++) {
        pump();
        r.beginFrame();
        r.renderView(view, worldArg, entities);
        r.endFrame();
        const live = r.getFramebuffer().color;
        let t = process.hrtime.bigint();
        const ok = pool.flushScanout(opts);
        prod.push(Number(process.hrtime.bigint() - t) / 1e6);
        if (!ok) pooledOk = false;
        t = process.hrtime.bigint();
        resolveFrame(live, serialDst, serialDisp, W, H, st);
        ctrl.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      if (pooledOk) {
        scanoutKind = 'pooled';
        scanoutMs = med(prod);
        scanoutSerialMs = med(ctrl);
        pooledDisp = pool.scanoutPlanes.scanDisplay.slice(0, W * H);
        displayHash = hashColorRG(pooledDisp);
      } else {
        // Kick failed: production falls back to serial (identical by
        // contract) — labeled, not silent.
        scanoutKind = 'serial-fallback';
        scanoutMs = med(ctrl);
        scanoutSerialMs = med(ctrl);
        displayHash = hashColorRG(serialDisp);
      }
      // Full production frames (begin+render+end+pooled scanout together).
      const fr: number[] = [];
      for (let i = 0; i < reps; i++) {
        pump();
        const t = process.hrtime.bigint();
        r.beginFrame();
        r.renderView(view, worldArg, entities);
        r.endFrame();
        if (!pool.flushScanout(opts)) {
          resolveFrame(r.getFramebuffer().color, serialDst, serialDisp, W, H, st);
        }
        fr.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      frameMs = med(fr); frameP95 = p95(fr);
      // Full frames with the serial control (same workload, labeled).
      const frs: number[] = [];
      for (let i = 0; i < reps; i++) {
        pump();
        const t = process.hrtime.bigint();
        r.beginFrame();
        r.renderView(view, worldArg, entities);
        r.endFrame();
        resolveFrame(r.getFramebuffer().color, serialDst, serialDisp, W, H, st);
        frs.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      frameSerialMs = med(frs); frameSerialP95 = p95(frs);
    } else {
      // Serial production = the fused control itself.
      scanoutKind = 'serial';
      scanoutMs = med(fs);
      scanoutSerialMs = med(fs);
      displayHash = hashColorRG(serialDisp);
      const fr: number[] = [];
      for (let i = 0; i < reps; i++) {
        pump();
        const t = process.hrtime.bigint();
        r.beginFrame();
        r.renderView(view, worldArg, entities);
        r.endFrame();
        resolveFrame(r.getFramebuffer().color, serialDst, serialDisp, W, H, st);
        fr.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      frameMs = med(fr); frameP95 = p95(fr);
    }
  }

  if (pool) await pool.dispose();

  const g = r.getFramebuffer();
  const row: AttrRow = {
    scene, res: `${W}x${H}`, entities: ent, mode, workers,
    renderViewMs: med(rv), renderViewP95: p95(rv), geoMs: geo,
    setup: medAcc('setup'), mark: medAcc('mark'), traverse: medAcc('traverse'),
    cull: medAcc('cull'), cache: medAcc('cache'), project: medAcc('project'),
    emit: medAcc('emit'), sort: medAcc('sort'),
    drawMs: medAcc('draw'), drawP95: p95(acc.draw), aliasMs: medAcc('alias'),
    endFrameMs: med(ef), endFrameP95: p95(ef),
    packMs, reconMs, gammaMs, fusedMs,
    scanoutMs, scanoutKind, scanoutSerialMs,
    frameMs, frameP95, frameSerialMs, frameSerialP95,
    spans, pixels, overdraw,
    idxHash: hashIdx(g.index!), colorHash: hashColorRG(g.color),
    displayHash, displaySerialHash,
  };
  const rs = (v: number | null): string => v === null ? '—' : v.toFixed(2);
  console.log(
    `${row.scene} ${row.res} ent=${ent} ${mode} w=${workers}: ` +
    `renderView=${row.renderViewMs.toFixed(2)}(p95 ${row.renderViewP95.toFixed(2)}) ` +
    `GEO=${geo.toFixed(2)} DRAW=${row.drawMs.toFixed(2)}(p95 ${row.drawP95.toFixed(2)}) ` +
    `alias=${row.aliasMs.toFixed(2)} endFrame=${row.endFrameMs.toFixed(2)}(p95 ${row.endFrameP95.toFixed(2)}) ` +
    `pack=${rs(packMs)} recon=${rs(reconMs)} gamma=${rs(gammaMs)} fused=${rs(fusedMs)} ` +
    `scanout[${row.scanoutKind ?? 'n/a'}]=${rs(scanoutMs)} serialCtl=${rs(scanoutSerialMs)} ` +
    `frame=${rs(frameMs)}(p95 ${rs(frameP95)}) frameSerial=${rs(frameSerialMs)}(p95 ${rs(frameSerialP95)}) ` +
    `spans=${spans} px=${pixels} ov=${overdraw.toFixed(2)} ` +
    `idx=${row.idxHash} color=${row.colorHash} disp=${row.displayHash ?? '—'}`,
  );
  return row;
}

export interface RgbAttrOptions {
  warmup?: number;
  reps?: number;
  scenes?: RgbAttrScene[];
  entities?: RgbAttrEntities[];
  /** Worker configs to run (0 = serial). Env RGB_BENCH_WORKERS, e.g. "0,1,3,7". */
  workers?: number[];
}

/** Parse RGB_BENCH_WORKERS ("0,1,3,7") into worker counts. */
export function rgbBenchWorkers(): number[] {
  const raw = process.env.RGB_BENCH_WORKERS ?? '0';
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const n = Math.floor(Number(part));
    if (Number.isFinite(n) && n >= 0 && n <= 8 && !out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : [0];
}

/** Parse RGB_BENCH_ENTS ("none,fixed,combat") into entity sets. */
export function rgbBenchEnts(): RgbAttrEntities[] {
  const raw = process.env.RGB_BENCH_ENTS ?? 'none,fixed,combat';
  const out: RgbAttrEntities[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim() as RgbAttrEntities;
    if ((RGB_ATTR_ENTS as string[]).includes(s) && !out.includes(s)) out.push(s);
  }
  return out.length > 0 ? out : [...RGB_ATTR_ENTS];
}

/** Full PERF-1 run: resolutions × scenes × entity sets × software/RGB × workers. */
export async function runRgbAttr(pakPath: string, opts: RgbAttrOptions = {}): Promise<{ rows: AttrRow[]; machine: unknown; commit: string }> {
  const warmup = opts.warmup ?? 3;
  const reps = opts.reps ?? 10;
  const scenes = opts.scenes ?? [...RGB_ATTR_SCENES];
  const ents = opts.entities ?? rgbBenchEnts();
  const workerSets = opts.workers ?? rgbBenchWorkers();
  const fresh = distFreshness();
  if (!fresh.fresh) {
    console.log(
      `WARN stale dist: tools/bench/dist older (${new Date(fresh.distMtimeMs).toISOString()}) than ` +
      `${fresh.newestSrcFile} (${new Date(fresh.newestSrcMtimeMs).toISOString()}) — rebuild before trusting numbers (yarn build)`,
    );
  }
  const fw = loadRgbAttrWorld(pakPath);
  console.log(`rgb attribution: base1 surfaces=${fw.world.surfaces.length} warmup=${warmup} reps=${reps} workers=${workerSets.join(',')} ents=${ents.join(',')}`);
  console.log('cvars: vd_gamma=1.3 vd_dither=1 vd_16bit=1 vd_postfilter=1 vd_bilinear=1 vd_mipdither=1 vd_fog=1 vd_overbright=1 vd_palettetex=1 vd_maxtexsize=256 vd_zbits=16 vd_dithermode=4x4 vd_reconmode=2x2sub+2x2box vd_rgbmaxdelta=8,8,8');
  const rows: AttrRow[] = [];
  for (const [W, H] of RGB_ATTR_RESS) {
    for (const scene of scenes) {
      for (const ent of ents) {
        for (const mode of ['software', 'rgb'] as const) {
          for (const workers of workerSets) {
            rows.push(await runAttrConfig(fw, scene, W, H, ent, mode, workers, warmup, reps));
          }
        }
      }
    }
  }
  let commit = 'unknown';
  try {
    const cp = await import('child_process');
    commit = cp.execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch { /* offline */ }
  const machine = await machineJson().catch(() => ({ node: process.version }));
  // Cross-mode self-check per (scene, res, entities, workers): software
  // planes must be bit-identical with the RGB flag on or off (idx equal);
  // the RGB composite must change at least one pixel (color differs) or
  // the overlay drew nothing and the row is not a real RGB run.
  const byKey = new Map<string, AttrRow[]>();
  for (const row of rows) {
    const k = `${row.scene} ${row.res} ent=${row.entities} w=${row.workers}`;
    const arr = byKey.get(k);
    if (arr) arr.push(row);
    else byKey.set(k, [row]);
  }
  for (const [k, pair] of byKey) {
    const a = pair.find((r) => r.mode === 'software')!;
    const b = pair.find((r) => r.mode === 'rgb')!;
    const idxOk = a.idxHash === b.idxHash;
    const colorDiff = a.colorHash !== b.colorHash;
    console.log(
      `check ${k}: ` +
      `idx software=rgb ${idxOk ? 'IDENTICAL' : `MISMATCH ${a.idxHash} vs ${b.idxHash}`} / ` +
      `color ${colorDiff ? 'DIFFERS (overlay drew)' : 'IDENTICAL (overlay drew nothing?)'}`,
    );
  }
  // Worker-vs-serial equivalence per (scene, res, entities, mode), and
  // pooled-vs-serial scanout parity on the presented plane.
  const serialByKey = new Map<string, AttrRow>();
  for (const row of rows) {
    if (row.workers === 0) serialByKey.set(`${row.scene} ${row.res} ent=${row.entities} ${row.mode}`, row);
  }
  for (const row of rows) {
    if (row.workers === 0) continue;
    const s = serialByKey.get(`${row.scene} ${row.res} ent=${row.entities} ${row.mode}`);
    if (!s) continue;
    const ok = s.idxHash === row.idxHash && s.colorHash === row.colorHash;
    const dispOk = s.displaySerialHash !== null && row.displaySerialHash !== null
      ? s.displaySerialHash === row.displaySerialHash
      : true;
    const poolOk = row.displayHash !== null && row.displaySerialHash !== null
      ? row.displayHash === row.displaySerialHash
      : true;
    console.log(
      `workers ${row.scene} ${row.res} ent=${row.entities} ${row.mode} w=${row.workers}: ` +
      `${ok ? 'IDENTICAL to serial' : `MISMATCH vs serial idx ${s.idxHash}/${row.idxHash} color ${s.colorHash}/${row.colorHash}`} / ` +
      `scanout pooled=serial ${poolOk ? 'IDENTICAL' : `MISMATCH ${row.displayHash}/${row.displaySerialHash}`} / ` +
      `serial-scanout vs w=0 ${dispOk ? 'IDENTICAL' : 'MISMATCH'}`,
    );
  }
  console.log(JSON.stringify({ machine, node: process.version, commit, warmup, reps, workerSets, ents, distFresh: fresh.fresh }, null, 2));
  return { rows, machine, commit };
}
