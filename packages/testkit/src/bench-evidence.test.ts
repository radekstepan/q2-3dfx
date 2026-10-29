// @q2/testkit — PERF-NEXT-1 lane-B evidence: deterministic workloads +
// provenance + full-channel frame evidence.
//
// Asset-free sections run everywhere (no Q2_PAK). Real-asset sections are
// Q2_PAK-gated and skip cleanly without assets. Nothing here is timing
// sensitive: budgets live in tools/bench acceptance, never in vitest.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'node:module';
import { existsSync } from 'fs';
import { NullRefresh, createFramebuffer, devroomWorld } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import { SoftwareRenderer, setRGBWorldEnabled, type BandWorkerPool } from '@q2/sw-renderer';
import {
  BENCH_ACCEPT_HEIGHT,
  BENCH_ACCEPT_WIDTH,
  BENCH_DIAG_HEIGHT,
  BENCH_DIAG_WIDTH,
  BENCH_FIDELITY_CVARS,
  BENCH_WORKLOADS,
  BENCH_WORKER_SWEEP,
  BENCH_YAW_STEP_DEG,
  benchEntitiesFor,
  benchSpawnOrigin,
  benchSpawnYaw,
  benchSpawnView,
  benchViewFor,
  combatBenchEntities,
  fidelityCvarSnapshot,
  fidelityProfileMatches,
  fixedBenchEntities,
  isAcceptanceResolution,
  isDiagnosticResolution,
  loadBenchWorld,
  normalizeWorkerSweep,
  pinBenchCvars,
  pumpBenchLights,
  withBenchParticles,
} from './bench-workloads.js';
import {
  fnvColorFull,
  fnvIndex,
  formatProductionEvidence,
  measureProductionFrames,
} from './frame-evidence.js';
import {
  coerceBrowserEvidence,
  describeRuntime,
  formatBrowserEvidence,
  isBrowserFrameStats,
} from './browser-evidence.js';
import {
  compareFreshness,
  formatProvenance,
  gitCommitHash,
  pakFileStat,
  pakIdentity,
  pakIdentityFromBytes,
  recordProvenance,
} from './provenance.js';
import { hashColorFull, hashFrame } from './index.js';

const Q2_PAK = process.env.Q2_PAK;

// --- Asset-free: sweep / resolutions / views --------------------------------

describe('bench workloads (asset-free)', () => {
  it('worker sweep parses env specs, clamps and dedupes', () => {
    expect(normalizeWorkerSweep('0,1,3,7')).toEqual([0, 1, 3, 7]);
    expect(normalizeWorkerSweep('7,7,3')).toEqual([7, 3]);
    expect(normalizeWorkerSweep('0,99,-1,x')).toEqual([0]);
    expect(normalizeWorkerSweep('')).toEqual(BENCH_WORKER_SWEEP);
    expect(normalizeWorkerSweep(undefined)).toEqual(BENCH_WORKER_SWEEP);
    expect(BENCH_WORKER_SWEEP).toEqual([0, 1, 3, 7]);
  });

  it('acceptance is 640x480; 320x240 is diagnostic only', () => {
    expect([BENCH_ACCEPT_WIDTH, BENCH_ACCEPT_HEIGHT]).toEqual([640, 480]);
    expect([BENCH_DIAG_WIDTH, BENCH_DIAG_HEIGHT]).toEqual([320, 240]);
    expect(isAcceptanceResolution(640, 480)).toBe(true);
    expect(isAcceptanceResolution(320, 240)).toBe(false);
    expect(isDiagnosticResolution(320, 240)).toBe(true);
    expect(isDiagnosticResolution(640, 480)).toBe(false);
  });

  it('stationary/combat hold the fixed camera; moving is a pure function of rep', () => {
    const s0 = benchViewFor('stationary', 0);
    const s5 = benchViewFor('stationary', 5);
    expect(Array.from(s0.angles as ArrayLike<number>)).toEqual(Array.from(s5.angles as ArrayLike<number>));
    const c0 = benchViewFor('combat', 3);
    expect(Array.from(c0.angles as ArrayLike<number>)).toEqual(Array.from(s0.angles as ArrayLike<number>));
    const m0 = benchViewFor('moving', 0);
    const m1 = benchViewFor('moving', 1);
    expect(Array.from(m0.angles as ArrayLike<number>)).toEqual(Array.from(s0.angles as ArrayLike<number>));
    const yaw = (v: unknown): number => (v as Float32Array)[1]!;
    expect(yaw(m1.angles)).toBeCloseTo(yaw(m0.angles) + BENCH_YAW_STEP_DEG, 10);
    // Same (workload, rep) twice → identical RefDef (comparable hashes).
    const again = benchViewFor('moving', 1);
    expect(yaw(again.angles)).toBe(yaw(m1.angles));
    expect(BENCH_WORKLOADS).toEqual(['stationary', 'combat', 'moving']);
  });

  it('spawn anchor matches the shared base1 spawn-north view', () => {
    const v = benchSpawnView();
    expect(Array.from(v.origin as ArrayLike<number>)).toEqual([128, -320, 54]);
    expect(benchSpawnOrigin()).toEqual([128, -320, 54]);
    expect(benchSpawnYaw()).toBe(90);
  });

  it('fidelity profile pins and snapshots exactly', () => {
    pinBenchCvars();
    try {
      expect(fidelityProfileMatches()).toBe(true);
      expect(fidelityCvarSnapshot()).toEqual(BENCH_FIDELITY_CVARS);
      setCVar('vd_gamma', 2.2);
      expect(fidelityProfileMatches()).toBe(false);
    } finally {
      resetCVars();
    }
  });
});

// --- Asset-free: hash duplicates match the canonical exports -----------------

describe('frame-evidence hashes (asset-free)', () => {
  it('fnvIndex/fnvColorFull equal index.ts hashFrame/hashColorFull', () => {
    const idx = new Uint8Array([0, 1, 2, 127, 255, 16, 32]);
    const color = new Uint32Array([0xff000000, 0xff010203, 0x80123456, 0x00000000, 0xffffffff]);
    expect(fnvIndex(idx)).toBe(hashFrame(new Uint32Array(idx)));
    expect(fnvColorFull(color)).toBe(hashColorFull(color));
    expect(fnvColorFull(color)).toMatch(/^[0-9a-f]{8}$/);
  });
});

// --- Asset-free: provenance ---------------------------------------------------

function syntheticPak(): ArrayBuffer {
  const names = ['maps/base1.bsp', 'pics/colormap.pcx'];
  const dirlen = names.length * 64;
  const buf = new Uint8Array(12 + dirlen);
  buf.set([80, 65, 67, 75], 0); // PACK
  const view = new DataView(buf.buffer);
  view.setUint32(4, 12, true);
  view.setUint32(8, dirlen, true);
  names.forEach((n, i) => {
    const off = 12 + i * 64;
    for (let c = 0; c < n.length; c++) buf[off + c] = n.charCodeAt(c);
    view.setUint32(off + 56, 100 + i, true);
    view.setUint32(off + 60, 10 + i, true);
  });
  return buf.buffer as ArrayBuffer;
}

describe('provenance (asset-free)', () => {
  it('identifies a pak from bytes without embedding it', () => {
    const id = pakIdentityFromBytes(syntheticPak(), 'fake.pak');
    expect(id.path).toBe('fake.pak');
    expect(id.bytes).toBe(12 + 128);
    expect(id.entries).toBe(2);
    expect(id.headerHash).toMatch(/^[0-9a-f]{8}$/);
    expect(() => pakIdentityFromBytes(new ArrayBuffer(4))).toThrow();
  });

  it('pakIdentity degrades to null without bytes or path', async () => {
    expect(await pakIdentity(null, null)).toBeNull();
    expect(await pakFileStat('/nonexistent/pak0.pak')).toBeNull();
  });

  it('compareFreshness flags stale dists (pure)', () => {
    const fresh = compareFreshness(200, [{ file: 'a.ts', mtimeMs: 100 }]);
    expect(fresh.fresh).toBe(true);
    const stale = compareFreshness(50, [{ file: 'a.ts', mtimeMs: 100 }]);
    expect(stale.fresh).toBe(false);
    expect(stale.stale).toEqual(['a.ts']);
  });

  it('git commit resolves to a short hash or unknown (never throws)', async () => {
    const c = await gitCommitHash();
    expect(c).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
  });

  it('recordProvenance embeds cvars + commit, never the pak', async () => {
    pinBenchCvars();
    try {
      const p = await recordProvenance({ pakBytes: syntheticPak(), pakPath: 'fake.pak' });
      expect(p.commit).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
      expect(p.cvars).toEqual(BENCH_FIDELITY_CVARS);
      expect(p.pak?.entries).toBe(2);
      expect(JSON.stringify(p)).not.toContain('maps/base1.bsp\0');
      const line = formatProvenance(p);
      expect(line).toContain(`commit=${p.commit}`);
    } finally {
      resetCVars();
    }
  });
});

// --- Asset-free: browser-vs-Node distinction ----------------------------------

describe('browser evidence (asset-free)', () => {
  it('validates window.__q2stats-shaped payloads structurally', () => {
    expect(isBrowserFrameStats({ pooled: true, kicks: 3, presentedFps: 60 })).toBe(true);
    expect(isBrowserFrameStats({})).toBe(true);
    expect(isBrowserFrameStats(null)).toBe(false);
    expect(isBrowserFrameStats([])).toBe(false);
    expect(isBrowserFrameStats({ kicks: -1 })).toBe(false);
    expect(isBrowserFrameStats({ kicks: '3' })).toBe(false);
    expect(isBrowserFrameStats({ pooled: 1 })).toBe(false);
    expect(isBrowserFrameStats({ compositor: 42 })).toBe(false);
  });

  it('runs as node here; invalid payloads coerce to null', () => {
    expect(describeRuntime()).toEqual({ runtime: 'node', compositing: 'node' });
    expect(coerceBrowserEvidence(null, 'hardware-backed')).toBeNull();
    const e = coerceBrowserEvidence(
      { pooled: true, stagedBatches: 10, kicks: 1, inlineBatches: 0, fallbacks: 0, presentedFps: 59.5 },
      'hardware-backed',
      'soak',
    );
    expect(e?.compositing).toBe('hardware-backed');
    expect(e?.presentedFpsMed).toBe(59.5);
    expect(formatBrowserEvidence(e!)).toContain('compositing=hardware-backed');
  });
});

// --- Asset-free: whole-frame measurement on the procedural fallback -----------

describe('measureProductionFrames (asset-free, NullRefresh)', () => {
  it('measures whole frames deterministically with full-channel hashes', () => {
    const mk = (): { color: string; idx: string | null } => {
      const W = 160, H = 120;
      const r = new NullRefresh();
      r.init(createFramebuffer(W, H, true));
      const e = measureProductionFrames({
        renderer: r,
        world: devroomWorld(),
        width: W, height: H,
        viewFor: (rep) => benchViewFor('moving', rep),
        entitiesFor: () => [],
        warmup: 1, reps: 2,
      });
      expect(e.frames).toHaveLength(2);
      expect(e.execProven).toBe(true);
      expect(e.displayParitySerialVsPooled).toBeNull();
      const line = formatProductionEvidence('nulldev', e);
      expect(line).toContain('160x120');
      const last = e.frames[1]!;
      return { color: last.colorFull, idx: last.indexHash };
    };
    const a = mk();
    const b = mk();
    expect(b.color).toBe(a.color);
    expect(b.idx).toBe(a.idx);
  });

  it('captures the serial-fallback leg on a failing pool (no silent success)', () => {
    const W = 160, H = 120;
    const r = new NullRefresh();
    r.init(createFramebuffer(W, H, true));
    const e = measureProductionFrames({
      renderer: r,
      world: devroomWorld(),
      width: W, height: H,
      viewFor: (rep) => benchViewFor('stationary', rep),
      entitiesFor: () => [],
      warmup: 0, reps: 2,
      scanout: {
        pool: { flushScanout: () => false, scanoutPlanes: { scanDisplay: new Uint32Array(W * H) } },
        resolveSerialInto: (color, display) => display.set(color),
      },
    });
    expect(e.scanoutKinds).toEqual(['serial-fallback', 'serial-fallback']);
    expect(e.scanoutFallbacks).toBe(2);
    // All-fallback pooled config must NOT report proven execution.
    expect(e.execProven).toBe(false);
    expect(e.displayParitySerialVsPooled).toBeNull();
  });

  it('detects pooled-vs-serial display parity and mismatch', () => {
    const run = (tamper: boolean): boolean | null => {
      const W = 64, H = 48;
      const r = new NullRefresh();
      r.init(createFramebuffer(W, H, true));
      const planes = { scanDisplay: new Uint32Array(W * H) };
      const e = measureProductionFrames({
        renderer: r,
        world: devroomWorld(),
        width: W, height: H,
        viewFor: (rep) => benchViewFor('stationary', rep),
        entitiesFor: () => [],
        warmup: 0, reps: 1,
        scanout: {
          pool: {
            flushScanout: () => {
              const live = r.getFramebuffer().color;
              planes.scanDisplay.set(live);
              if (tamper) planes.scanDisplay[0] = (planes.scanDisplay[0]! ^ 0xff) >>> 0;
              return true;
            },
            scanoutPlanes: planes,
          },
          resolveSerialInto: (color, display) => display.set(color),
        },
      });
      return e.displayParitySerialVsPooled;
    };
    expect(run(false)).toBe(true);
    expect(run(true)).toBe(false);
  });
});

// --- Q2_PAK-gated: matched 640x480 workloads, real assets ---------------------

const require = createRequire(process.cwd() + '/');

function swRendererEsmPath(): string | null {
  try {
    const cjs = require.resolve('@q2/sw-renderer');
    const esm = cjs.replace(/index\.js$/, 'index.mjs');
    return existsSync(esm) ? esm : null;
  } catch {
    return null;
  }
}

describe.runIf(!!Q2_PAK)('matched 640x480 workloads (Q2_PAK)', () => {
  it('stationary/combat/moving: deterministic whole frames + full-channel evidence', { timeout: 300000 }, async () => {
    const pakBytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(pakBytes.length);
    new Uint8Array(buf).set(pakBytes);
    const bw = loadBenchWorld(buf);
    expect(bw.world.surfaces.length).toBeGreaterThan(0);

    let voodoo: {
      readVoodooState(): unknown;
      resolveFrame(color: Uint32Array, dst565: Uint16Array, disp: Uint32Array, w: number, h: number, st: unknown): void;
    } | null = null;
    try {
      const mod = await import('@q2/voodoo');
      voodoo = {
        readVoodooState: (mod as { readVoodooState(): unknown }).readVoodooState,
        resolveFrame: (mod as {
          resolveFrame(c: Uint32Array, d: Uint16Array, s: Uint32Array, w: number, h: number, st: unknown): void;
        }).resolveFrame,
      };
    } catch {
      voodoo = null;
    }

    const W = BENCH_ACCEPT_WIDTH, H = BENCH_ACCEPT_HEIGHT;
    const origin = benchSpawnOrigin();
    const yaw = benchSpawnYaw();

    const renderAll = (): { stat: string; comb: string; mov: string[]; cover: number } => {
      pinBenchCvars();
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(bw.palette);
      setRGBWorldEnabled(true);
      try {
        const yawRad = (yaw * Math.PI) / 180;
        const world = {
          name: 'base1',
          data: withBenchParticles(
            bw.world,
            origin[0] + Math.cos(yawRad) * 48, origin[1] + Math.sin(yawRad) * 48, origin[2] - 20,
          ),
        };
        const fixed = fixedBenchEntities(r, bw, origin, yaw);
        const combat = combatBenchEntities(r, bw, origin, yaw);
        const stVoodoo = voodoo ? voodoo.readVoodooState() : null;
        const serialDisp = new Uint32Array(W * H);
        const serial565 = new Uint16Array(W * H);
        const scanout = voodoo ? {
          resolveSerialInto: (color: Uint32Array, display: Uint32Array): void => {
            voodoo!.resolveFrame(color, serial565, serialDisp, W, H, stVoodoo);
            display.set(serialDisp);
          },
        } : null;
        const stat = measureProductionFrames({
          renderer: r, world, width: W, height: H,
          viewFor: (rep) => benchViewFor('stationary', rep),
          entitiesFor: () => fixed,
          warmup: 1, reps: 2, scanout,
        });
        const comb = measureProductionFrames({
          renderer: r, world, width: W, height: H,
          viewFor: (rep) => benchViewFor('combat', rep),
          entitiesFor: (rep) => { pumpBenchLights(r, origin, yaw); return combat; },
          warmup: 1, reps: 2, scanout,
        });
        const mov = measureProductionFrames({
          renderer: r, world, width: W, height: H,
          viewFor: (rep) => benchViewFor('moving', rep),
          entitiesFor: (rep) => { pumpBenchLights(r, origin, yaw); return combatBenchEntities(r, bw, origin, yaw); },
          warmup: 1, reps: 3, scanout,
        });
        const cover = comb.stage ? comb.stage.coverPixels : -1;
        console.log(formatProductionEvidence('stationary', stat));
        console.log(formatProductionEvidence('combat', comb));
        console.log(formatProductionEvidence('moving', mov));
        return {
          stat: stat.frames.map((f) => f.colorFull).join(','),
          comb: comb.frames.map((f) => f.colorFull).join(','),
          mov: mov.frames.map((f) => f.colorFull),
          cover,
        };
      } finally {
        setRGBWorldEnabled(false);
        resetCVars();
      }
    };

    const a = renderAll();
    const b = renderAll();
    // Determinism: same (workload, rep) → same full-RGBA hash across runs.
    expect(b.stat).toBe(a.stat);
    expect(b.comb).toBe(a.comb);
    expect(b.mov).toEqual(a.mov);
    // Workloads differ: the viewmodel + dlights change combat vs stationary.
    expect(a.comb).not.toBe(a.stat);
    // Moving sweep changes the frame across reps.
    expect(new Set(a.mov).size).toBeGreaterThan(1);
    // Combat uses the RGB path with real coverage (no empty-scene numbers).
    expect(a.cover).toBeGreaterThan(0);
  });

  it('serial vs 1-worker pooled: full-RGBA parity + execution proof', { timeout: 300000 }, async () => {
    const esm = swRendererEsmPath();
    if (!esm) {
      console.log('SKIP pooled parity: built @q2/sw-renderer ESM dist missing (run yarn build first)');
      return;
    }
    const pakBytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(pakBytes.length);
    new Uint8Array(buf).set(pakBytes);
    const bw = loadBenchWorld(buf);
    const W = BENCH_ACCEPT_WIDTH, H = BENCH_ACCEPT_HEIGHT;
    const origin = benchSpawnOrigin();
    const yaw = benchSpawnYaw();

    const render = async (workers: number): Promise<{ color: string; cover: number; exec: boolean; fb: number }> => {
      const { BandWorkerPool } = await import('@q2/sw-renderer');
      pinBenchCvars();
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(bw.palette);
      let pool: BandWorkerPool | null = null;
      if (workers > 0) {
        setCVar('sw_workers', workers + 1);
        setCVar('sw_accum', 1);
        r.syncWorkersFromCvar();
        pool = BandWorkerPool.create(workers, W, H, { indexJsPath: esm });
        if (!pool) throw new Error('pool unavailable (need worker_threads + SAB + Atomics.wait)');
        r.attachWorkerPool(pool);
      }
      setRGBWorldEnabled(true);
      try {
        const world = { name: 'base1', data: bw.world };
        const combat = combatBenchEntities(r, bw, origin, yaw);
        const e = measureProductionFrames({
          renderer: r, world, width: W, height: H,
          viewFor: (rep) => benchViewFor('combat', rep),
          entitiesFor: () => { pumpBenchLights(r, origin, yaw); return combat; },
          warmup: 1, reps: 2, scanout: null,
        });
        const last = e.frames[e.frames.length - 1]!;
        return {
          color: last.colorFull,
          cover: e.stage ? e.stage.coverPixels : -1,
          exec: e.execProven,
          fb: e.scanoutFallbacks,
        };
      } finally {
        setRGBWorldEnabled(false);
        if (pool) await pool.dispose();
        resetCVars();
      }
    };

    const serial = await render(0);
    const pooled = await render(1);
    expect(pooled.color).toBe(serial.color);
    expect(pooled.cover).toBe(serial.cover);
    expect(pooled.exec).toBe(true);
    expect(pooled.fb).toBe(0);
  });

  it('benchEntitiesFor routes stationary→fixed, combat/moving→gun set', () => {
    const pakBytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(pakBytes.length);
    new Uint8Array(buf).set(pakBytes);
    const bw = loadBenchWorld(buf);
    pinBenchCvars();
    try {
      const fb = createFramebuffer(64, 48, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(bw.palette);
      const origin = benchSpawnOrigin();
      const yaw = benchSpawnYaw();
      const s = benchEntitiesFor('stationary', r, bw, origin, yaw);
      const c = benchEntitiesFor('combat', r, bw, origin, yaw);
      const m = benchEntitiesFor('moving', r, bw, origin, yaw);
      expect(s).toHaveLength(3);
      expect(c).toHaveLength(4);
      expect(m).toHaveLength(4);
      expect(c[3]!.depthHack).toBe(true);
    } finally {
      resetCVars();
    }
  });
});
