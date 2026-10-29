// @q2/testkit — GPU-PROOF-1 tests: route determinism (always), metrics
// units (always), Q2_PAK-gated CPU reference renders + transparent
// inventory + exact CPU-to-CPU parity.
//
// Reference slots are written under <package>/gpu-proof-ref/ ONLY when
// GPU_PROOF_WRITE_REF=1 (never overwritten by default); hashes are always
// logged for the integrator's contract doc. Render parts skip gracefully
// when Q2_PAK is absent.
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createFramebuffer } from '@q2/renderer-api';
import type { FrameStats } from '@q2/renderer-api';
import { resetCVars } from '@q2/config';
import { SoftwareRenderer, setRGBWorldEnabled } from '@q2/sw-renderer';
import {
  BENCH_FIDELITY_CVARS,
  benchSpawnYaw,
  benchViewFor,
  fidelityCvarSnapshot,
  loadBenchWorld,
  pinBenchCvars,
  withBenchParticles,
  type BenchWorld,
} from './bench-workloads.js';
import {
  GPU_PROOF_FIDELITY_CVARS,
  GPU_PROOF_HEIGHT,
  GPU_PROOF_PERF_REPS,
  GPU_PROOF_TOLERANCES,
  GPU_PROOF_WIDTH,
  compareGpuProofFrames,
  formatGpuProofReport,
  gpuProofEntitiesFor,
  gpuProofPerfRoute,
  gpuProofPumpFor,
  gpuProofRoute,
  gpuProofSlotNames,
  gpuProofSlotPaths,
  gpuProofViewFor,
  writeGpuProofReference,
  type GpuProofFileWriter,
  type GpuProofFrame,
} from './gpu-proof.js';
import { fnvColorFull } from './frame-evidence.js';
import { collectStageCounters } from './critpath.js';
import { readForegroundStats, type ForegroundStats } from './renderer-hooks.js';

// --- Route determinism (asset-free) ------------------------------------------

describe('gpu proof route (asset-free)', () => {
  it('route is deterministic and pins F0/F1/F2 labels, workloads and reps', () => {
    const a = gpuProofRoute();
    const b = gpuProofRoute();
    expect(a).toEqual(b);
    expect(a.map((f) => f.label)).toEqual([
      'gpu-proof-f0-stationary',
      'gpu-proof-f1-combat',
      'gpu-proof-f2-moving',
    ]);
    expect(a.map((f) => f.workload)).toEqual(['stationary', 'combat', 'moving']);
    expect(a.map((f) => f.rep)).toEqual([0, 0, 3]);
    expect(a.map((f) => f.index)).toEqual([0, 1, 2]);
  });

  it('F0/F1 share the spawn camera; F2 is yaw+6deg (rep 3, yawStep 2)', () => {
    const [f0, f1, f2] = gpuProofRoute() as [GpuProofFrame, GpuProofFrame, GpuProofFrame];
    expect(f0!.yawDeg).toBe(benchSpawnYaw());
    expect(f1!.yawDeg).toBe(f0!.yawDeg);
    expect(f2!.yawDeg).toBe(f0!.yawDeg + 6);
    const v0 = gpuProofViewFor(f0!);
    const v1 = gpuProofViewFor(f1!);
    const v2 = gpuProofViewFor(f2!);
    expect(Array.from(v1.angles as ArrayLike<number>)).toEqual(
      Array.from(v0.angles as ArrayLike<number>),
    );
    expect(Array.from(v0.origin as ArrayLike<number>)).toEqual([128, -320, 54]);
    expect(v0.fovX).toBe(90);
    const yaw = (v: { angles: unknown }): number => (v.angles as Float32Array)[1]!;
    expect(yaw(v2)).toBe(yaw(v0) + 6);
    // Same yaw the bench moving workload reaches at rep 3 (shared math).
    expect(yaw(v2)).toBe(yaw(benchViewFor('moving', 3)));
    // Same (index) twice → identical RefDef (comparable hashes).
    expect(yaw(gpuProofViewFor(f2!))).toBe(yaw(v2));
  });

  it('shares the pinned bench fidelity profile by reference (never diverged)', () => {
    expect(GPU_PROOF_FIDELITY_CVARS).toBe(BENCH_FIDELITY_CVARS);
    expect(GPU_PROOF_FIDELITY_CVARS['vd_lodbias']).toBe('-0.35');
    expect([GPU_PROOF_WIDTH, GPU_PROOF_HEIGHT]).toEqual([640, 480]);
  });

  it('perf route is 60 moving-combat reps at yawStep 1deg (GPU-PROOF-5 reuse)', () => {
    const route = gpuProofPerfRoute();
    expect(route).toHaveLength(GPU_PROOF_PERF_REPS);
    expect(route).toHaveLength(60);
    const yaw0 = benchSpawnYaw();
    route.forEach((f, i) => {
      expect(f.index).toBe(i);
      expect(f.workload).toBe('moving');
      expect(f.rep).toBe(i);
      expect(f.yawDeg).toBe(yaw0 + i);
    });
    expect(gpuProofPerfRoute()).toEqual(route);
  });

  it('slot names list the three fixed frame slots', () => {
    expect(gpuProofSlotNames()).toEqual([
      'gpu-proof-f0-stationary',
      'gpu-proof-f1-combat',
      'gpu-proof-f2-moving',
    ]);
    expect(gpuProofSlotPaths('/ref', 'gpu-proof-f1-combat')).toEqual({
      rgbaPath: '/ref/gpu-proof-f1-combat.rgba',
      jsonPath: '/ref/gpu-proof-f1-combat.json',
    });
  });
});

// --- Metrics units (asset-free) -----------------------------------------------

describe('gpu proof metrics (asset-free)', () => {
  it('identical buffers pass with zero diff', () => {
    const a = new Uint32Array([0xff000000, 0xff010203, 0x80123456]);
    const d = compareGpuProofFrames(a, a.slice());
    expect(d.diff).toBe(0);
    expect(d.fraction).toBe(0);
    expect(d.maxAbsDelta).toBe(0);
    expect(d.pass).toBe(true);
    expect(d.edgeExcluded).toBe(0);
    expect(formatGpuProofReport('same', d)).toContain('PASS');
  });

  it('single-pixel diff is counted with exact fraction and delta', () => {
    const n = 100;
    const a = new Uint32Array(n).fill(0xff101010);
    const b = a.slice();
    b[42] = 0xff10101a; // +10 blue
    const d = compareGpuProofFrames(a, b);
    expect(d.diff).toBe(1);
    expect(d.fraction).toBeCloseTo(0.01, 12);
    expect(d.maxAbsDelta).toBe(10);
    expect(d.pass).toBe(true); // 1% < 2% gate
  });

  it('lsb forgiveness ignores quantization noise; larger deltas count', () => {
    const a = new Uint32Array([0xff101010, 0xff101010]);
    const b = new Uint32Array([0xff131313, 0xff141010]); // +3 all ch, +4 red
    const d = compareGpuProofFrames(a, b);
    expect(d.diff).toBe(1);
    expect(d.maxAbsDelta).toBe(4);
  });

  it('1px edge exclusion skips border pixels and reports them', () => {
    const w = 8, h = 6;
    const a = new Uint32Array(w * h).fill(0xff202020);
    const b = a.slice();
    b[0] = 0xffff0000; // corner
    b[w * h - 1] = 0xffff0000; // opposite corner
    const full = compareGpuProofFrames(a, b, GPU_PROOF_TOLERANCES, w);
    expect(full.diff).toBe(0);
    expect(full.edgeExcluded).toBe(2 * (w + h) - 4);
    expect(full.pass).toBe(true);
    const noWidth = compareGpuProofFrames(a, b);
    expect(noWidth.diff).toBe(2);
    expect(noWidth.edgeExcluded).toBe(0);
  });

  it('tolerance gate fails when the fraction is exceeded', () => {
    const n = 100;
    const a = new Uint32Array(n).fill(0xff000000);
    const b = a.slice();
    for (let i = 0; i < 5; i++) b[i] = 0xffff0000; // 5% >> 2% gate
    const d = compareGpuProofFrames(a, b);
    expect(d.diff).toBe(5);
    expect(d.fraction).toBeCloseTo(0.05, 12);
    expect(d.pass).toBe(false);
    expect(formatGpuProofReport('gate', d)).toContain('FAIL');
  });

  it('maxAbsDelta above warn is flagged REVIEW-MAXDELTA (never silent)', () => {
    const n = 100;
    const a = new Uint32Array(n).fill(0xff000000);
    const b = a.slice();
    b[7] = 0xffffffff; // 1% < gate, but maxed-out delta
    const d = compareGpuProofFrames(a, b);
    expect(d.pass).toBe(true);
    const line = formatGpuProofReport('warn', d);
    expect(line).toContain('PASS');
    expect(line).toContain('REVIEW-MAXDELTA');
  });

  it('reference writer serializes slots through an injected writer', () => {
    const files = new Map<string, Uint8Array | string>();
    const writer: GpuProofFileWriter = (p, d) => {
      files.set(p, d);
    };
    const color = new Uint32Array([1, 2, 3, 4]);
    const display = new Uint32Array([5, 6, 7, 8]);
    const meta = {
      width: 2, height: 2,
      label: 'gpu-proof-f1-combat', workload: 'combat' as const, rep: 0, yawDeg: 90,
      display: 'raw-color' as const, fidelity: { ...BENCH_FIDELITY_CVARS },
    };
    const paths = writeGpuProofReference(writer, '/ref', 'gpu-proof-f1-combat', color, display, meta);
    expect(paths).toEqual(['/ref/gpu-proof-f1-combat.rgba', '/ref/gpu-proof-f1-combat.json']);
    const rgba = files.get('/ref/gpu-proof-f1-combat.rgba') as Uint8Array;
    expect(rgba.length).toBe(16);
    expect(Array.from(new Uint32Array(rgba.buffer, rgba.byteOffset, 4))).toEqual([5, 6, 7, 8]);
    const body = JSON.parse(files.get('/ref/gpu-proof-f1-combat.json') as string) as {
      displayHash: string; colorHash: string; width: number; fidelity: Record<string, string>;
    };
    expect(body.displayHash).toBe(fnvColorFull(display));
    expect(body.colorHash).toBe(fnvColorFull(color));
    expect(body.width).toBe(2);
    expect(body.fidelity).toEqual(BENCH_FIDELITY_CVARS);
    expect(() =>
      writeGpuProofReference(writer, '/ref', 'x', color, new Uint32Array(3), meta),
    ).toThrow();
  });
});

// --- Q2_PAK-gated CPU reference renders -----------------------------------------

const Q2_PAK = process.env.Q2_PAK;
const WRITE_REF = process.env.GPU_PROOF_WRITE_REF === '1';

function loadPakBytes(): ArrayBuffer {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return buf;
}

interface GpuProofRender {
  frame: GpuProofFrame;
  color: Uint32Array;
  display: Uint32Array;
  displayKind: 'voodoo-resolve' | 'raw-color';
  colorHash: string;
  displayHash: string;
  stats: FrameStats;
  coverPixels: number;
  translucentSpans: number;
  fg: ForegroundStats | null;
  fidelity: Record<string, string>;
}

/** Render one proof frame serially under the pinned profile (fresh renderer). */
async function renderGpuProofFrame(bw: BenchWorld, frame: GpuProofFrame): Promise<GpuProofRender> {
  pinBenchCvars();
  const W = GPU_PROOF_WIDTH, H = GPU_PROOF_HEIGHT;
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  try {
    r.init(fb);
    r.setPalette(bw.palette);
    setRGBWorldEnabled(true);
    const origin: [number, number, number] = [128, -320, 54];
    const yawRad = (frame.yawDeg * Math.PI) / 180;
    const world = frame.workload === 'stationary'
      ? { name: 'base1', data: bw.world }
      : {
        name: 'base1',
        data: withBenchParticles(
          bw.world,
          origin[0] + Math.cos(yawRad) * 48,
          origin[1] + Math.sin(yawRad) * 48,
          origin[2] - 20,
        ),
      };
    const entities = gpuProofEntitiesFor(r, bw, frame);
    gpuProofPumpFor(r, origin, frame.yawDeg, frame);
    const view = gpuProofViewFor(frame);
    r.beginFrame();
    const stats = r.renderView(view, world, entities);
    r.endFrame();
    const stage = collectStageCounters(r as unknown as Parameters<typeof collectStageCounters>[0]);
    const fg = readForegroundStats(r);
    const fidelity = fidelityCvarSnapshot();
    const color = fb.color.slice();
    // Display leg: production voodoo resolve when the package resolves,
    // else the raw raster plane (recorded in the slot sidecar).
    let display = color.slice();
    let displayKind: 'voodoo-resolve' | 'raw-color' = 'raw-color';
    try {
      const mod = (await import('@q2/voodoo')) as {
        readVoodooState(): unknown;
        resolveFrame(c: Uint32Array, d: Uint16Array, s: Uint32Array, w: number, h: number, st: unknown): void;
      };
      const st = mod.readVoodooState();
      const scratch = new Uint32Array(W * H);
      mod.resolveFrame(color, new Uint16Array(W * H), scratch, W, H, st);
      display = scratch;
      displayKind = 'voodoo-resolve';
    } catch {
      display = color.slice();
    }
    return {
      frame, color, display, displayKind,
      colorHash: fnvColorFull(color),
      displayHash: fnvColorFull(display),
      stats,
      coverPixels: stage.coverPixels,
      translucentSpans: stage.translucentSpans,
      fg,
      fidelity,
    };
  } finally {
    setRGBWorldEnabled(false);
    resetCVars();
  }
}

describe.runIf(!!Q2_PAK)('gpu proof CPU reference (Q2_PAK)', () => {
  it('F0/F1/F2 render non-trivial frames with gun + transparency coverage', { timeout: 300000 }, async () => {
    const bw = loadBenchWorld(loadPakBytes());
    const [f0, f1, f2] = gpuProofRoute() as [GpuProofFrame, GpuProofFrame, GpuProofFrame];
    const r0 = await renderGpuProofFrame(bw, f0!);
    const r1 = await renderGpuProofFrame(bw, f1!);
    const r2 = await renderGpuProofFrame(bw, f2!);
    for (const r of [r0, r1, r2]) {
      // Under the RGB-authoritative path the classic span counters stay
      // zero by design (skipped duplicate work); the composite coverage
      // and real-texel variety are the non-triviality signals.
      expect(r.coverPixels).toBeGreaterThan(GPU_PROOF_WIDTH * GPU_PROOF_HEIGHT * 0.15);
      expect(new Set(r.color).size).toBeGreaterThan(20);
      expect(r.fidelity).toEqual(GPU_PROOF_FIDELITY_CVARS);
    }
    // Combat adds the gun + dlights + particles: must differ from stationary.
    const combatVsStat = compareGpuProofFrames(r1.color, r0.color);
    console.log(`GPU-PROOF combat-vs-stationary ${formatGpuProofReport('f1-vs-f0', combatVsStat)}`);
    expect(combatVsStat.fraction).toBeGreaterThan(0.005);
    // Moving camera: F2 differs from F0 well beyond the review gate.
    const movingVsStat = compareGpuProofFrames(r2.color, r0.color);
    console.log(`GPU-PROOF moving-vs-stationary ${formatGpuProofReport('f2-vs-f0', movingVsStat)}`);
    expect(movingVsStat.fraction).toBeGreaterThan(0.05);
    // Transparent inventory (entity classes: tracer beam, sprite, particles).
    for (const r of [r1, r2]) {
      const fg = r.fg;
      const beam = (fg?.beamDrawsInline ?? 0) + (fg?.beamSpansInline ?? 0);
      const sprite = (fg?.spriteDrawsInline ?? 0) + (fg?.spriteSpansInline ?? 0) + (fg?.spriteSpansStaged ?? 0);
      const parts = (fg?.particleDrawsInline ?? 0) + (fg?.particlesInline ?? 0);
      const alpha = (fg?.alphaSpansStaged ?? 0) + (fg?.alphaSpansInline ?? 0);
      console.log(
        `GPU-PROOF transparent ${r.frame.label}: beam=${beam} sprite=${sprite} ` +
        `particles=${parts} alpha=${alpha} translucentSpans=${r.translucentSpans} ` +
        `display=${r.displayKind}`,
      );
      expect(beam + sprite + parts + alpha + r.translucentSpans).toBeGreaterThan(0);
    }
    // Hashes for the integrator's contract doc.
    console.log(
      `GPU-PROOF hashes f0 color=${r0.colorHash} display=${r0.displayHash}(${r0.displayKind}) ` +
      `f1 color=${r1.colorHash} display=${r1.displayHash}(${r1.displayKind}) ` +
      `f2 color=${r2.colorHash} display=${r2.displayHash}(${r2.displayKind})`,
    );
    // Reference slots only on explicit opt-in — never overwritten by default.
    if (WRITE_REF) {
      const refDir = join(process.cwd(), 'gpu-proof-ref');
      mkdirSync(refDir, { recursive: true });
      const writer: GpuProofFileWriter = (p, d) => writeFileSync(p, d);
      for (const r of [r0, r1, r2]) {
        const paths = writeGpuProofReference(writer, refDir, r.frame.label, r.color, r.display, {
          width: GPU_PROOF_WIDTH,
          height: GPU_PROOF_HEIGHT,
          label: r.frame.label,
          workload: r.frame.workload,
          rep: r.frame.rep,
          yawDeg: r.frame.yawDeg,
          display: r.displayKind,
          fidelity: r.fidelity,
        });
        console.log(`GPU-PROOF wrote ${paths.join(' ')}`);
      }
    } else {
      console.log('GPU-PROOF reference write skipped (set GPU_PROOF_WRITE_REF=1 to record slots)');
    }
  });

  it('CPU-to-CPU parity is exact: re-render hashes match', { timeout: 300000 }, async () => {
    const bw = loadBenchWorld(loadPakBytes());
    const f1 = gpuProofRoute()[1]!;
    const a = await renderGpuProofFrame(bw, f1);
    const b = await renderGpuProofFrame(bw, f1);
    expect(b.colorHash).toBe(a.colorHash);
    expect(b.displayHash).toBe(a.displayHash);
  });
});
