// M3.1 tests: span rasteriser exactness + subdivision math.
import { describe, expect, it } from 'vitest';
import {
  SUBDIV, SPAN_OPAQUE,
  createSpan, runSubdiv16, drawSpansSoftware,
  type SpanList,
} from './spans.js';
import { buildColormap, defaultPalette } from './colormap.js';

/** colormap grade passthrough: row g -> all entries g (isolates light math). */
function gradeColormap(): Uint8Array {
  const c = new Uint8Array(64 * 256);
  for (let g = 0; g < 64; g++) c.fill(g, g * 256, g * 256 + 256);
  return c;
}

/** texel passthrough colormap: idx = texel (isolates texture math). */
function texelColormap(): Uint8Array {
  const c = new Uint8Array(64 * 256);
  for (let g = 0; g < 64; g++) {
    for (let t = 0; t < 256; t++) c[g * 256 + t] = t;
  }
  return c;
}

function flatTex(w: number, h: number, v: number): Uint8Array {
  return new Uint8Array(w * h).fill(v);
}

describe('runSubdiv16 normative loop', () => {
  it('uses 16px subdivisions (SUBDIV constant)', () => {
    expect(SUBDIV).toBe(16);
  });

  it('constant gradients write exact texel+grade every pixel (16px)', () => {
    const idx = new Uint8Array(16);
    const zb = new Float32Array(16);
    const texels = flatTex(4, 4, 7);
    const colormap = gradeColormap();
    // u=v=0 constant, iz constant, light grade 40 constant
    const r = runSubdiv16(idx, zb, 0, 16,
      0.25, 0, 0, 0, 0, 0, 0, 0, 40, 0,
      texels, 2, 3, 3, colormap);
    expect(idx.every((v) => v === 40)).toBe(true);
    expect(zb.every((z) => z === 0.25)).toBe(true);
    // chaining values equal the direct perspective evaluation
    expect(r.u1).toBeCloseTo(0, 12);
    expect(r.v1).toBeCloseTo(0, 12);
    expect(r.iz).toBeCloseTo(0.25, 12);
    expect(r.light).toBeCloseTo(40, 12);
  });

  it('partial tail subdivision (16+4 chain) stays exact for constants', () => {
    const idx = new Uint8Array(20);
    const zb = new Float32Array(20);
    const texels = flatTex(8, 8, 9);
    const colormap = gradeColormap();
    let iz = 0.5, uz = 0, vz = 0, u0 = 0, v0 = 0, light = 20;
    let o = 0;
    for (const n of [16, 4]) {
      const r = runSubdiv16(idx, zb, o, n, iz, 0, uz, 0, vz, 0, u0, v0, light, 0,
        texels, 3, 7, 7, colormap);
      iz = r.iz; light = r.light; u0 = r.u1; v0 = r.v1; o += n;
    }
    expect(idx.every((v) => v === 20)).toBe(true);
  });

  it('1/z depth test: nearer (larger iz) wins, equal keeps first', () => {
    const idx = new Uint8Array([9, 9, 9, 9]);
    const zb = new Float32Array([0.1, 0.1, 0.9, 0.9]);
    const texels = flatTex(4, 4, 3);
    const colormap = gradeColormap();
    runSubdiv16(idx, zb, 0, 4, 0.5, 0, 0, 0, 0, 0, 0, 0, 5, 0,
      texels, 2, 3, 3, colormap);
    // first two pixels: 0.5 > 0.1 -> drawn; last two: 0.5 < 0.9 -> kept
    expect([...idx]).toEqual([5, 5, 9, 9]);
    expect(zb[0]).toBeCloseTo(0.5, 6);
    expect(zb[2]).toBeCloseTo(0.9, 6);
  });

  it('light gradient steps per pixel with (light << 8) truncation', () => {
    const idx = new Uint8Array(4);
    const zb = new Float32Array(4);
    const texels = flatTex(4, 4, 0);
    const colormap = gradeColormap();
    runSubdiv16(idx, zb, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0, 10, 2.5,
      texels, 2, 3, 3, colormap);
    // grades: 10, 12, 15, 17 (float truncate toward zero)
    expect([...idx]).toEqual([10, 12, 15, 17]);
  });

  it('u1/v1 equal direct perspective evaluation (one division per 16px)', () => {
    const idx = new Uint8Array(16);
    const zb = new Float32Array(16);
    const texels = flatTex(16, 16, 1);
    const colormap = texelColormap();
    const iz = 0.02, diz = 0.0007, uz = 1.3, duz = 0.11, vz = 0.7, dvz = -0.05;
    const u0 = uz / iz, v0 = vz / iz;
    const r = runSubdiv16(idx, zb, 0, 16, iz, diz, uz, duz, vz, dvz, u0, v0,
      63, 0, texels, 4, 15, 15, colormap);
    expect(r.u1).toBeCloseTo((uz + duz * 16) / (iz + diz * 16), 12);
    expect(r.v1).toBeCloseTo((vz + dvz * 16) / (iz + diz * 16), 12);
  });

  it('subdivided sampling matches float reference within 1 texel', () => {
    const W = 64;
    const idx = new Uint8Array(W);
    const zb = new Float32Array(W);
    // gradient texture: texel = x (isolates u sampling)
    const texels = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) texels[y * 64 + x] = x;
    const colormap = texelColormap();
    const iz = 0.01, diz = 0.00021, uz = 0.05, duz = 0.004, vz = 2, dvz = 0;
    let ciz = iz, cuz = uz, cvz = vz, u0 = uz / iz, v0 = vz / iz, o = 0;
    let rem = W;
    while (rem > 0) {
      const n = rem >= 16 ? 16 : rem;
      const r = runSubdiv16(idx, zb, o, n, ciz, diz, cuz, duz, cvz, dvz, u0, v0,
        63, 0, texels, 6, 63, 63, colormap);
      ciz = r.iz; cuz += duz * n; cvz += dvz * n; u0 = r.u1; v0 = r.v1; o += n; rem -= n;
    }
    // float reference: per-pixel exact perspective, truncation like fixed math
    let bad = 0;
    for (let x = 0; x < W; x++) {
      const z = iz + diz * x;
      const want = (((uz + duz * x) / z) | 0) & 63;
      if (Math.abs(idx[x]! - want) > 1) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe('drawSpansSoftware batch', () => {
  it('draws a fixed camera span to an exact pinned buffer', () => {
    const W = 8, H = 2;
    const idx = new Uint8Array(W * H);
    const zb = new Float32Array(W * H);
    // 4x4 texture with distinct texels, identity-ish grade colormap
    const texels = new Uint8Array(16);
    for (let i = 0; i < 16; i++) texels[i] = 100 + i;
    const colormap = buildColormap(defaultPalette());
    const s = createSpan();
    s.kind = SPAN_OPAQUE;
    s.y = 1; s.x0 = 1; s.x1 = 7;
    s.iz = 0.5; s.diz = 0;
    s.uz = 0; s.duz = 0.5 * 0.5; // u = 0.5*x' ... see below
    s.vz = 0; s.dvz = 0;
    s.light = 63; s.dlight = 0;
    s.lu = 0; s.lv = -1; s.dlu = 0; s.turb = 0; s.ord = 0;
    // u(x) = uz/iz with uz = duz*(x - x0): u = 0.5*(x-1) -> texels 0,0,1,1,2,2
    const list: SpanList = { spans: [s], count: 1 };
    const r = drawSpansSoftware(idx, zb, W, H, list,
      { width: 4, height: 4, texels },
      { width: 1, height: 1, values: new Uint8Array([63]) }, colormap);
    expect(r.pixels).toBe(6);
    expect(r.spans).toBe(1);
    const row1 = [...idx.slice(W, 2 * W)];
    // pinned: constant v=0 row, u = 0,.5,1,1.5,2,2.5 -> texel (u&3) = 0,0,1,1,2,2
    const g63 = colormap[(63 << 8) + 0]!;
    void g63;
    expect(row1[0]).toBe(0);
    for (let k = 0; k < 6; k++) {
      const u = (k * 0.5) | 0;
      expect(row1[k + 1]).toBe(colormap[(63 << 8) + texels[u]!]!);
    }
    expect(row1[7]).toBe(0);
    expect([...idx.slice(0, W)].every((v) => v === 0)).toBe(true);
  });

  it('skips turbulent + flat spans (kind dispatch, no pixel-loop branch)', () => {
    const idx = new Uint8Array(4);
    const zb = new Float32Array(4);
    const texels = flatTex(4, 4, 5);
    const a = createSpan();
    a.y = 0; a.x0 = 0; a.x1 = 4; a.iz = 1; a.kind = 1; // turbulent
    const b = createSpan();
    b.y = 0; b.x0 = 0; b.x1 = 4; b.iz = 1; b.kind = 2; // flat
    const list: SpanList = { spans: [a, b], count: 2 };
    const r = drawSpansSoftware(idx, zb, 4, 1, list,
      { width: 4, height: 4, texels },
      { width: 1, height: 1, values: new Uint8Array([63]) }, gradeColormap());
    expect(r.spans).toBe(0);
    expect(idx.every((v) => v === 0)).toBe(true);
  });
});
