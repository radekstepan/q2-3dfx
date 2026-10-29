// q2-bench frame attribution (M8.1 job §1): geometry vs spanfill vs
// resolve on real base1 views, plus pooled A/B. Q2_PAK-gated (throws a
// clear error without it, like the asset tests). Methodology recreated
// from the gitignored bench.mjs era: medians over repeats, best-of-N
// pooling comparison, phase split via SoftwareRenderer.testMeasurePhases.
//
// INSTRUMENTED attribution (attributeView: testMeasurePhases medians) vs
// UNINSTRUMENTED totals (poolCompareView: whole begin+render+end loops
// timed together per rep — never summed medians). Software path only;
// the RGB production frame (fused resolveFrame / pooled flushScanout)
// lives in rgbattr.ts.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import { machineJson, hashColorFull } from '@q2/testkit';
import {
  SoftwareRenderer, BandWorkerPool, bspToMiniWorld,
  SW_WORKERS_CVAR, SW_ACCUM_CVAR,
  type BspTexelSource, type FramePhases,
} from '@q2/sw-renderer';
import { distFreshness } from './rgbattr.js';

export interface AttribView {
  origin: [number, number, number];
  angles: [number, number, number];
  label: string;
}

export const BASE1_VIEWS: AttribView[] = [
  { origin: [128, -320, 54], angles: [0, 90, 0], label: 'spawn-north' },
  { origin: [128, -320, 54], angles: [0, 180, 0], label: 'spawn-west' },
  { origin: [-944, 1552, 0], angles: [0, 180, 0], label: 'lowroad-west' },
  { origin: [-1648, 1544, 16], angles: [0, 0, 0], label: 'trench-east' },
];

const require = createRequire(process.cwd() + '/');

/**
 * Resolve the built @q2/sw-renderer ESM bundle (worker bootstrap source).
 * Goes through the workspace symlink (`main` is the CJS bundle; the ESM
 * bundle sits alongside it) so no relative-path surgery is needed.
 * NOTE: `require` is used for PATH RESOLUTION ONLY (require.resolve never
 * loads the module). Loading the CJS bundle would instantiate the second
 * @q2/config store (see packages/testkit config-store.test.ts) — workers
 * and all bench code must stay on the ESM graph (index.mjs below).
 */
export function swRendererEsmPath(): string {
  const cjs = require.resolve('@q2/sw-renderer');
  const esm = cjs.replace(/index\.js$/, 'index.mjs');
  if (!existsSync(esm)) {
    throw new Error(`@q2/sw-renderer dist ESM bundle missing at ${esm} (run yarn build first)`);
  }
  return esm;
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

export interface FrameWorld {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  world: any;
  palette: Uint8Array;
}

/** Load base1.bsp + WAL texels + colormap palette (the M8.1 bench scene). */
export function loadBase1World(pakPath: string): FrameWorld {
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
  return { world: bspToMiniWorld(bsp, { texelFor }), palette: parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx')).palette };
}

export interface PhaseRow {
  view: string;
  renderViewMs: number;
  resolveMs: number;
  setup: number;
  mark: number;
  traverse: number;
  cull: number;
  cache: number;
  project: number;
  emit: number;
  sort: number;
  draw: number;
  alias: number;
  spans: number;
  pixels: number;
  overdraw: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

/**
 * Phase attribution for one view (classic single-threaded path): armed
 * testMeasurePhases medians + hrtime endFrame resolve. Prints one row.
 */
export function attributeView(
  fw: FrameWorld, view: AttribView, W = 640, H = 480, iters = 10,
): PhaseRow {
  resetCVars();
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(fw.palette);
  const refdef = {
    origin: new Float32Array(view.origin),
    angles: new Float32Array(view.angles),
    fovX: 90, time: 1.5,
    lightStyles: new Float32Array(256).fill(1),
  };
  const worldArg = { name: 'base1', data: fw.world };
  for (let i = 0; i < 3; i++) { r.beginFrame(); r.renderView(refdef, worldArg, []); r.endFrame(); }
  const acc: Record<keyof FramePhases, number[]> = {
    setup: [], mark: [], traverse: [], cull: [], cache: [],
    project: [], emit: [], sort: [], draw: [], alias: [],
  };
  const rv: number[] = [];
  const ef: number[] = [];
  let spans = 0, pixels = 0, overdraw = 0;
  for (let i = 0; i < iters; i++) {
    const m = r.testMeasurePhases(refdef, worldArg, []);
    spans = m.stats.spans; pixels = m.stats.pixels; overdraw = m.stats.overdraw;
    rv.push(m.stats.ms);
    for (const k of Object.keys(acc) as (keyof FramePhases)[]) acc[k]!.push(m.phases[k]);
    const t = process.hrtime.bigint();
    r.endFrame();
    ef.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const med = (xs: number[]): number => median(xs);
  const row: PhaseRow = {
    view: view.label,
    renderViewMs: med(rv),
    resolveMs: med(ef),
    setup: med(acc.setup), mark: med(acc.mark), traverse: med(acc.traverse),
    cull: med(acc.cull), cache: med(acc.cache), project: med(acc.project),
    emit: med(acc.emit), sort: med(acc.sort), draw: med(acc.draw), alias: med(acc.alias),
    spans, pixels, overdraw,
  };
  const geo = row.setup + row.mark + row.traverse + row.cull + row.cache + row.project + row.emit + row.sort;
  console.log(
    `${row.view}: renderView=${row.renderViewMs.toFixed(2)}ms resolve=${row.resolveMs.toFixed(2)}ms ` +
    `GEO(sum-of-medians,diagnostic)=${geo.toFixed(2)} (setup ${row.setup.toFixed(2)} mark ${row.mark.toFixed(2)} trav ${row.traverse.toFixed(2)} ` +
    `cull ${row.cull.toFixed(2)} cache ${row.cache.toFixed(2)} proj ${row.project.toFixed(2)} ` +
    `emit ${row.emit.toFixed(2)} sort ${row.sort.toFixed(2)}) DRAW=${row.draw.toFixed(2)} alias=${row.alias.toFixed(2)}(fg-serial) ` +
    `spans=${spans} px=${pixels} overdraw=${overdraw.toFixed(2)}`,
  );
  return row;
}

export interface PoolRow {
  view: string;
  mode: string;
  ms: number;
  idxHash: string;
  colorHash: string;
  /** Full-RGBA authority (the R+G colorHash is blind to blue/alpha). */
  colorFull: string;
}

/** Pooled A/B for one view: classic vs per-batch vs frame-accum (pools disposed per mode). */
export async function poolCompareView(
  fw: FrameWorld, view: AttribView, workers: number, W = 640, H = 480, iters = 10,
): Promise<PoolRow[]> {
  const out: PoolRow[] = [];
  for (const mode of ['classic', 'pool-batch', 'pool-accum'] as const) {
    resetCVars();
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(fw.palette);
    let pool: BandWorkerPool | null = null;
    if (mode !== 'classic') {
      setCVar(SW_WORKERS_CVAR, 4);
      setCVar(SW_ACCUM_CVAR, mode === 'pool-accum' ? 1 : 0);
      r.syncWorkersFromCvar();
      pool = BandWorkerPool.create(workers, W, H, { indexJsPath: swRendererEsmPath() });
      if (!pool) throw new Error('pool unavailable (need worker_threads + SAB + Atomics.wait)');
      r.attachWorkerPool(pool);
    }
    const refdef = {
      origin: new Float32Array(view.origin),
      angles: new Float32Array(view.angles),
      fovX: 90, time: 1.5,
      lightStyles: new Float32Array(256).fill(1),
    };
    const worldArg = { name: 'base1', data: fw.world };
    for (let i = 0; i < 5; i++) { r.beginFrame(); r.renderView(refdef, worldArg, []); r.endFrame(); }
    const times: number[] = [];
    for (let rep = 0; rep < 3; rep++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < iters; i++) { r.beginFrame(); r.renderView(refdef, worldArg, []); r.endFrame(); }
      times.push(Number(process.hrtime.bigint() - t0) / 1e6 / iters);
    }
    const g = r.getFramebuffer();
    out.push({
      view: view.label, mode, ms: median(times),
      idxHash: hashIdx(g.index!), colorHash: hashColor(g.color), colorFull: hashColorFull(g.color),
    });
    if (pool) await pool.dispose();
  }
  for (const row of out) {
    console.log(`${row.view} ${row.mode}: ${row.ms.toFixed(2)}ms idx=${row.idxHash} color=${row.colorHash} full=${row.colorFull}`);
  }
  return out;
}

function hashIdx(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function hashColor(color: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) {
    h ^= color[i]! & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (color[i]! >>> 8) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Full M8.1 bench: attribution for every view + pooled A/B at spawn-north. */
export async function runFrameBench(pakPath: string, workers = 5): Promise<void> {
  const fw = loadBase1World(pakPath);
  console.log(`frame attribution (classic): base1 surfaces=${fw.world.surfaces.length}`);
  for (const v of BASE1_VIEWS) attributeView(fw, v);
  console.log(`pooled A/B (workers=${workers}): spawn-north`);
  await poolCompareView(fw, BASE1_VIEWS[0]!, workers);
  let commit = 'unknown';
  try {
    const cp = await import('child_process');
    commit = cp.execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch { /* offline */ }
  const machine = await machineJson().catch(() => ({ node: process.version }));
  const fresh = distFreshness();
  if (!fresh.fresh) {
    console.log(
      `WARN stale dist: tools/bench/dist older than ${fresh.newestSrcFile} — rebuild before trusting numbers (yarn build)`,
    );
  }
  console.log(JSON.stringify({ machine, node: process.version, commit, workers, distFresh: fresh.fresh }, null, 2));
}
