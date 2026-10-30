// @q2/testkit — golden-frame harness, differ, bench runner, fixtures.
import type { Entity, Framebuffer, RefDef, Refresh, WorldModel } from '@q2/renderer-api';

export * from './demo-fallback.js';
export * from './base1-views.js';
export * from './demo-determinism.js';
export * from './sidebyside.js';
export * from './cache-flythrough.js';
export * from './voodoo-baseline.js';
export * from './perf-budget.js';
export * from './critpath.js';
export * from './worker-timing.js';
export * from './geo-attribution.js';
export * from './kick-histogram.js';
export * from './ab-compare.js';
export * from './renderer-hooks.js';
export * from './fg-attribution.js';
export * from './bench-workloads.js';
export * from './frame-evidence.js';
export * from './provenance.js';
export * from './browser-evidence.js';
export * from './gpu-proof.js';
export * from './gpu-acceptance.js';
export * from './gpu-follow-2a.js';
export * from './gpu-scene-semantics.js';
export * from './gpu-effects-semantics.js';

export const GOLDEN_TOLERANCE_SOFTWARE = 0;
export const GOLDEN_TOLERANCE_VOODOO_LSB = 1;

/** FNV-1a 32-bit hash of a framebuffer's color plane. */
export function hashFrame(color: Uint32Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < color.length; i++) {
    h ^= color[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Full-RGBA FNV-1a (all 4 bytes per pixel, R+G+B+A order). The bench
 * R+G harness hash (`hashColorRG` in tools/bench) is blind to blue-only
 * and alpha-only corruption — parity gates MUST use this (or hashFrame)
 * for serial-vs-pooled raster AND final display. Byte-wise (not
 * word-wise) so endianness can never hide a channel.
 */
export function hashColorFull(color: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) {
    const px = color[i]!;
    h ^= px & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (px >>> 8) & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (px >>> 16) & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (px >>> 24) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Count differing pixels; `lsb` allows per-channel tolerance (voodoo). */
export function pngDiff(a: Uint32Array, b: Uint32Array, lsb = 0): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    if (lsb > 0) {
      const dr = Math.abs((x & 255) - (y & 255));
      const dg = Math.abs(((x >> 8) & 255) - ((y >> 8) & 255));
      const db = Math.abs(((x >> 16) & 255) - ((y >> 16) & 255));
      if (dr <= lsb && dg <= lsb && db <= lsb) continue;
    }
    diff++;
  }
  return diff;
}

export interface GoldenResult {
  name: string;
  hash: string;
  width: number;
  height: number;
  pixels: number;
  stats: { spans: number; pixels: number; overdraw: number; ms: number };
}

/**
 * Render a fixed camera headlessly, hash it, and optionally write the raw
 * RGBA + json sidecar to `<outDir>/<name>.{rgba,json}` (`__golden__/out`).
 * Pure render; fs writes are isolated in `writeGoldenFiles` (Node only).
 */
export function renderGolden(
  refresh: Refresh,
  view: RefDef,
  world: WorldModel,
  entities: Entity[],
  name: string,
): { result: GoldenResult; rgba: Uint8Array } {
  refresh.beginFrame();
  const stats = refresh.renderView(view, world, entities);
  refresh.endFrame();
  const fb = currentFramebuffer(refresh);
  const rgba = new Uint8Array(fb.color.buffer, fb.color.byteOffset, fb.color.length * 4);
  const result: GoldenResult = {
    name,
    hash: hashFrame(fb.color),
    width: fb.width,
    height: fb.height,
    pixels: fb.width * fb.height,
    stats: { ...stats },
  };
  return { result, rgba: rgba.slice() };
}

// Refresh implementations own their framebuffer; NullRefresh-style heads
// expose it via `getFramebuffer` when available. Fall back to a probe.
function currentFramebuffer(refresh: Refresh): Framebuffer {
  const withFb = refresh as Partial<{ framebuffer: Framebuffer; getFramebuffer(): Framebuffer; fb: Framebuffer }>;
  if (withFb.framebuffer) return withFb.framebuffer;
  if (withFb.fb) return withFb.fb;
  if (typeof withFb.getFramebuffer === 'function') return withFb.getFramebuffer();
  throw new Error('testkit: Refresh does not expose its framebuffer (add framebuffer/getFramebuffer)');
}

/** Node-only writer for golden outputs. Imported lazily so browsers pass. */
export async function writeGoldenFiles(outDir: string, result: GoldenResult, rgba: Uint8Array): Promise<string[]> {
  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, result.name);
  fs.writeFileSync(`${base}.rgba`, rgba);
  fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  return [`${base}.rgba`, `${base}.json`];
}

/** Compare a fresh render against a recorded golden hash/pixels. */
export function compareGolden(
  actual: Uint32Array,
  expected: Uint32Array,
  tolerance: 'software' | 'voodoo' = 'software',
): { diff: number; pass: boolean } {
  const lsb = tolerance === 'voodoo' ? GOLDEN_TOLERANCE_VOODOO_LSB : GOLDEN_TOLERANCE_SOFTWARE;
  const diff = pngDiff(actual, expected, lsb);
  return { diff, pass: diff === 0 };
}

// --- Bench runner --------------------------------------------------------

export interface BenchSample {
  name: string;
  pixels: number;
  iterations: number;
  msTotal: number;
  msPerFrame: number;
  mpixelsPerSec: number;
  overdraw: number;
}

/**
 * Time `fn` over `iterations` runs. `fn` returns pixels written and an
 * overdraw estimate. Prints nothing; use `formatLedgerRow` for output.
 */
export function runBench(
  name: string,
  pixels: number,
  iterations: number,
  fn: () => { pixels: number; overdraw: number },
): BenchSample {
  // Warmup (JIT + caches).
  for (let i = 0; i < Math.min(5, iterations); i++) fn();
  const t0 = performance.now();
  let overdraw = 1;
  for (let i = 0; i < iterations; i++) {
    const r = fn();
    overdraw = r.overdraw;
  }
  const t1 = performance.now();
  const msTotal = Math.max(t1 - t0, 1e-6);
  const msPerFrame = msTotal / iterations;
  const mpixelsPerSec = pixels * iterations / (msTotal / 1000) / 1e6;
  return { name, pixels, iterations, msTotal, msPerFrame, mpixelsPerSec, overdraw };
}

/** Synthetic span-fill workload shared by the bench tool and unit smoke tests. */
export function syntheticFill(color: Uint32Array, seed: number): { pixels: number; overdraw: number } {
  let s = seed | 0;
  const n = color.length;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    color[i] = s;
  }
  return { pixels: n, overdraw: 1 };
}

/** Perf-ledger row (BRAIN.md §11). */
export function formatLedgerRow(sample: BenchSample, commit: string, path: string, notes: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const fps = 1000 / Math.max(sample.msPerFrame, 1e-6);
  const res = Math.round(Math.sqrt((sample.pixels * 4) / 3));
  return (
    `| ${date} | ${commit} | ${path} | ${res}x${Math.round((res * 3) / 4)} ` +
    `| ${fps.toFixed(0)} | ~${sample.mpixelsPerSec.toFixed(0)} | ${sample.overdraw.toFixed(2)} | ${notes} |`
  );
}

/** Machine descriptor for `tools/bench/machine.json` (Node only). */
export async function machineJson(): Promise<Record<string, string>> {
  const os = await import('os');
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpus: String(os.cpus().length),
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    node: process.version,
    date: new Date().toISOString(),
  };
}
