// RGB alias correctness: depth-bias/UV/LOD invariants + material opacity.
//
// Covers the confirmed Voodoo viewmodel defects (all asset-free):
// 1. depthScale must not alter UV mapping: drawAliasInstanceRGB stored
//    iz*depthScale in v.iz but u*iz/v*iz with the unscaled iz, so the
//    filler recovered u = u_true/depthScale (the depthHack gun sampled at
//    u/3: black + holes). Ordinary AND near-clipped paths must interpolate
//    identically under depthScale 1 vs 3 (depth still biased).
// 2. per-tri LOD rho must be texels/pixel (like drawSpansRGB's dudx), not
//    texels*width/pixel — the double-scale forced the coarsest mip on every
//    alias tri (nearly-flat dark gun from edge-repeat averages).
// 3. material opacity: alias (MD2) skins draw index 255 opaque (ref_soft
//    r_polyse/D_DrawPoly has no TRANSPARENT_COLOR check; ref_gl draws
//    meshes opaque, blending only under RF_TRANSLUCENT which rides
//    Entity.alpha), while sprites keep the 255-hole mask (r_spr8.asm).
import { describe, expect, it, afterEach } from 'vitest';
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { setupCamera, type Camera } from './camera.js';
import {
  buildANorms, buildShadeDots, createBoxMesh,
  drawAliasInstanceRGB, type AliasInstance, type AliasMesh, DEPTHHACK_SCALE,
} from './alias.js';
import { buildRGBMaterial } from './spans.js';
import { drawSpriteRGB } from './sprites.js';
import { drawTracerBeam, drawTracerBeamRGB } from './tracer.js';
import { defaultPalette } from './colormap.js';
import { SoftwareRenderer, setRGBWorldEnabled } from './frame.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';

afterEach(() => {
  setRGBWorldEnabled(false);
});

const W = 160, H = 120;

function mkPlanes(): { q: Uint16Array; cover: Uint8Array; depth: Uint16Array } {
  return { q: new Uint16Array(W * H), cover: new Uint8Array(W * H), depth: new Uint16Array(W * H).fill(0xffff) };
}

/** Nonuniform skin: every texel a distinct palette index (no repeats). */
function nonuniformSkin(w: number, h: number): Uint8Array {
  const t = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) t[i] = (i * 7 + 13) & 255;
  return t;
}

function testCam(): Camera {
  return setupCamera(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, W, H);
}

const anorms = buildANorms();
const dots = buildShadeDots(anorms);

function opaqueMat(texels: Uint8Array, w: number, h: number, pal: Uint8Array): ReturnType<typeof buildRGBMaterial> {
  return buildRGBMaterial(texels, w, h, pal, null, {
    addressS: 'clamp', addressT: 'clamp', overbright: false,
    lodBias: -10, mipDither: false, bilinear: false, zbits: 0, opaqueMask: true,
  });
}

describe('depth-bias must not alter UV mapping, interpolation, or LOD', () => {
  it('ordinary tris: depthScale 1 vs 3 draw identical texels', () => {
    const pal = defaultPalette();
    const mesh = createBoxMesh(10);
    const skin = nonuniformSkin(64, 64);
    const mat = opaqueMat(skin, 64, 64, pal);
    const cam = testCam();
    const base: AliasInstance = {
      mesh, origin: new Float32Array([30, 0, 0]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 0, lerp: 0, lightAngle: 40,
    };
    const p1 = mkPlanes();
    const n1 = drawAliasInstanceRGB(p1.q, p1.cover, p1.depth, W, H,
      { ...base, depthScale: 1 }, mat, cam, anorms, dots, null, null);
    const p3 = mkPlanes();
    const n3 = drawAliasInstanceRGB(p3.q, p3.cover, p3.depth, W, H,
      { ...base, depthScale: DEPTHHACK_SCALE }, mat, cam, anorms, dots, null, null);
    expect(n1).toBeGreaterThan(100);
    // identical coverage and identical sampled texels (UV invariant)
    expect(n3).toBe(n1);
    expect([...p3.cover]).toEqual([...p1.cover]);
    expect([...p3.q]).toEqual([...p1.q]);
    // ...but the depth plane IS biased (nearer wins): scaled depth < unscaled
    let checked = 0;
    for (let i = 0; i < W * H; i++) {
      if (p1.cover[i] !== 0) {
        expect(p3.depth[i]!).toBeLessThan(p1.depth[i]!);
        checked++;
      }
    }
    expect(checked).toBe(n1);
  });

  it('near-clipped tris: depthScale 1 vs 3 draw identical texels', () => {
    const pal = defaultPalette();
    // small box so the clipped band stays on screen: half-size 2 centred
    // at near+1 (front verts just behind near, rest visible)
    const mesh = createBoxMesh(2);
    const skin = nonuniformSkin(64, 64);
    const mat = opaqueMat(skin, 64, 64, pal);
    const cam = testCam();
    // straddle the near plane (front verts just behind near, rest visible)
    const base: AliasInstance = {
      mesh, origin: new Float32Array([cam.near + 1, 8, 0]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 0, lerp: 0, lightAngle: 40,
    };
    const p1 = mkPlanes();
    const n1 = drawAliasInstanceRGB(p1.q, p1.cover, p1.depth, W, H,
      { ...base, depthScale: 1 }, mat, cam, anorms, dots, null, null);
    const p3 = mkPlanes();
    const n3 = drawAliasInstanceRGB(p3.q, p3.cover, p3.depth, W, H,
      { ...base, depthScale: DEPTHHACK_SCALE }, mat, cam, anorms, dots, null, null);
    expect(n1).toBeGreaterThan(0);
    expect(n3).toBe(n1);
    expect([...p3.cover]).toEqual([...p1.cover]);
    expect([...p3.q]).toEqual([...p1.q]);
  });

  it('close alias samples the fine mip (no width double-scale)', () => {
    const pal = defaultPalette();
    // Custom front-facing quad (2 tris) with st spanning u/v 0..16: the
    // skin is bright 200 for x<16, black elsewhere. Correct fine sampling
    // reads ~200; the old double-scaled rho (texels*width/pixel) forced a
    // coarse mip whose black padding drags the mean to ~1/4 (the real
    // v_blast failure mode: 5x darker gun from edge-repeat averages).
    // A self-similar skin (e.g. half-bright) would NOT discriminate, since
    // block averaging preserves its mean at every level.
    const quad: AliasMesh = {
      frames: new Float32Array([
        0, -10, -10, 0, -10, 10, 0, 10, 10, 0, 10, -10,
      ]),
      normals: new Uint8Array([0, 0, 0, 0]),
      numVerts: 4,
      numFrames: 1,
      tris: new Uint16Array([0, 2, 1, 0, 3, 2]),
      numTris: 2,
      st: new Float32Array([0, 0, 16, 0, 16, 16, 0, 16]),
    };
    const skin = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) skin[y * 64 + x] = x < 16 ? 200 : 0;
    }
    const cam = testCam();
    const inst: AliasInstance = {
      mesh: quad, origin: new Float32Array([30, 0, 0]), angles: new Float32Array([0, 0, 0]),
      frameA: 0, frameB: 0, lerp: 0, lightAngle: 200, depthScale: DEPTHHACK_SCALE,
    };
    // forced-LOD0 nearest reference (bilinear off, lodBias floors the pick)
    const refMat = buildRGBMaterial(skin, 64, 64, pal, null, {
      addressS: 'clamp', addressT: 'clamp', overbright: false,
      lodBias: -10, mipDither: false, bilinear: false, zbits: 0, opaqueMask: true,
    });
    const pr = mkPlanes();
    const nr = drawAliasInstanceRGB(pr.q, pr.cover, pr.depth, W, H, { ...inst }, refMat, cam, anorms, dots, null, null);
    // production policy (bilinear + true LOD): must agree with the reference
    // within filtering tolerance — the old double-scale picked level ~3 and
    // read ~4x darker.
    const prodMat = buildRGBMaterial(skin, 64, 64, pal, null, {
      addressS: 'clamp', addressT: 'clamp', overbright: false,
      lodBias: 0, mipDither: false, bilinear: true, zbits: 0, opaqueMask: true,
    });
    const pp = mkPlanes();
    const np = drawAliasInstanceRGB(pp.q, pp.cover, pp.depth, W, H, { ...inst }, prodMat, cam, anorms, dots, null, null);
    expect(nr).toBeGreaterThan(100);
    expect(np).toBe(nr);
    let sumR = 0, sumP = 0, n = 0;
    for (let i = 0; i < W * H; i++) {
      if (pr.cover[i] !== 0) {
        sumR += pr.q[i]!;
        sumP += pp.q[i]!;
        n++;
      }
    }
    const meanR = sumR / n, meanP = sumP / n;
    expect(Math.abs(meanP - meanR) / meanR).toBeLessThan(0.25);
  });
});
describe('index-255 transparency by material type', () => {
  it('alias skins draw 255 opaque (no holes, depth written)', () => {
    const pal = defaultPalette();
    const mesh = createBoxMesh(10);
    // every texel 255: fully "transparent" under the sprite rule
    const skin = new Uint8Array(64 * 64).fill(255);
    const mat = buildRGBMaterial(skin, 64, 64, pal, null, {
      addressS: 'clamp', addressT: 'clamp', overbright: false,
      lodBias: -10, mipDither: false, bilinear: false, zbits: 0, opaqueMask: true,
    });
    const cam = testCam();
    const p = mkPlanes();
    const n = drawAliasInstanceRGB(p.q, p.cover, p.depth, W, H,
      {
        mesh, origin: new Float32Array([30, 0, 0]), angles: new Float32Array([0, 0, 0]),
        frameA: 0, frameB: 0, lerp: 0, lightAngle: 40, depthScale: 1,
      }, mat, cam, anorms, dots, null, null);
    expect(n).toBeGreaterThan(100);
    expect(p.cover.reduce((a, b) => a + b, 0)).toBe(n);
    for (let i = 0; i < W * H; i++) {
      if (p.cover[i] !== 0) expect(p.depth[i]).not.toBe(0xffff);
    }
  });

  it('sprites still skip 255 holes (masked)', () => {
    const pal = defaultPalette();
    const texels = new Uint8Array(4 * 4).fill(7);
    texels[2 * 4 + 2] = 255;
    const mat = buildRGBMaterial(texels, 4, 4, pal, null, {
      addressS: 'clamp', addressT: 'clamp', overbright: false,
      lodBias: 0, mipDither: false,
    });
    const cam = testCam();
    const p = mkPlanes();
    const n = drawSpriteRGB(p.q, p.cover, p.depth, W, H,
      { origin: new Float32Array([20, 0, 0]), width: 8, height: 8, texId: 0, grade: 60 },
      [{ width: 4, height: 4, texels }], mat, cam, { spans: [], count: 0 }, 1024);
    expect(n).toBeGreaterThan(0);
    const total = p.cover.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    // bbox fully spanned, so a hole must leave zeros inside it
    let minX = W, maxX = -1, minY = H, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (p.depth[y * W + x]! !== 0xffff) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const area = (maxX - minX + 1) * (maxY - minY + 1);
    expect(total).toBeLessThan(area);
  });
});

describe('frame-level: 255-skinned alias keeps its silhouette in RGB', () => {
  function renderFrame(withEntity: boolean, rgb: boolean): { idx: Uint8Array; color: Uint32Array } {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(defaultPalette());
    const model = r.registerModel({ name: 'holey', kind: 'md2', data: createBoxMesh(8) });
    // the box st samples u 0..32 (left half): all-255 there means every
    // sampled texel is a "hole" under the sprite rule
    const skinTx = new Uint8Array(64 * 64).fill(7);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 32; x++) skinTx[y * 64 + x] = 255;
    const skin = r.registerSkinData('holey', skinTx, 64, 64);
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
      { origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles, fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles },
      { name: 'devroom', data: createDevroom() },
      entities,
    );
    r.endFrame();
    setRGBWorldEnabled(false);
    return { idx: fb.index!.slice(), color: fb.color.slice() };
  }

  it('every classically-drawn entity pixel is RGB-covered (no 255 holes)', () => {
    const W = 160, H = 120;
    // classic silhouette: entity vs bare world, RGB off (same spot as the
    // covered explosion test, so placement is proven non-vacuous)
    const bare = renderFrame(false, false);
    const ent = renderFrame(true, false);
    const sil: number[] = [];
    for (let i = 0; i < W * H; i++) if (ent.idx[i] !== bare.idx[i]) sil.push(i);
    expect(sil.length).toBeGreaterThan(100);
    // RGB renders: bare world vs entity. Where the entity drew classically,
    // its RGB pixels must differ from the bare-world composite (it covered
    // the world there). Pre-fix the masked skin material skipped every
    // sample and the silhouette stayed bare-world (holes).
    const bareRGB = renderFrame(false, true);
    const entRGB = renderFrame(true, true);
    let changed = 0;
    for (const i of sil) if (entRGB.color[i] !== bareRGB.color[i]) changed++;
    expect(changed / sil.length).toBeGreaterThan(0.95);
  });
});

describe('RGB tracer beam placement matches the indexed beam', () => {
  it('non-axis-aligned beam: same drawn pixel set', () => {
    const W2 = 160, H2 = 120;
    // pitched camera: up[0] != 0, so the bdy copy-paste typo (pby where pbx
    // belongs) shifts the RGB b-endpoint off the indexed one. With an
    // axis-aligned camera the typo term vanishes and the test would pass on
    // broken code.
    const cam = setupCamera(new Float32Array([0, 0, 0]), new Float32Array([20, 0, 0]), 90, W2, H2);
    const pal = defaultPalette();
    // diagonal beam (the bdy copy-paste typo only shows off-axis)
    const ax = 60, ay = -10, az = 0, bx = 100, by = 15, bz = 5;
    const idx = new Uint8Array(W2 * H2);
    const zb = new Float32Array(W2 * H2);
    const nIdx = drawTracerBeam(idx, zb, W2, H2, cam, ax, ay, az, bx, by, bz, 225);
    const q = new Uint16Array(W2 * H2);
    const cover = new Uint8Array(W2 * H2);
    const depth = new Uint16Array(W2 * H2).fill(0xffff);
    const nRGB = drawTracerBeamRGB(q, cover, depth, W2, H2, cam, ax, ay, az, bx, by, bz, 225, pal, 215, null, 0);
    expect(nIdx).toBeGreaterThan(10);
    expect(nRGB).toBe(nIdx);
    for (let i = 0; i < W2 * H2; i++) {
      expect(cover[i] !== 0).toBe(idx[i] !== 0);
    }
  });
});
