// M3.4/M7.2 follow-up: real MD2 -> AliasMesh conversion, real-skin
// registration, tracer beams, gun fallback mesh. Real-asset cases read
// straight out of Q2_PAK and skip without it (BRAIN.md §3); everything else
// is asset-free. The devroom golden (8f61c755) stays pinned by golden.test.ts.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import {
  ANORM_COUNT,
  buildANorms,
  buildShadeDots,
  createBoxMesh,
  createGunMesh,
  createGunSkin,
  createSoldierMesh,
  createSoldierSkin,
  drawAliasInstance,
  isMd2Data,
  md2ToAliasMesh,
  type Md2Like,
} from './alias.js';
import {
  drawTracerBeam,
  TRACER_DEFAULT_COLOR,
  TRACER_DEFAULT_LENGTH,
  TRACER_POOL_SIZE,
} from './tracer.js';
import { nextPot, SoftwareRenderer } from './frame.js';
import { setupCamera } from './camera.js';
import { buildColormap, defaultPalette } from './colormap.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { createFramebuffer } from '@q2/renderer-api';
import { parseMD2, parsePCX } from '@q2/formats';

const Q2_PAK = process.env.Q2_PAK;
const HAVE_PAK = !!Q2_PAK && existsSync(Q2_PAK as string);

function loadReal(name: string): ArrayBuffer {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  const view = new DataView(buf);
  const dirofs = view.getInt32(4, true);
  const dirlen = view.getInt32(8, true);
  const want = name.toLowerCase();
  for (let i = 0; i < dirlen / 64; i++) {
    const base = dirofs + i * 64;
    const raw = new Uint8Array(buf, base, 56);
    let end = 0;
    while (end < 56 && raw[end] !== 0) end++;
    let s = '';
    for (let k = 0; k < end; k++) s += String.fromCharCode(raw[k]);
    if (s.toLowerCase() === want) {
      const off = view.getInt32(base + 56, true);
      const len = view.getInt32(base + 60, true);
      return buf.slice(off, off + len);
    }
  }
  throw new Error(`lump missing in test pak: ${name}`);
}

function testCam() {
  return setupCamera(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]), 90, 64, 64);
}

const colormap = buildColormap(defaultPalette());

/** Minimal synthetic MD2: a quad as two tris over 4 verts / 4 st. */
function quadMd2(seam = false): Md2Like {
  const st = new Int16Array([0, 0, 63, 0, 63, 63, 0, 63]);
  if (seam) {
    // Second tri reuses xyz 0/2 with fresh st verts (sheen seam split).
    return {
      skinWidth: 64, skinHeight: 64,
      numFrames: 1, numVerts: 4, numSt: 6, numTris: 2,
      st: new Int16Array([0, 0, 63, 0, 63, 63, 0, 63, 62, 1, 1, 62]),
      trisXyz: new Uint16Array([0, 1, 2, 0, 2, 3]),
      trisSt: new Uint16Array(seam ? [0, 1, 2, 4, 2, 5] : [0, 1, 2, 0, 2, 3]),
      frames: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
      normals: new Uint8Array([3, 3, 3, 3]),
    };
  }
  return {
    skinWidth: 64, skinHeight: 64,
    numFrames: 1, numVerts: 4, numSt: 4, numTris: 2,
    st,
    trisXyz: new Uint16Array([0, 1, 2, 0, 2, 3]),
    trisSt: new Uint16Array([0, 1, 2, 0, 2, 3]),
    frames: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]),
    normals: new Uint8Array([3, 3, 3, 3]),
  };
}

describe('md2ToAliasMesh (synthetic)', () => {
  it('converts a welded quad 1:1', () => {
    const m = md2ToAliasMesh(quadMd2());
    expect(m).not.toBeNull();
    expect(m!.numVerts).toBe(4);
    expect(m!.numTris).toBe(2);
    expect(m!.numFrames).toBe(1);
    expect([...m!.tris]).toEqual([0, 1, 2, 0, 2, 3]);
    expect(m!.frames[3]).toBeCloseTo(10, 5); // vert 1 x
    expect(m!.st[2]).toBe(63); // st preserved in texel units
    expect(m!.normals).toEqual(new Uint8Array([3, 3, 3, 3]));
  });

  it('splits seam verts sharing xyz with different st', () => {
    const m = md2ToAliasMesh(quadMd2(true));
    expect(m).not.toBeNull();
    // (0,0),(1,1),(2,2),(0,4),(2,2)+,(3,5): the repeated (2,2) reuses a vert.
    expect(m!.numVerts).toBe(5);
  });

  it('clamps st to the skin dims', () => {
    const q = quadMd2();
    q.st = new Int16Array([-5, 0, 999, 0, 63, 63, 0, 63]);
    const m = md2ToAliasMesh(q);
    expect(m).not.toBeNull();
    expect(m!.st[0]).toBe(0);
    expect(m!.st[2]).toBe(63);
  });

  it('rejects out-of-range indices and non-MD2 payloads', () => {
    const bad = quadMd2();
    bad.trisXyz = new Uint16Array([0, 1, 99, 0, 2, 3]);
    expect(md2ToAliasMesh(bad)).toBeNull();
    const badSt = quadMd2();
    badSt.trisSt = new Uint16Array([0, 1, 2, 0, 2, 40]);
    expect(md2ToAliasMesh(badSt)).toBeNull();
    expect(md2ToAliasMesh(null)).toBeNull();
    expect(md2ToAliasMesh({})).toBeNull();
    expect(md2ToAliasMesh(createBoxMesh(8))).toBeNull();
    expect(isMd2Data(quadMd2())).toBe(true);
    expect(isMd2Data(createBoxMesh(8))).toBe(false);
  });
});

describe('gun fallback mesh + skin', () => {
  it('is a multi-box silhouette with recoil frames', () => {
    const g = createGunMesh();
    expect(g.numFrames).toBe(2);
    expect(g.numTris).toBe(48);
    expect(g.numVerts).toBe(144);
    // Recoil: frame 1 shifts -X (compare vert 0 x across frames).
    expect(g.frames[0]! - g.frames[g.numVerts * 3]!).toBeCloseTo(1.5, 5);
    // st spans the skin; normals are valid shade-dot indices.
    for (let i = 0; i < g.st.length; i++) {
      expect(g.st[i]).toBeGreaterThanOrEqual(0);
      expect(g.st[i]).toBeLessThanOrEqual(63);
    }
    for (let i = 0; i < g.normals.length; i++) expect(g.normals[i]).toBeLessThan(ANORM_COUNT);
    const skin = createGunSkin();
    expect(skin.width).toBe(64);
    expect(skin.height).toBe(64);
    // Not flat: highlight rows differ from the body.
    expect(new Set(skin.texels).size).toBeGreaterThan(4);
  });

  it('draws >0 pixels broadside', () => {
    const cam = testCam();
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const idx = new Uint8Array(64 * 64);
    const zb = new Float32Array(64 * 64);
    const skin = createGunSkin();
    // Yaw 90 turns the +X-pointing gun broadside to the +X-looking camera.
    const p = drawAliasInstance(idx, zb, 64, 64, {
      mesh: createGunMesh(),
      origin: new Float32Array([40, 0, 0]), angles: new Float32Array([0, 90, 0]),
      frameA: 0, frameB: 1, lerp: 0.5, lightAngle: 0,
    }, skin, cam, anorms, dots, colormap);
    expect(p).toBeGreaterThan(100);
  });
});

describe('registerModel/registerSkinData', () => {
  function setup() {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(defaultPalette());
    return { r, fb, W, H };
  }

  function devView() {
    return {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
  }

  it('keeps the checker fallback for plain registerSkin', () => {
    const { r } = setup();
    const h = r.registerSkin('monsters/soldier/skin.pcx');
    expect(h).toBe(0);
    // 32x32 checker stored verbatim.
    const skins = (r as unknown as { skins: { width: number; height: number }[] }).skins;
    expect(skins[h]).toMatchObject({ width: 32, height: 32 });
  });

  it('stores POT skins verbatim and expands non-POT by edge repeat', () => {
    const { r } = setup();
    const src = new Uint8Array(64 * 64).map((_, i) => i & 255);
    const h = r.registerSkinData('pot', src, 64, 64);
    const skins = (r as unknown as { skins: { width: number; height: number; texels: Uint8Array }[] }).skins;
    expect(skins[h]).toMatchObject({ width: 64, height: 64 });
    expect(skins[h]!.texels[1234]).toBe(src[1234]);
    // 288x195 soldier-style dims -> 512x256, texel (u,v) preserved.
    const wide = new Uint8Array(288 * 195).map((_, i) => (i * 7) & 255);
    const h2 = r.registerSkinData('wide', wide, 288, 195);
    expect(skins[h2]).toMatchObject({ width: 512, height: 256 });
    expect(nextPot(288)).toBe(512);
    expect(nextPot(195)).toBe(256);
    expect(skins[h2]!.texels[10 * 512 + 20]).toBe(wide[10 * 288 + 20]);
    expect(skins[h2]!.texels[194 * 512 + 287]).toBe(wide[194 * 288 + 287]);
    // Invalid payload falls back to a valid checker handle.
    const h3 = r.registerSkinData('bogus', new Uint8Array(10), 4, 4);
    expect(skins[h3]).toMatchObject({ width: 32, height: 32 });
  });

  it('md2 without data falls back to the gun silhouette and draws', () => {
    const { r, fb } = setup();
    const h = r.registerModel({ name: 'monster', kind: 'md2', data: null });
    expect(h).toBe(0);
    const view = devView();
    const world = { name: 'devroom', data: createDevroom() };
    r.beginFrame();
    r.renderView(view, world, []);
    r.endFrame();
    const idx = fb.index!;
    let h0 = 2166136261;
    for (let i = 0; i < idx.length; i++) {
      h0 ^= idx[i]!;
      h0 = Math.imul(h0, 16777619);
    }
    const base = (h0 >>> 0).toString(16).padStart(8, '0');
    r.beginFrame();
    r.renderView(view, world, [{
      model: h, origin: new Float32Array([-140, 0, 120]), angles: new Float32Array([0, 90, 0]),
      frame: 0, skin: 999, // missing skin -> gunmetal fallback skin
    }]);
    r.endFrame();
    let lit = 2166136261;
    for (let i = 0; i < idx.length; i++) {
      lit ^= idx[i]!;
      lit = Math.imul(lit, 16777619);
    }
    expect((lit >>> 0).toString(16).padStart(8, '0')).not.toBe(base);
    expect(r.testTracerCount()).toBe(0);
  });
});

describe('drawTracerBeam', () => {
  it('draws a visible line, culls behind-camera and depth-fails occluded', () => {
    const cam = testCam();
    const W = 64, H = 64;
    const idx = new Uint8Array(W * H);
    const zb = new Float32Array(W * H);
    const n = drawTracerBeam(idx, zb, W, H, cam, 40, -20, 0, 40, 20, 0, 225);
    expect(n).toBeGreaterThan(10);
    expect(new Set(idx).size).toBeGreaterThan(1);
    // Fully behind the camera -> nothing.
    const idx2 = new Uint8Array(W * H);
    const zb2 = new Float32Array(W * H);
    expect(drawTracerBeam(idx2, zb2, W, H, cam, -40, -20, 0, -40, 20, 0, 225)).toBe(0);
    // Occluder closer than the beam -> depth test rejects every pixel.
    const idx3 = new Uint8Array(W * H);
    const zb3 = new Float32Array(W * H).fill(10);
    expect(drawTracerBeam(idx3, zb3, W, H, cam, 40, -20, 0, 40, 20, 0, 225)).toBe(0);
    expect(idx3.every((v) => v === 0)).toBe(true);
  });
});

describe('tracer entities + spawnTracer pool', () => {
  function setup() {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(defaultPalette());
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    const world = { name: 'devroom', data: createDevroom() };
    const frame = (entities: Parameters<SoftwareRenderer['renderView']>[2]): void => {
      r.beginFrame();
      r.renderView(view, world, entities);
      r.endFrame();
    };
    const hash = (): string => {
      let h = 2166136261;
      const idx = fb.index!;
      for (let i = 0; i < idx.length; i++) {
        h ^= idx[i]!;
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    };
    return { r, frame, hash };
  }

  it("kind-'tracer' entities draw a depth-tested beam", () => {
    const { r, frame, hash } = setup();
    // NOTE: Model.kind stays the frozen 'bsp'|'md2'|'sp2' union (renderer-api
    // is another package's contract) — the renderer switches on the runtime
    // string, so tracer registration casts until a contract-change PR widens it.
    const tracerKind = 'tracer' as unknown as 'sp2';
    const h = r.registerModel({ name: 'tracer', kind: tracerKind, data: null });
    frame([]);
    const base = hash();
    // Broadside beam in open floor near the camera (yaw 90 runs it along +Y).
    frame([{
      model: h, origin: new Float32Array([-140, -20, 120]), angles: new Float32Array([0, 90, 0]),
      frame: 40, skin: 225,
    }]);
    const lit = hash();
    expect(lit).not.toBe(base);
    // Backward beam (behind the camera) draws nothing.
    frame([{
      model: h, origin: new Float32Array([-300, 0, 136]), angles: new Float32Array([0, 0, 0]),
      frame: 32, skin: 225,
    }]);
    expect(hash()).toBe(base);
  });

  it('spawnTracer pool draws then expires (ttl), restoring the frame', () => {
    const { r, frame, hash } = setup();
    frame([]);
    const base = hash();
    expect(r.testTracerCount()).toBe(0);
    expect(r.spawnTracer(new Float32Array([-140, -20, 120]), new Float32Array([0, 1, 0]), 225, 40, 2)).toBe(true);
    expect(r.spawnTracer(new Float32Array([0, 0, 0]), new Float32Array([0, 0, 0]))).toBe(false); // zero dir
    expect(r.testTracerCount()).toBe(1);
    frame([]);
    expect(hash()).not.toBe(base);
    expect(r.testTracerCount()).toBe(1);
    frame([]);
    expect(hash()).not.toBe(base); // ttl 1 -> still drawn
    expect(r.testTracerCount()).toBe(0);
    frame([]);
    expect(hash()).toBe(base); // expired: baseline restored
    expect(TRACER_POOL_SIZE).toBe(64);
    expect(TRACER_DEFAULT_COLOR).toBe(225);
  });
});

describe.runIf(HAVE_PAK)('real pak0.pak MD2 + skins (Q2_PAK)', () => {
  function setupReal() {
    const W = 320, H = 240;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    const pal = parsePCX(loadReal('pics/colormap.pcx')).palette;
    r.setPalette(pal);
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    const world = { name: 'devroom', data: createDevroom() };
    return { r, fb, view, world };
  }

  it('soldier tris.md2 converts and draws >0 pixels with its real skin', () => {
    const { r, fb, view, world } = setupReal();
    const md2 = parseMD2(loadReal('models/monsters/soldier/tris.md2'));
    expect(md2.skinWidth).toBe(288);
    expect(md2.numFrames).toBeGreaterThan(100);
    expect(md2.numTris).toBeGreaterThan(100);
    const mesh = md2ToAliasMesh(md2);
    expect(mesh).not.toBeNull();
    expect(mesh!.numVerts).toBeGreaterThan(100);
    expect(mesh!.numVerts).toBeLessThanOrEqual(mesh!.numTris * 3);
    // Every tri index resolves; st lands inside the POT-expanded skin.
    for (let i = 0; i < mesh!.tris.length; i++) expect(mesh!.tris[i]).toBeLessThan(mesh!.numVerts);
    const skin = parsePCX(loadReal('models/monsters/soldier/skin.pcx'));
    const sh = r.registerSkinPixels('models/monsters/soldier/skin.pcx', skin.pixels, skin.width, skin.height);
    const mh = r.registerModel({ name: 'soldier', kind: 'md2', data: md2 });
    expect(mh).toBe(0);
    r.beginFrame();
    const stats = r.renderView(view, world, [{
      model: mh, origin: new Float32Array([60, 40, 60]), angles: new Float32Array([0, 0, 0]),
      frame: 0, skin: sh,
    }]);
    r.endFrame();
    expect(stats.pixels).toBeGreaterThan(0);
    let colored = 0;
    for (let i = 0; i < fb.index!.length; i++) if (fb.index![i] !== 0) colored++;
    expect(colored).toBeGreaterThan(100);
  });

  it('g_shotg tris.md2 converts and draws >0 pixels', () => {
    const { r, view, world } = setupReal();
    const md2 = parseMD2(loadReal('models/weapons/g_shotg/tris.md2'));
    const mesh = md2ToAliasMesh(md2);
    expect(mesh).not.toBeNull();
    expect(mesh!.numTris).toBe(md2.numTris);
    const skin = parsePCX(loadReal('models/weapons/g_shotg/skin.pcx'));
    const sh = r.registerSkinPixels('models/weapons/g_shotg/skin.pcx', skin.pixels, skin.width, skin.height);
    const mh = r.registerModel({ name: 'g_shotg', kind: 'md2', data: md2 });
    r.beginFrame();
    const stats = r.renderView(view, world, [{
      model: mh, origin: new Float32Array([60, -40, 60]), angles: new Float32Array([0, 90, 0]),
      frame: 0, skin: sh,
    }]);
    r.endFrame();
    expect(stats.pixels).toBeGreaterThan(0);
  });

  it('registerModel accepts AliasMesh directly (back-compat)', () => {
    const { r, view, world } = setupReal();
    const mh = r.registerModel({ name: 'monster', kind: 'md2', data: createBoxMesh(10) });
    const sh = r.registerSkin('monster/checker');
    r.beginFrame();
    const stats = r.renderView(view, world, [{
      model: mh, origin: new Float32Array([60, 40, 60]), angles: new Float32Array([0, 0, 0]),
      frame: 0, skin: sh,
    }]);
    r.endFrame();
    expect(stats.pixels).toBeGreaterThan(0);
  });
});

describe('soldier fallback mesh + skin (asset-free)', () => {
  it('is a humanoid with static frames', () => {
    const m = createSoldierMesh();
    expect(m.numFrames).toBe(2);
    expect(m.numTris).toBe(72); // 6 boxes x 12 tris
    expect(m.numVerts).toBe(216); // 6 boxes x 36 facet verts
    expect(m.frames.length).toBe(2 * 216 * 3);
    // static pose: frame 1 == frame 0
    expect([...m.frames.subarray(0, 216 * 3)]).toEqual([...m.frames.subarray(216 * 3)]);
    for (let i = 0; i < m.normals.length; i++) expect(m.normals[i]).toBeLessThan(ANORM_COUNT);
    const skin = createSoldierSkin();
    expect(skin.width).toBe(64);
    expect(skin.height).toBe(64);
    expect(new Set(skin.texels).size).toBeGreaterThan(4);
  });

  it('draws >0 pixels broadside', () => {
    const cam = testCam();
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const idx = new Uint8Array(64 * 64);
    const zb = new Float32Array(64 * 64);
    const skin = createSoldierSkin();
    const p = drawAliasInstance(idx, zb, 64, 64, {
      mesh: createSoldierMesh(),
      origin: new Float32Array([40, 0, 20]), angles: new Float32Array([0, 90, 0]),
      frameA: 0, frameB: 1, lerp: 0.5, lightAngle: 0,
    }, skin, cam, anorms, dots, colormap);
    expect(p).toBeGreaterThan(100);
  });
});

describe('synthetic MD2 + registerSkinData end to end (asset-free)', () => {
  /** Vertical double-sided quad facing +/-X (both windings, so the pose
   * always draws; culling itself is covered by alias.test.ts). */
  function xQuad(): Md2Like {
    return {
      skinWidth: 64, skinHeight: 64,
      numFrames: 1, numVerts: 4, numSt: 4, numTris: 4,
      st: new Int16Array([0, 0, 63, 0, 63, 63, 0, 63]),
      trisXyz: new Uint16Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]),
      trisSt: new Uint16Array([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]),
      frames: new Float32Array([0, -8, -8, 0, 8, -8, 0, 8, 8, 0, -8, 8]),
      normals: new Uint8Array([3, 3, 3, 3]),
    };
  }

  function setup() {
    const W = 160, H = 120;
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(defaultPalette());
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    const world = { name: 'devroom', data: createDevroom() };
    const ent = (model: number, skin: number): Parameters<SoftwareRenderer['renderView']>[2] => [{
      model, origin: new Float32Array([-140, 0, 120]), angles: new Float32Array([0, 0, 0]),
      frame: 0, skin,
    }];
    const frame = (entities: Parameters<SoftwareRenderer['renderView']>[2]): string => {
      r.beginFrame();
      r.renderView(view, world, entities);
      r.endFrame();
      const idx = fb.index!;
      let h = 2166136261;
      for (let i = 0; i < idx.length; i++) {
        h ^= idx[i]!;
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    };
    return { r, fb, ent, frame };
  }

  it('synthetic MD2 + real skin data draws textured (not flat)', () => {
    const { r, fb, ent, frame } = setup();
    const mh = r.registerModel({ name: 'synth', kind: 'md2', data: xQuad() });
    // two-tone skin: every tri samples both halves
    const skinTex = new Uint8Array(64 * 64);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) skinTex[y * 64 + x] = x < 32 ? 40 : 150;
    }
    const sh = r.registerSkinData('synth/skin', skinTex, 64, 64);
    const base = frame([]);
    const lit = frame(ent(mh, sh));
    expect(lit).not.toBe(base);
    // textured: drawn pixels resolve through the colormap to >1 index
    const seen = new Set<number>();
    const idx = fb.index!;
    for (let i = 0; i < idx.length; i++) if (idx[i] !== 0) seen.add(idx[i]!);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('missing skin on a real MD2 falls back to the soldier tone', () => {
    const { r, ent, frame } = setup();
    const mh = r.registerModel({ name: 'synth', kind: 'md2', data: xQuad() });
    const missing = frame(ent(mh, 999));
    const base = frame([]);
    expect(missing).not.toBe(base); // still draws, soldier-shaped
    // explicit soldier skin renders identically to the missing-skin fallback
    const s = createSoldierSkin();
    const sh = r.registerSkinData('soldier/fallback', s.texels, s.width, s.height);
    expect(frame(ent(mh, sh))).toBe(missing);
  });

  it('missing skin on gun fallback keeps the gunmetal skin', () => {
    const { r, ent, frame } = setup();
    const mh = r.registerModel({ name: 'gun', kind: 'md2', data: null });
    const missing = frame(ent(mh, 999));
    const g = createGunSkin();
    const sh = r.registerSkinData('gun/fallback', g.texels, g.width, g.height);
    expect(frame(ent(mh, sh))).toBe(missing);
  });
});
