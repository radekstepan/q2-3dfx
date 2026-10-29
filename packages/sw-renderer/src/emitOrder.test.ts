// PERF-FINISH-A item D: emitter-order invariant guard.
//
// renderView trusts emitSpansForPoly output with ZERO scans (no
// spansBatchIsRowOrdered validation, no sortBatchByRow) at the three
// single-poly emitter sites (world opaque/turbulent, sky-flat, skybox
// faces). This file is the proof that trust is safe: it fuzzes the emitter
// over random projected polys (sizes, positions, winding, degenerate
// inputs) AND end-to-end through projectClippedPoly with a real camera
// (near-clip straddles, viewport clipping), asserting every emitted batch
// is strictly row-ordered with at most one span per row. If a future
// emitter change breaks the invariant, these tests fail LOUDLY instead of
// silently mis-sorting world batches.
import { describe, expect, it } from 'vitest';
import { emitSpansForPoly, createEdgeScratch, projectClippedPoly, type PolyInput } from './edges.js';
import { spansBatchIsRowOrdered } from './frame.js';
import { createSpan, type Span } from './spans.js';
import { setupCamera } from './camera.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makePool(): Span[] {
  const pool: Span[] = [];
  for (let i = 0; i < 4096; i++) pool.push(createSpan());
  return pool;
}

describe('emitter order invariant (PERF-FINISH-A item D)', () => {
  it('random projected polys always emit strictly row-ordered batches', () => {
    const rand = rng(0xE1717);
    const pool = makePool();
    for (let iter = 0; iter < 2000; iter++) {
      const n = 3 + Math.floor(rand() * 6);
      const cx = (rand() - 0.5) * 1200;
      const cy = (rand() - 0.5) * 900;
      const r0 = rand() * 400 + 0.5;
      const poly = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand() * 0.6;
        const r = r0 * (0.3 + rand());
        poly.push({
          x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.75,
          iz: 0.001 + rand() * 0.05, uz: rand() * 64, vz: rand() * 64,
          lu: 0, lv: -1,
        });
      }
      const start = 17; // nonzero base: the slice [start, endCount) is the batch
      const endCount = emitSpansForPoly(poly, n, 0, pool, start, 4096, 63, 0, 480);
      expect(endCount).toBeGreaterThanOrEqual(start);
      expect(spansBatchIsRowOrdered(pool, start, endCount - start)).toBe(true);
      // At most one span per row: strictly increasing y already proves it,
      // but assert the row set explicitly for odd/empty-row robustness.
      const seen = new Set<number>();
      for (let i = start; i < endCount; i++) {
        const y = pool[i]!.y;
        expect(seen.has(y)).toBe(false);
        seen.add(y);
      }
    }
  });

  it('degenerate inputs never violate the invariant', () => {
    const pool = makePool();
    const tri = [
      { x: 10, y: 10, iz: 0.01, uz: 1, vz: 1, lu: 0, lv: -1 },
      { x: 20, y: 10, iz: 0.01, uz: 2, vz: 1, lu: 0, lv: -1 },
      { x: 15, y: 20, iz: 0.01, uz: 1, vz: 2, lu: 0, lv: -1 },
    ];
    // count < 3: no spans, batch empty (ordered by definition).
    expect(emitSpansForPoly(tri, 2, 0, pool, 0, 4096, 63, 0, 480)).toBe(0);
    expect(spansBatchIsRowOrdered(pool, 0, 0)).toBe(true);
    // Collinear (zero area): no spans.
    const flat = [
      { x: 10, y: 10, iz: 0.01, uz: 1, vz: 1, lu: 0, lv: -1 },
      { x: 20, y: 10, iz: 0.01, uz: 2, vz: 1, lu: 0, lv: -1 },
      { x: 30, y: 10, iz: 0.01, uz: 3, vz: 1, lu: 0, lv: -1 },
    ];
    const e1 = emitSpansForPoly(flat, 3, 0, pool, 0, 4096, 63, 0, 480);
    expect(spansBatchIsRowOrdered(pool, 0, e1)).toBe(true);
    // Fully off-screen: no spans.
    const off = tri.map((p) => ({ ...p, x: p.x + 5000, y: p.y + 5000 }));
    const e2 = emitSpansForPoly(off, 3, 0, pool, 5, 4096, 63, 0, 480);
    expect(e2).toBe(5);
    // Single-pixel poly: at most one span.
    const px = [
      { x: 10.4, y: 10.4, iz: 0.01, uz: 1, vz: 1, lu: 0, lv: -1 },
      { x: 10.6, y: 10.4, iz: 0.01, uz: 1, vz: 1, lu: 0, lv: -1 },
      { x: 10.5, y: 10.6, iz: 0.01, uz: 1, vz: 1, lu: 0, lv: -1 },
    ];
    const e3 = emitSpansForPoly(px, 3, 0, pool, 0, 4096, 63, 0, 480);
    expect(e3 - 0).toBeLessThanOrEqual(1);
    expect(spansBatchIsRowOrdered(pool, 0, e3)).toBe(true);
  });

  it('project + clip + emit stays ordered end-to-end (near straddles, viewport clip)', () => {
    const rand2 = rng(0xC110);
    const cam = setupCamera(
      new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, 320, 240,
    );
    const scratch = createEdgeScratch(64);
    const pool = makePool();
    const verts = new Float32Array(8 * 3);
    const uvs = new Float32Array(8 * 2);
    const lux = new Float32Array(8 * 2);
    for (let iter = 0; iter < 1500; iter++) {
      const n = 3 + Math.floor(rand2() * 5);
      // Quads scattered around the camera: some fully inside, some
      // straddling the near plane, some half out of the viewport.
      const cx = (rand2() - 0.5) * 300;
      const cy = (rand2() - 0.5) * 200;
      const cz = 4 + rand2() * 120;
      const r = 2 + rand2() * 60;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rand2() * 0.8;
        verts[i * 3] = cx + Math.cos(a) * r;
        verts[i * 3 + 1] = cy + Math.sin(a) * r;
        verts[i * 3 + 2] = cz + (rand2() - 0.5) * r * 2;
        uvs[i * 2] = rand2() * 64;
        uvs[i * 2 + 1] = rand2() * 64;
        lux[i * 2] = rand2() * 4;
        lux[i * 2 + 1] = rand2() * 4;
      }
      const input: PolyInput = { verts, uvs, lux, n };
      const nproj = projectClippedPoly(input, cam, 320, 240, scratch);
      if (nproj < 3) continue;
      const endCount = emitSpansForPoly(scratch.poly, nproj, 0, pool, 0, 4096, 63, 0, 240);
      expect(spansBatchIsRowOrdered(pool, 0, endCount)).toBe(true);
    }
  });
});
