// Bench: drawSpansSoftware Mpixel/s on this machine (M3.1 done-when: >=40).
// Run after build: `node ./bench.mjs`. Uses the built dist bundle.
// M8.1: SAB band + worker-thread pool scaling on the same workload.
import {
  drawSpansSoftware, createSpan, buildColormap, defaultPalette,
  BandWorkerPool,
} from './dist/index.mjs';
import { fileURLToPath } from 'node:url';

const W = 640, H = 480;
const idx = new Uint8Array(W * H);
const zb = new Float32Array(W * H);
// 64x64 gradient texture (mip0-style surface block)
const texels = new Uint8Array(64 * 64);
for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) texels[y * 64 + x] = (x + y) & 255;
const tex = { width: 64, height: 64, texels };
// luxel grade block with a gradient (exercises the lv>=0 blocklight path)
const lightVals = new Uint8Array(16 * 16);
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) lightVals[y * 16 + x] = 20 + ((x + y) & 31);
const light = { width: 16, height: 16, values: lightVals };
const colormap = buildColormap(defaultPalette());

// full-screen span list with perspective gradients (one 640px span per row:
// exercises 16px subdivision chaining exactly like the frame loop)
const spans = [];
for (let y = 0; y < H; y++) {
  const s = createSpan();
  s.kind = 0;
  s.y = y; s.x0 = 0; s.x1 = W;
  const depth = 200 + y * 0.7;
  s.iz = 1 / depth; s.diz = 0.0000004;
  s.uz = 0; s.duz = s.iz * (64 / W);
  s.vz = (y % 64) * s.iz; s.dvz = 0;
  s.light = 0; s.dlight = 0;
  s.lu = 0; s.lv = 8; s.dlu = (16 * W) / 640 / W;
  s.turb = 0; s.ord = 0;
  spans.push(s);
}
const list = { spans, count: spans.length };

const framePixels = W * H;
// warmup
for (let i = 0; i < 10; i++) {
  idx.fill(0); zb.fill(0);
  drawSpansSoftware(idx, zb, W, H, list, tex, light, colormap);
}
const iters = 60;
const t0 = process.hrtime.bigint();
for (let i = 0; i < iters; i++) {
  idx.fill(0); zb.fill(0);
  drawSpansSoftware(idx, zb, W, H, list, tex, light, colormap);
}
const t1 = process.hrtime.bigint();
const secs = Number(t1 - t0) / 1e9;
const mpix = (framePixels * iters) / 1e6 / secs;
console.log(`drawSpansSoftware: ${mpix.toFixed(1)} Mpixel/s (${framePixels} px x ${iters} iters in ${secs.toFixed(2)}s)`);
if (mpix < 40) {
  console.error('BELOW M3.1 BUDGET of 40 Mpixel/s');
  process.exit(1);
}

// M9.1: WASM span backend on the same workload. Byte-identity is asserted
// (buffers must match the TS run exactly); Mpixel/s + speedup are reported
// for the §11 ledger. The TS budget above stays the gate (TS is default).
{
  const { WasmSpanBackend } = await import('./dist/index.mjs');
  const wb = WasmSpanBackend.create(W, H);
  if (!wb) {
    console.log('wasmSpans: unavailable in this environment (TS path only)');
  } else {
    wb.attach(wb.idx, wb.zb, W, H, colormap);
    // single reference TS run for the identity check
    idx.fill(0); zb.fill(0);
    drawSpansSoftware(idx, zb, W, H, list, tex, light, colormap);
    const refIdx = idx.slice();
    const refZb = zb.slice();
    // warmup (also warms the surface-block staging caches)
    for (let i = 0; i < 10; i++) {
      wb.idx.fill(0); wb.zb.fill(0);
      wb.spansDrawn = 0; wb.pixelsDrawn = 0;
      wb.drawSpans(list, tex, light);
    }
    const w0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      wb.idx.fill(0); wb.zb.fill(0);
      wb.spansDrawn = 0; wb.pixelsDrawn = 0;
      wb.drawSpans(list, tex, light);
    }
    const w1 = process.hrtime.bigint();
    const wsecs = Number(w1 - w0) / 1e9;
    const wmpix = (framePixels * iters) / 1e6 / wsecs;
    let diff = 0;
    for (let i = 0; i < framePixels; i++) {
      if (wb.idx[i] !== refIdx[i] || wb.zb[i] !== refZb[i]) diff++;
    }
    console.log(`drawSpansWasm: ${wmpix.toFixed(1)} Mpixel/s (${framePixels} px x ${iters} iters in ${wsecs.toFixed(2)}s)`);
    console.log(`wasmSpans: speedup ${(wmpix / mpix).toFixed(2)}x, diffs vs TS: ${diff}, fallbacks: ${wb.fallbackBatches}`);
    if (diff !== 0) {
      console.error('WASM BACKEND DIVERGED FROM TS (byte-identity violated)');
      process.exit(1);
    }
  }
}

// M3.4: 1000 particles at 640x480 must cost < 1.5 ms.
{
  const { projectParticles, drawParticles } = await import('./dist/index.mjs');
  const N = 1000;
  const origins = new Float32Array(N * 3);
  const colors = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    origins[i * 3] = 200 + (i % 40) * 4;
    origins[i * 3 + 1] = ((i * 7) % 200) - 100;
    origins[i * 3 + 2] = 60 + ((i * 13) % 120);
    colors[i] = 200 + (i & 63);
  }
  const pidx = new Uint8Array(W * H);
  const pzb = new Float32Array(W * H);
  const fwd = new Float32Array([1, 0, 0]);
  const rgt = new Float32Array([0, -1, 0]);
  const up = new Float32Array([0, 0, 1]);
  const org = new Float32Array([0, 0, 100]);
  const pool = [];
  const p0 = process.hrtime.bigint();
  const piters = 200;
  for (let k = 0; k < piters; k++) {
    pidx.fill(0); pzb.fill(0);
    const n = projectParticles(origins, colors, N, org, fwd, rgt, up, W / 2 - 0.5, H / 2 - 0.5, W / 2, W / 2, 4, pool);
    drawParticles(pidx, pzb, W, H, pool, 0, n);
  }
  const p1 = process.hrtime.bigint();
  const ms = Number(p1 - p0) / 1e6 / piters;
  console.log(`particles x1000: ${ms.toFixed(3)} ms/frame at 640x480`);
  if (ms >= 1.5) {
    console.error('BELOW M3.4 BUDGET of 1.5 ms for 1000 particles');
    process.exit(1);
  }
}

// M8.1: SAB band + worker-thread pool scaling on the spanfill workload
// above (one full-screen batch/frame, the best case for banding). Each pool
// has N worker threads plus the calling thread's own band (N+1 execution
// units over one SharedArrayBuffer; zero copy, parallel lazy clear, no
// per-frame allocation). Byte-identity vs the single-threaded TS path is a
// hard gate; scaling is reported for the §11 ledger with a monotonicity +
// minimum-gain gate (absolute ratios swing with box clocks/load, so the
// ±15%-of-linear verdict at 4 workers is printed, not gated).
{
  const indexJsPath = fileURLToPath(new URL('./dist/index.mjs', import.meta.url));
  const framePixels = W * H;
  const measure = (fn, iters) => {
    for (let i = 0; i < 8; i++) fn(); // warmup (JIT + worker boot + caches)
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < iters; i++) fn();
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e9);
    }
    return best / iters; // best-of-3 seconds/frame
  };
  // single-threaded reference (same spans, classic planes + serial fill)
  const refIdx = new Uint8Array(framePixels);
  const refZb = new Float32Array(framePixels);
  const singleSecs = measure(() => {
    refIdx.fill(0); refZb.fill(0);
    drawSpansSoftware(refIdx, refZb, W, H, list, tex, light, colormap);
  }, 40);
  const singleMs = singleSecs * 1000;
  console.log(`bands single: ${(framePixels / 1e6 / singleSecs).toFixed(1)} Mpixel/s (${singleMs.toFixed(2)} ms/frame)`);
  const speedups = [];
  for (const n of [1, 2, 4]) {
    const pool = BandWorkerPool.create(n, W, H, { indexJsPath });
    if (!pool) {
      console.error(`bandPool(${n}): unavailable in this environment`);
      process.exit(1);
    }
    pool.beginFrame();
    let r = pool.dispatch(list, tex, light, colormap, 0, W, H, pool.idx, pool.zb);
    let diff = 0;
    for (let i = 0; i < framePixels; i++) {
      if (pool.idx[i] !== refIdx[i] || pool.zb[i] !== refZb[i]) diff++;
    }
    if (diff !== 0 || !r) {
      console.error(`bandPool(${n}): DIVERGED from single-threaded path (${diff} diffs)`);
      await pool.dispose();
      process.exit(1);
    }
    const secs = measure(() => {
      pool.beginFrame();
      pool.dispatch(list, tex, light, colormap, 0, W, H, pool.idx, pool.zb);
    }, 40);
    const ms = secs * 1000;
    const speedup = singleMs / ms;
    speedups.push(speedup);
    console.log(`bands workers=${n}: ${(framePixels / 1e6 / secs).toFixed(1)} Mpixel/s (${ms.toFixed(2)} ms/frame, ${speedup.toFixed(2)}x single)`);
    await pool.dispose();
  }
  const lin = speedups[2];
  console.log(`bands linearity@4: ${lin.toFixed(2)}x single (band for 4x +/-15%: [3.40, 4.60]) ${lin >= 3.4 && lin <= 4.6 ? 'LINEARITY-OK' : 'LINEARITY-RECORDED'}`);
  // Variance-proof gate: threads must engage usefully. Absolute ratios swing
  // with box clocks/load (serial compute degrades faster than the shared
  // bandwidth wall), so the +/-15% verdict above is reported, not gated.
  if (!(speedups[2] > speedups[0] && speedups[2] >= 1.5)) {
    console.error('bandPool: 4-worker pool is not usefully faster than single — investigate');
    process.exit(1);
  }
}
