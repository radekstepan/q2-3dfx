// PERF-3 fused pack→recon→gamma pins: byte-identical to the manual 3-pass
// pipeline across every vd_* combo, gamma, threshold and odd dimensions.
import { describe, expect, it } from 'vitest';
import {
  applyDisplayGamma,
  applyPostFilter,
  applyReconstruction2x2,
  applyReconstruction4x1,
  defaultVoodooState,
  expandRGB565,
  resolveFrame,
  resolveRGB565,
  type DitherMode,
  type ReconMode,
  type RgbMaxDelta,
  type VoodooState,
} from './index.js';

function makeSrc(w: number, h: number, seed: number): Uint32Array {
  const src = new Uint32Array(w * h);
  let s = seed >>> 0;
  for (let i = 0; i < w * h; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const n = (s >>> 16) & 255;
    const r = (i * 13 + n) & 255;
    const g = (i * 29 + (n >> 1)) & 255;
    const b = (i * 7 + (n >> 2)) & 255;
    src[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return src;
}

/** Manual 3-pass oracle: linear pack -> recon/box -> display gamma. */
function manualPipeline(src: Uint32Array, w: number, h: number, st: VoodooState): { dst: Uint16Array; display: Uint32Array } {
  const dst = new Uint16Array(w * h);
  const display = new Uint32Array(w * h);
  resolveRGB565(src, dst, w, h, { gamma: 1, dither: st.dither, ditherMode: st.dithermode, quantise: true });
  if (!st.postfilter) {
    for (let i = 0; i < w * h; i++) display[i] = expandRGB565(dst[i]!);
  } else if (st.reconmode === 'legacy') {
    applyPostFilter(dst, display, w, h);
  } else if (st.reconmode === '2x2sub+2x2box') {
    applyReconstruction2x2(dst, display, w, h, st.rgbmaxdelta, st.dither ? '2x2' : null);
  } else {
    applyReconstruction4x1(dst, display, w, h, st.rgbmaxdelta, st.dither ? '4x4' : null);
  }
  applyDisplayGamma(display, w, h, st.gamma);
  return { dst, display };
}

const SIZES: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [2, 2],
  [3, 5],
  [5, 3],
  [7, 1],
  [1, 7],
  [5, 5],
  [6, 5],
  [9, 7],
  [16, 9],
];
const DITHERS = [true, false];
const DMODES: DitherMode[] = ['4x4', '2x2'];
const POSTS = [true, false];
const RECONS: ReconMode[] = ['legacy', '2x2sub+2x2box', '4x4sub+4x1'];
const GAMMAS = [1, 1.3];
const DELTAS: RgbMaxDelta[] = [
  { r: 8, g: 8, b: 8 },
  { r: 0, g: 0, b: 0 },
  { r: 8, g: 0, b: 8 },
  { r: 255, g: 255, b: 255 },
];

describe('fused resolveFrame == manual pipeline (PERF-3 equivalence)', () => {
  it('matches dst565 + display on every combo x size (odd dims incl. 1xN/Nx1)', () => {
    let combos = 0;
    for (const [w, h] of SIZES) {
      const src = makeSrc(w, h, w * 1000 + h + 7);
      for (const dither of DITHERS)
        for (const dithermode of DMODES)
          for (const postfilter of POSTS)
            for (const reconmode of RECONS)
              for (const gamma of GAMMAS)
                for (const rgbmaxdelta of DELTAS) {
                  const st: VoodooState = { ...defaultVoodooState(), dither, dithermode, postfilter, reconmode, gamma, rgbmaxdelta };
                  const a565 = new Uint16Array(w * h);
                  const aDisp = new Uint32Array(w * h).fill(0xdeadbeef);
                  resolveFrame(src, a565, aDisp, w, h, st);
                  const m = manualPipeline(src, w, h, st);
                  expect(a565).toEqual(m.dst);
                  expect(aDisp).toEqual(m.display);
                  combos++;
                }
    }
    expect(combos).toBe(SIZES.length * 2 * 2 * 2 * 3 * 2 * 4);
  });
  it('leaves no stale pixels and is deterministic across repeats', () => {
    const w = 9;
    const h = 7;
    const src = makeSrc(w, h, 1234);
    for (const reconmode of RECONS) {
      const st: VoodooState = { ...defaultVoodooState(), reconmode };
      const a = new Uint32Array(w * h).fill(0xdeadbeef);
      const a565 = new Uint16Array(w * h);
      resolveFrame(src, a565, a, w, h, st);
      for (let i = 0; i < w * h; i++) expect(a[i]).not.toBe(0xdeadbeef);
      const b = new Uint32Array(w * h);
      const b565 = new Uint16Array(w * h);
      resolveFrame(src, b565, b, w, h, st);
      expect(b).toEqual(a);
      expect(b565).toEqual(a565);
    }
  });
  it('rejects short buffers like the stage functions', () => {
    const st = defaultVoodooState();
    const src = makeSrc(4, 4, 1);
    expect(() => resolveFrame(src, new Uint16Array(15), new Uint32Array(16), 4, 4, st)).toThrow();
    expect(() => resolveFrame(src, new Uint16Array(16), new Uint32Array(15), 4, 4, st)).toThrow();
    expect(() => resolveFrame(new Uint32Array(15), new Uint16Array(16), new Uint32Array(16), 4, 4, st)).toThrow();
  });
});

describe('fused display golden (default state, 64x40 ramp)', () => {
  it('pins the display plane hash (reconstruction + gamma fused)', () => {
    const w = 64;
    const h = 40;
    const src = new Uint32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = (x * 4) & 255;
        const g = (y * 6) & 255;
        const b = ((x + y) * 3) & 255;
        src[y * w + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    const st = defaultVoodooState();
    const dst = new Uint16Array(w * h);
    const display = new Uint32Array(w * h);
    resolveFrame(src, dst, display, w, h, st);
    let hash = 0x811c9dc5;
    for (let i = 0; i < w * h; i++) {
      const d = display[i]!;
      hash ^= d & 255;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= (d >> 8) & 255;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= (d >> 16) & 255;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= (d >> 24) & 255;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    expect(hash.toString(16)).toBe('29f9da92');
  });
});
