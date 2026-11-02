// Entity lighting (R_LightPoint + R_AliasSetupLighting parity).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { loadBsp } from '@q2/bsp';
import { bspToMiniWorld } from './bspWorld.js';
import type { MiniWorld, MiniSurf } from './worldNodes.js';
import {
  sampleStaticEntityLight, addEntityDynamicLights, aliasAmbientShade,
  plightvecForAngles, aliasGradeForNormal, aliasGradeFromTemp,
  entityMonoSample,
} from './entityLight.js';
import { buildANorms, buildShadeDots, drawAliasInstance, createBoxMesh } from './alias.js';
import { buildColormap, defaultPalette } from './colormap.js';
import { setupCamera } from './camera.js';

const PAK = process.env.Q2_PAK;

/** Minimal PAK reader (test-only; mirrors dlightRows.test.ts, no new deps). */
function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  if (data.subarray(0, 4).toString() !== 'PACK') throw new Error('not a pak');
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len);
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

function loadBase1MiniWorld() {
  if (!PAK) throw new Error('no pak');
  return bspToMiniWorld(loadBsp(pakReadFile(PAK, 'maps/base1.bsp')));
}

/** Flat +Z-facing quad floor for sampler unit tests. */
function quadSurf(
  id: number, x0: number, x1: number, y0: number, y1: number,
  z: number, lightId: number, luxVal: number,
): MiniSurf {
  return {
    id,
    verts: new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]),
    uvs: new Float32Array(8),
    lux: new Float32Array(8).fill(luxVal),
    n: 4, texId: 0, lightId,
    center: new Float32Array([(x0 + x1) / 2, (y0 + y1) / 2, z]),
    radius: Math.hypot(x1 - x0, y1 - y0) / 2,
    mins: new Float32Array([x0, y0, z]), maxs: new Float32Array([x1, y1, z]),
    turbulent: false, sky: false,
    fn: new Float32Array([0, 0, 1]),
  };
}

/** Node-less synthetic world (the sampler only reads surfaces + lightmaps). */
function tinyWorld(surfs: MiniSurf[], lightmaps: MiniWorld['lightmaps']): MiniWorld {
  return {
    brand: 'miniworld',
    nodes: [],
    leafs: [],
    pvs: [],
    clusterCount: 0,
    surfaces: surfs,
    textures: [{ texels: new Uint8Array(64).fill(7), width: 8, height: 8 }],
    lightmaps,
    dynamicLights: [],
    alias: [],
    sprites: [],
    particles: [],
  };
}

describe('entityLight', () => {
  it('plightvec rotates the fixed (-1,0,0) light into the model frame', () => {
    const p0 = plightvecForAngles(new Float32Array([0, 0, 0]));
    expect(p0[0]!).toBeCloseTo(-1, 6);
    expect(p0[1]!).toBeCloseTo(0, 6);
    expect(p0[2]!).toBeCloseTo(0, 6);
    const p90 = plightvecForAngles(new Float32Array([0, 90, 0]));
    expect(p90[0]!).toBeCloseTo(0, 6);
    expect(p90[1]!).toBeCloseTo(1, 6);
    expect(p90[2]!).toBeCloseTo(0, 6);
  });

  it('aliasAmbientShade follows the id clamp chain', () => {
    // j = avg*255; 1.0 -> 255 -> ambient 128, shade 64 (192-128).
    const full = aliasAmbientShade(new Float32Array([1, 1, 1]));
    expect(full.ambient).toBe(128);
    expect(full.shade).toBe(64);
    // dark sample stays unclamped (Float32 0.1 is 0.0999.., so ~25.497).
    const dark = aliasAmbientShade(new Float32Array([0.1, 0.1, 0.1]));
    expect(dark.ambient).toBeCloseTo(25.5, 1);
    expect(dark.shade).toBeCloseTo(25.5, 1);
    // minlight floors at 0.1.
    const min = aliasAmbientShade(new Float32Array([0, 0, 0]), { minlight: true });
    expect(min.ambient).toBeCloseTo(25.5, 1);
  });

  it('normals facing the incoming light shade brighter', () => {
    // Light travels -X (plight [-1,0,0]): +X-facing normals catch it
    // (cos -1 -> temp drops -> grade rises); -X and side normals read ambient.
    const pl = new Float32Array([-1, 0, 0]);
    const lit = aliasGradeForNormal(77, 77, pl, 1, 0, 0);
    const side = aliasGradeForNormal(77, 77, pl, 0, 1, 0);
    const back = aliasGradeForNormal(77, 77, pl, -1, 0, 0);
    expect(lit).toBeGreaterThan(side);
    expect(side).toBe(back);
    // brighter ambient lifts every normal.
    const dim = aliasGradeForNormal(43, 43, pl, 1, 0, 0);
    expect(lit).toBeGreaterThan(dim);
  });

  it('RF_GLOW pulses around the sample, floored at 0.8x (silencer rule)', () => {
    // Dark-corner pickup: static ~0.03 breathes up to ~0.13 at the pulse
    // peak and never below 0.8x — id's bonus-item pulse, not fullbright.
    const dark = new Float32Array([0.03, 0.03, 0.03]);
    const peakT = Math.PI / 14; // sin(7t) = 1
    const peak = aliasAmbientShade(dark, { glow: true, time: peakT });
    expect(peak.ambient).toBeCloseTo((0.03 + 0.1) * 255, 0);
    const troughT = (3 * Math.PI) / 14; // sin(7t) = -1 -> floor wins
    const trough = aliasAmbientShade(dark, { glow: true, time: troughT });
    expect(trough.ambient).toBeCloseTo(0.03 * 0.8 * 255, 0);
    // Bright samples pulse symmetrically until the 128 clamp catches them.
    const lit = aliasAmbientShade(new Float32Array([0.5, 0.5, 0.5]), { glow: true, time: peakT });
    expect(lit.ambient).toBe(128); // 0.6*255 = 153 clamps to 128, like id
    const mid = aliasAmbientShade(new Float32Array([0.3, 0.3, 0.3]), { glow: true, time: peakT });
    expect(mid.ambient).toBeCloseTo(0.4 * 255, 0);
  });

  it('dynamic lights brighten the sample by (intensity - dist)/256', () => {
    const base = new Float32Array([0.2, 0.2, 0.2]);
    const origin = new Float32Array([0, 0, 0]);
    const out = addEntityDynamicLights(base, origin, [
      { origin: new Float32Array([0, 0, 0]), intensity: 256, color: new Float32Array([1, 1, 1]) },
    ]);
    // dist 0 -> add 1.0 per channel.
    expect(out[0]!).toBeCloseTo(1.2, 6);
    // out of range adds nothing.
    const far = addEntityDynamicLights(
      new Float32Array([0.2, 0.2, 0.2]), origin,
      [{ origin: new Float32Array([1000, 0, 0]), intensity: 100, color: new Float32Array([1, 1, 1]) }],
      new Float32Array(3),
    );
    expect(far[0]!).toBeCloseTo(0.2, 6);
  });

  it('static sample folds to mono by brightest component (Mod_LoadLighting)', () => {
    // id software converts the 24-bit lump to 8-bit mono per luxel by
    // taking the brightest channel; gl_mesh.c confirms ("should be the
    // same as the mono value returned by software").
    expect(entityMonoSample(new Float32Array([0.2, 0.5, 0.1]))).toBeCloseTo(0.5, 6);
    expect(entityMonoSample(new Float32Array([0.9, 0.9, 0.9]))).toBeCloseTo(0.9, 6);
    expect(entityMonoSample(new Float32Array([0, 0, 0]))).toBe(0);
  });

  it('grade mapping follows the id colormap curve (255-4r)/128', () => {
    // temp = r*256 selects id row r exactly. Row 32 ~= 1.0 -> fullbright,
    // rows at/above 1.0 saturate (the world path's luma clamp), row 63
    // is near black. Measured against pics/colormap.pcx: row 44 ~= 0.61,
    // row 53 ~= 0.33.
    expect(aliasGradeFromTemp(0)).toBe(63);
    expect(aliasGradeFromTemp(31 * 256)).toBe(63);
    expect(aliasGradeFromTemp(32 * 256)).toBe(63);
    expect(aliasGradeFromTemp(44 * 256)).toBe(39);
    expect(aliasGradeFromTemp(53 * 256)).toBe(21);
    expect(aliasGradeFromTemp(62 * 256)).toBeLessThanOrEqual(4);
    expect(aliasGradeFromTemp(63 * 256)).toBeLessThanOrEqual(2);
  });

  it('position-dependent lighting changes alias pixels (same mesh/angles)', () => {
    const cam = setupCamera(new Float32Array([128, -320, 54]), new Float32Array([0, 90, 0]), 90, 64, 64);
    const anorms = buildANorms();
    const dots = buildShadeDots(anorms);
    const colormap = buildColormap(defaultPalette());
    const skin = { texels: new Uint8Array(32 * 32).fill(100), width: 32, height: 32 };
    const mesh = createBoxMesh(10);
    const run = (lighting: { ambient: number; shade: number; plight: Float32Array } | undefined) => {
      const idx = new Uint8Array(64 * 64);
      const zb = new Float32Array(64 * 64);
      const n = drawAliasInstance(idx, zb, 64, 64, {
        mesh, origin: new Float32Array([136, 40, 0]), angles: new Float32Array([0, 0, 0]),
        frameA: 0, frameB: 0, lerp: 0, lightAngle: 0, lighting,
      }, skin, cam, anorms, dots, colormap);
      return { idx, n };
    };
    const dim = { ambient: 43, shade: 43, plight: new Float32Array([-1, 0, 0]) };
    const bright = { ambient: 77, shade: 77, plight: new Float32Array([-1, 0, 0]) };
    const a = run(dim), b = run(bright);
    expect(a.n).toBeGreaterThan(0);
    expect(b.n).toBeGreaterThan(0);
    // same coverage shape class, different shade indices.
    expect(a.idx.some((v, i) => v !== b.idx[i])).toBe(true);
  });

  it.runIf(!!PAK)('spawn barrels sample different static light on real base1', () => {    const world = loadBase1MiniWorld();
    expect(world.nodes.length).toBeGreaterThan(0);
    const styles = new Float32Array(256).fill(1);
    const s1 = sampleStaticEntityLight(world, new Float32Array([136, 40, 0]), styles);
    const s2 = sampleStaticEntityLight(world, new Float32Array([184, -24, 0]), styles);
    const l1 = s1[0]! + s1[1]! + s1[2]!;
    const l2 = s2[0]! + s2[1]! + s2[2]!;
    // The reported bug: both barrels read identically. They must not.
    expect(l1).not.toBeCloseTo(l2, 3);
    // Mono (ref_soft) metric: brightest channel drives the grade.
    expect(entityMonoSample(s1)).toBeCloseTo(0.255, 2);
    expect(entityMonoSample(s2)).toBeCloseTo(0.51, 2);
    const a1 = aliasAmbientShade(new Float32Array([entityMonoSample(s1), entityMonoSample(s1), entityMonoSample(s1)]));
    const a2 = aliasAmbientShade(new Float32Array([entityMonoSample(s2), entityMonoSample(s2), entityMonoSample(s2)]));
    expect(a1.ambient).not.toBeCloseTo(a2.ambient, 1);
  });

  it('luxel-invalid nearest hit falls through to farther lit faces', () => {
    // Upper grate maps the ray XY outside its 2x2 luxel grid (lux 9);
    // id RecursiveLightPoint `continue`s past it instead of blacking out.
    const upper = quadSurf(0, -8, 8, -8, 8, 0, 0, 9);
    const lower = quadSurf(1, -64, 64, -64, 64, -16, 1, 0);
    const world = tinyWorld([upper, lower], [
      { samples: new Uint8Array(2 * 2 * 3).fill(10), luxW: 2, luxH: 2, styles: [0] },
      { samples: new Uint8Array(2 * 2 * 3).fill(200), luxW: 2, luxH: 2, styles: [0] },
    ]);
    const styles = new Float32Array(256).fill(1);
    const s = sampleStaticEntityLight(world, new Float32Array([0, 0, 100]), styles);
    expect(s[0]!).toBeCloseTo(200 / 255, 3);
    expect(s[1]!).toBeCloseTo(200 / 255, 3);
    expect(s[2]!).toBeCloseTo(200 / 255, 3);
  });

  it('concave floors sample the same affine luxel everywhere (no fan misses)', () => {
    // C-shaped floor (bite opens +X): the old vert-0 fan triangulation drops
    // samples over reflex vertices; the affine solve covers the polygon fully.
    const vs: number[] = [
      0, 0, 0, 9, 0, 0, 9, 3, 0, 3, 3, 0,
      3, 6, 0, 9, 6, 0, 9, 9, 0, 0, 9, 0,
    ];
    const n = 8;
    const lux = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      lux[i * 2] = vs[i * 3]! / 9;
      lux[i * 2 + 1] = vs[i * 3 + 1]! / 9;
    }
    const surf: MiniSurf = {
      id: 0,
      verts: new Float32Array(vs),
      uvs: new Float32Array(n * 2),
      lux,
      n, texId: 0, lightId: 0,
      center: new Float32Array([4.5, 4.5, 0]),
      radius: 7,
      mins: new Float32Array([0, 0, 0]), maxs: new Float32Array([9, 9, 0]),
      turbulent: false, sky: false,
      fn: new Float32Array([0, 0, 1]),
    };
    const world = tinyWorld([surf], [
      { samples: new Uint8Array(2 * 2 * 3).fill(200), luxW: 2, luxH: 2, styles: [0] },
    ]);
    const styles = new Float32Array(256).fill(1);
    // Walk line across the slot back + both arms: every stop must read lit.
    for (const [x, y] of [[1, 1], [1, 4.5], [1.5, 4.5], [1, 8], [4.5, 1], [7, 7]] as const) {
      const s = sampleStaticEntityLight(world, new Float32Array([x, y, 100]), styles);
      expect(entityMonoSample(s)).toBeCloseTo(200 / 255, 2);
    }
  });
});
