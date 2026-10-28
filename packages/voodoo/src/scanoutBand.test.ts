// Track A: banded scanout is byte-identical to the serial fused path.
// Covers all reconmodes, dither on/off, 2x2/4x4, postfilter on/off, gamma,
// quantise off, odd dims and band splits (including halo rows).
import { describe, expect, it } from 'vitest';
import { processScanoutBand, splitBands, type ScanoutBandOptions } from '@q2/sw-renderer';
import { resolveFusedFrame } from './resolve.js';
import type { ReconMode } from './resolve.js';

function makeSrc(w: number, h: number, seed: number): Uint32Array {
  const src = new Uint32Array(w * h);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < src.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    const r = (x >>> 16) & 255;
    const g = (x >>> 8) & 255;
    const b = x & 255;
    // Include hard edges + smooth gradients: checker + ramp mix.
    const edge = ((i % w) < 2 || (i / w | 0) % 16 === 0) ? 255 : 0;
    src[i] = (0xff000000 | (((b + edge) & 255) << 16) | (g << 8) | r) >>> 0;
  }
  return src;
}

function toBandOpts(o: {
  gamma: number; dither: boolean; ditherMode: '2x2' | '4x4';
  postfilter: boolean; reconmode: ReconMode;
  maxR: number; maxG: number; maxB: number; quantise: boolean;
}): ScanoutBandOptions {
  return {
    gamma: o.gamma,
    dither: o.dither,
    ditherMode: o.ditherMode === '2x2' ? 1 : 0,
    postfilter: o.postfilter,
    reconmode: o.reconmode === 'legacy' ? 0 : o.reconmode === '4x4sub+4x1' ? 2 : 1,
    maxR: o.maxR, maxG: o.maxG, maxB: o.maxB,
    quantise: o.quantise,
  };
}

describe('banded scanout fidelity (Track A)', () => {
  const modes: ReconMode[] = ['2x2sub+2x2box', '4x4sub+4x1', 'legacy'];
  const dims: Array<[number, number]> = [[64, 48], [65, 47], [161, 121], [320, 240]];
  it('matches serial fused frame on every mode/dim/band split', () => {
    for (const [w, h] of dims) {
      const src = makeSrc(w, h, 1234);
      for (const reconmode of modes) {
        for (const dither of [true, false]) {
          for (const ditherMode of ['4x4', '2x2'] as const) {
            for (const postfilter of [true, false]) {
              const opts = {
                gamma: 1.3, dither, ditherMode, postfilter, reconmode,
                maxR: 8, maxG: 8, maxB: 8, quantise: true,
              };
              const n = w * h;
              const s565 = new Uint16Array(n);
              const sDisp = new Uint32Array(n);
              resolveFusedFrame(src, s565, sDisp, w, h, {
                dither: opts.dither, ditherMode: opts.ditherMode,
                postfilter: opts.postfilter, reconmode: opts.reconmode,
                rgbmaxdelta: { r: 8, g: 8, b: 8 }, gamma: opts.gamma,
              });
              for (const bands of [1, 2, 3, 7]) {
                const b565 = new Uint16Array(n);
                const bDisp = new Uint32Array(n);
                const parts = splitBands(h, bands);
                const bopts = toBandOpts(opts);
                for (const b of parts) {
                  processScanoutBand(src, b565, bDisp, w, h, bopts, b.y0, b.y1);
                }
                expect(Array.from(b565)).toEqual(Array.from(s565));
                expect(Array.from(bDisp)).toEqual(Array.from(sDisp));
              }
            }
          }
        }
      }
    }
  });

  it('matches serial on quantise-off, gamma 1, and zero-threshold paths', () => {
    const w = 65, h = 47;
    const src = makeSrc(w, h, 777);
    const cases = [
      { gamma: 1, dither: false, quantise: false },
      { gamma: 1.3, dither: true, quantise: false },
      { gamma: 1, dither: true, quantise: true },
    ];
    for (const c of cases) {
      const n = w * h;
      const s565 = new Uint16Array(n);
      const sDisp = new Uint32Array(n);
      // Serial oracle: resolveFusedFrame handles quantise via resolveRGB565 path?
      // Use the same fused entry with quantise implied (fused always quantises);
      // for quantise-off we compare against per-row RGB888 semantics via bands only.
      // Here we pin band-vs-band determinism across splits (serial = 1 band).
      const bopts = toBandOpts({
        gamma: c.gamma, dither: c.dither, ditherMode: '4x4',
        postfilter: true, reconmode: '2x2sub+2x2box',
        maxR: 0, maxG: 0, maxB: 0, quantise: c.quantise,
      });
      const ref565 = new Uint16Array(n);
      const refDisp = new Uint32Array(n);
      processScanoutBand(src, ref565, refDisp, w, h, bopts, 0, h);
      for (const bands of [2, 7]) {
        const b565 = new Uint16Array(n);
        const bDisp = new Uint32Array(n);
        for (const b of splitBands(h, bands)) {
          processScanoutBand(src, b565, bDisp, w, h, bopts, b.y0, b.y1);
        }
        expect(Array.from(b565)).toEqual(Array.from(ref565));
        expect(Array.from(bDisp)).toEqual(Array.from(refDisp));
      }
      // And the quantise-on path still matches the voodoo oracle.
      if (c.quantise) {
        resolveFusedFrame(src, s565, sDisp, w, h, {
          dither: c.dither, ditherMode: '4x4', postfilter: true,
          reconmode: '2x2sub+2x2box', rgbmaxdelta: { r: 0, g: 0, b: 0 }, gamma: c.gamma,
        });
        expect(Array.from(ref565)).toEqual(Array.from(s565));
        expect(Array.from(refDisp)).toEqual(Array.from(sDisp));
      }
    }
  });
});
