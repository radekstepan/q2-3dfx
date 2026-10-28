// RGB alias skin correctness: clamp addressing + gutter-LOD policy.
//
// Covers the confirmed "black areas on barrels/enemies" Voodoo defect
// (all asset-free):
// 1. fillPerspTriRGB must honor the material address mode. Alias materials
//    are clamp (frame.ts rgbMaterialForAlias) but the filler hardcoded
//    repeat for the hole-test tap and all four bilinear taps, so edge taps
//    wrapped to the opposite skin edge — usually black gutter — fringing
//    every UV-island border dark.
// 2. Alias LOD must carry ALIAS_LOD_BIAS_DELTA. Real MD2 skins are ~40%
//    pure-black gutter around thin mapped islands; the shared vd_lodbias
//    parks mid-range models (rho 2-4) on coarse box-filtered mips that
//    average to gutter grey, and the shadow side renders flat black while
//    software (affine L0, never mips alias) keeps the mottling. Measured:
//    soldier yaw90 @120u, entity-isolated pre-resolve: bias -0.35 -> 29.4%
//    pure-black pixels, -1 -> 6.5%, -2 -> 1.7% (floor).
import { describe, expect, it, afterEach } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { setupCamera } from './camera.js';
import {
  buildANorms, buildShadeDots,
  drawAliasInstanceRGB, type AliasInstance, type AliasMesh,
} from './alias.js';
import { buildRGBMaterial, expandRGB565 } from './spans.js';
import { defaultPalette } from './colormap.js';
import { SoftwareRenderer, setRGBWorldEnabled, ALIAS_LOD_BIAS_DELTA } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';

afterEach(() => {
  setRGBWorldEnabled(false);
});

const W = 160, H = 120;

function mkPlanes(): { q: Uint16Array; cover: Uint8Array; depth: Uint16Array } {
  return { q: new Uint16Array(W * H), cover: new Uint8Array(W * H), depth: new Uint16Array(W * H).fill(0xffff) };
}

const anorms = buildANorms();
const dots = buildShadeDots(anorms);

/** Light angle whose shade dot for normal 0 is bright (>= 50/63). */
function brightAngle(): number {
  for (let a = 0; a < 256; a++) {
    if (dots[a * 162 + 0]! >= 50) return a;
  }
  return 0;
}

/** First palette index with all channels in [lo, hi]. */
function midIndex(pal: Uint8Array, lo: number, hi: number): number {
  for (let i = 0; i < 256; i++) {
    const r = pal[i * 3]!, g = pal[i * 3 + 1]!, b = pal[i * 3 + 2]!;
    if (r >= lo && r <= hi && g >= lo && g <= hi && b >= lo && b <= hi) return i;
  }
  throw new Error('no mid palette index');
}

function mean565(q: Uint16Array, cover: Uint8Array): { mean: number; n: number } {
  const scratch = new Uint8Array(3);
  let sum = 0, n = 0;
  for (let i = 0; i < W * H; i++) {
    if (cover[i] !== 0) {
      expandRGB565(q[i]!, scratch, 0);
      sum += (scratch[0]! + scratch[1]! + scratch[2]!) / 3;
      n++;
    }
  }
  return { mean: n ? sum / n : 0, n };
}

describe('alias filler honors clamp addressing', () => {
  it('taps outside the right edge clamp, never wrap to the far edge', () => {
    const pal = defaultPalette();
    const mid = midIndex(pal, 100, 170);
    // skin: everything black except the rightmost column (the clamped edge)
    const skin = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) skin[y * 64 + 63] = mid;
    // quad floats entirely past the right edge (u = 65): clamp reads column
    // 63 (bright), repeat wraps to columns 1-2 (black). Bilinear must be on:
    // the neighbor tap is the discriminator.
    const quad: AliasMesh = {
      frames: new Float32Array([
        0, -10, -10, 0, -10, 10, 0, 10, 10, 0, 10, -10,
      ]),
      normals: new Uint8Array([0, 0, 0, 0]),
      numVerts: 4,
      numFrames: 1,
      tris: new Uint16Array([0, 2, 1, 0, 3, 2]),
      numTris: 2,
      st: new Float32Array([65, 8, 65, 8, 65, 8, 65, 8]),
    };
    const mat = buildRGBMaterial(skin, 64, 64, pal, null, {
      addressS: 'clamp', addressT: 'clamp', overbright: false,
      lodBias: -10, mipDither: false, bilinear: true, zbits: 0, opaqueMask: true,
    });
    const cam = setupCamera(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, W, H);
    const inst: AliasInstance = {
      mesh: quad, origin: new Float32Array([30, 0, 0]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 0, lerp: 0, lightAngle: brightAngle(),
    };
    const p = mkPlanes();
    const n = drawAliasInstanceRGB(p.q, p.cover, p.depth, W, H, inst, mat, cam, anorms, dots, null, null);
    expect(n).toBeGreaterThan(100);
    // expected sample: palette[mid] scaled by the vertex light (grade/63).
    // 565 expand replicates top bits: allow a quantum of slop either way.
    // Pre-fix (wrap) samples black columns: mean collapses to ~10% of this.
    const grade = dots[(inst.lightAngle & 255) * 162 + 0]! / 63;
    const er = pal[mid * 3]! * grade;
    const eg = pal[mid * 3 + 1]! * grade;
    const eb = pal[mid * 3 + 2]! * grade;
    const scratch = new Uint8Array(3);
    let sr = 0, sg = 0, sb = 0, cn = 0;
    for (let i = 0; i < W * H; i++) {
      if (p.cover[i] !== 0) {
        expandRGB565(p.q[i]!, scratch, 0);
        sr += scratch[0]!;
        sg += scratch[1]!;
        sb += scratch[2]!;
        cn++;
      }
    }
    expect(Math.abs(sr / cn - er) / Math.max(er, 1)).toBeLessThan(0.25);
    expect(Math.abs(sg / cn - eg) / Math.max(eg, 1)).toBeLessThan(0.25);
    expect(Math.abs(sb / cn - eb) / Math.max(eb, 1)).toBeLessThan(0.25);
  });
});

describe('alias LOD bias defeats gutter poisoning', () => {
  // gutter skin: solid mid island (32x32 at u 96..128, v 0..32) with black
  // gutter immediately right (x>=128) — proportionally thin like real MD2
  // skin islands, so coarse box-filter mips mix gutter into the island.
  function gutterSkin(): Uint8Array {
    const pal = defaultPalette();
    const mid = midIndex(pal, 100, 170);
    const t = new Uint8Array(256 * 256);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) t[y * 256 + x] = x < 128 ? mid : 0;
    }
    return t;
  }

  function islandQuad(): AliasMesh {
    return {
      frames: new Float32Array([
        0, -2, -2, 0, -2, 2, 0, 2, 2, 0, 2, -2,
      ]),
      normals: new Uint8Array([0, 0, 0, 0]),
      numVerts: 4,
      numFrames: 1,
      tris: new Uint16Array([0, 2, 1, 0, 3, 2]),
      numTris: 2,
      st: new Float32Array([96, 0, 128, 0, 128, 32, 96, 32]),
    };
  }

  it('ALIAS_LOD_BIAS_DELTA lands the default bias on the measured floor', () => {
    // soldier yaw90 @120u needed total -2, thin-island bolt @40u total
    // -3.65: the delta must take the default (-0.35) to ~-3.65 or finer.
    expect(-0.35 + ALIAS_LOD_BIAS_DELTA).toBeLessThanOrEqual(-3.5);
  });

  it('delta-biased sampling matches L0 on a gutter island; shared bias goes dark', () => {
    const pal = defaultPalette();
    const skin = gutterSkin();
    const mesh = islandQuad();
    const cam = setupCamera(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, W, H);
    const inst: AliasInstance = {
      mesh, origin: new Float32Array([30, 0, 0]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 0, lerp: 0, lightAngle: brightAngle(),
    };
    const mk = (bias: number): ReturnType<typeof buildRGBMaterial> =>
      buildRGBMaterial(skin, 256, 256, pal, null, {
        addressS: 'clamp', addressT: 'clamp', overbright: false,
        lodBias: bias, mipDither: true, bilinear: true, zbits: 0, opaqueMask: true,
      });
    const draw = (bias: number): { mean: number; n: number } => {
      const p = mkPlanes();
      drawAliasInstanceRGB(p.q, p.cover, p.depth, W, H, { ...inst }, mk(bias), cam, anorms, dots, null, null);
      return mean565(p.q, p.cover);
    };
    const ref = draw(-10);
    expect(ref.n).toBeGreaterThan(50);
    const shared = draw(-0.35);
    const alias = draw(-0.35 + ALIAS_LOD_BIAS_DELTA);
    expect(alias.n).toBe(ref.n);
    // delta-biased ≈ L0 reference (texture kept, not gutter average)
    expect(Math.abs(alias.mean - ref.mean) / Math.max(ref.mean, 1)).toBeLessThan(0.15);
    // ...while the shared world bias is dramatically darker (fail-before:
    // removing the delta makes `alias` identical to `shared`)
    expect(shared.mean).toBeLessThan(alias.mean * 0.6);
  });

  it('frame-level RGB/software parity on a gutter-skinned entity', () => {
    // End-to-end wiring: SoftwareRenderer must build alias materials with
    // the delta (not the shared bias). Gutter-skinned quad entity in the
    // devroom at rho ~4; RGB mean must sit in the same band as the software
    // reference (the web release gate uses 0.5x..3.0x; pre-fix ~0.4x here).
    const pal = defaultPalette();
    const W2 = 160, H2 = 120;
    const mesh = islandQuad();
    // bigger quad for frame-level pixel count (same island UVs): 12u wide
    // at ~125u reads ~8 screen px, rho ~4 — the shared bias sits on L2/L3
    // gutter averages, the delta bias on L0.
    const big = {
      ...mesh,
      frames: new Float32Array([
        0, -6, -6, 0, -6, 6, 0, 6, 6, 0, 6, -6,
      ]),
    };
    const render = (withEntity: boolean, rgb: boolean): { idx: Uint8Array; color: Uint32Array } => {
      const fb = createFramebuffer(W2, H2, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pal);
      const model = r.registerModel({ name: 'gutterbox', kind: 'md2', data: big });
      const skinTx = gutterSkin();
      const skin = r.registerSkinData('gutter', skinTx, 256, 256);
      const styles = new Float32Array(256).fill(1);
      const entities: Entity[] = withEntity ? [{
        model,
        origin: new Float32Array([-88, 0, 100]),
        angles: new Float32Array([0, 0, 0]),
        frame: 0,
        skin,
      }] : [];
      setRGBWorldEnabled(rgb);
      r.beginFrame();
      r.renderView(
        {
          origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
          fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles,
        },
        { name: 'devroom', data: createDevroom() },
        entities,
      );
      r.endFrame();
      setRGBWorldEnabled(false);
      return { idx: fb.index!.slice(), color: fb.color.slice() };
    };
    const lum = (px: number): number => ((px & 255) + ((px >> 8) & 255) + ((px >> 16) & 255)) / 3;
    const bare = render(false, false);
    const ent = render(true, false);
    const sil: number[] = [];
    for (let i = 0; i < W2 * H2; i++) if (ent.idx[i] !== bare.idx[i]) sil.push(i);
    expect(sil.length).toBeGreaterThan(20);
    let swSum = 0;
    for (const i of sil) swSum += lum(ent.color[i]!);
    const swMean = swSum / sil.length;
    const bareRGB = render(false, true);
    const entRGB = render(true, true);
    let vdSum = 0, vdN = 0;
    for (const i of sil) {
      if (entRGB.color[i] !== bareRGB.color[i]) {
        vdSum += lum(entRGB.color[i]!);
        vdN++;
      }
    }
    // the entity must actually cover in RGB (no holes) ...
    expect(vdN / sil.length).toBeGreaterThan(0.8);
    const vdMean = vdSum / vdN;
    // ... at software-comparable brightness.
    expect(vdMean).toBeGreaterThan(0.5 * swMean);
    expect(vdMean).toBeLessThan(3.0 * swMean);
  });
});
