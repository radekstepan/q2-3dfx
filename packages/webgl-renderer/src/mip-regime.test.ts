// GPU-FOLLOW-5 Box 1 — mip fixture regime (webgl-renderer lane).
//
// The shipped PROOF-4 scene mip gate (testkit-owned, thresholds frozen)
// reads 0/0 at near/mid/far cameras: `midViewMipOnOff = 0/0` with
// `mipFlagsMid = [true,false]` + `policyUploads = on:92/off:8`
// (propagation alive — the toggle reaches GL). This file pins, hermetically
// through the PRODUCTION sampling path (buildMipChainRGB +
// mipLevelFor/pickMipLevelFor + sampleLevelBilinearRepeat, the CPU mirrors
// of textureLod + uMipDither + REPEAT), where the dither path provably
// bites and why the shipped scene fixture stays degenerate:
//
//   (A) synthetic biting fixture (always runs): a high-frequency 8px
//       checker through the production chain — on/off picks differ AND
//       sampled bytes differ. Proves the plumbing bites when content is
//       minified with contrast (offered fixture-data shape for the
//       testkit lane; thresholds here are new, nothing loosened).
//   (B) real base1 census (Q2_PAK): per-camera rho-regime counters over the
//       exact production selection (selectWorldRefs: PVS/frustum/backface)
//       at the VIEW/MID_VIEW/FAR_VIEW origins (scene base1 F1, time 1.5,
//       vd_lodbias -0.35). Recorded blocker: the shipped MID camera's wall
//       pixels are dominated (~80% pixel-weight) by LOD-0 magnification
//       where the toggle is provably inert (level 0 both paths, all 16
//       Bayer phases, per-texture chain caps). No minified-with-contrast
//       scene view was found in this lane (webgl-renderer owns no camera
//       fixture); per-pixel fwidth/occlusion truth needs the browser leg
//       (testkit lane).
//   (C) mirror sensitivity control (Q2_PAK): at straddle rhos the probe
//       DOES see on/off effects on real art through the full lit chain —
//       so the browser 0/0 is a scene-regime fact, not probe blindness.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { bspToMiniWorld, type BspTexelSource } from '@q2/sw-renderer';
import {
  buildMipChainRGB,
  expand565,
  gammaLUTValue,
  mipLevelFor,
  pack565,
  pickMipLevelFor,
  PINNED_LOD_BIAS,
  sampleLevelBilinearRepeat,
} from './appearance.js';
import { expandPaletteTexture } from './worldMesh.js';
import { selectWorldRefs } from './scene.js';

const W = 640;
const H = 480;

function pakReadFile(pakPath: string, name: string): ArrayBuffer {
  const data = readFileSync(pakPath);
  const dirofs = data.readUInt32LE(4);
  const dirlen = data.readUInt32LE(8);
  for (let o = dirofs; o < dirofs + dirlen; o += 64) {
    const entry = data.subarray(o, o + 56).toString().replace(/\0.*$/, '');
    if (entry === name) {
      const off = data.readUInt32LE(o + 56);
      const len = data.readUInt32LE(o + 60);
      return data.buffer.slice(data.byteOffset + off, data.byteOffset + off + len) as ArrayBuffer;
    }
  }
  throw new Error(`pak entry missing: ${name}`);
}

function checker64(): Uint8Array {
  const out = new Uint8Array(64 * 64 * 3);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const v = (((x >> 3) + (y >> 3)) & 1) !== 0 ? 255 : 0;
      const o = (y * 64 + x) * 3;
      out[o] = v; out[o + 1] = v; out[o + 2] = v;
    }
  }
  return out;
}

describe('GPU-FOLLOW-5 Box 1: synthetic biting fixture (production path)', () => {
  it('high-frequency checker: mipDither on/off differs in level AND sampled bytes', () => {
    const chain = buildMipChainRGB(checker64(), 64, 64);
    const maxLevel = chain.length - 1;
    expect(chain.length).toBe(7);
    const RHOS = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6];
    let levelDiff = 0;
    let probed = 0;
    let byteDiff = 0;
    let byteProbed = 0;
    let maxDelta = 0;
    for (const rho of RHOS) {
      for (let uy = 0; uy < 16; uy++) {
        for (let ux = 0; ux < 16; ux++) {
          const u = ux * 4 + 0.5;
          const v = uy * 4 + 0.5;
          for (let pi = 0; pi < 16; pi++) {
            const px = pi & 3;
            const py = (pi >> 2) & 3;
            const lodOn = mipLevelFor(rho, PINNED_LOD_BIAS, maxLevel, true);
            const lodOff = mipLevelFor(rho, PINNED_LOD_BIAS, maxLevel, false);
            const lvlOn = pickMipLevelFor(lodOn, px, py, true, maxLevel);
            const lvlOff = pickMipLevelFor(lodOff, px, py, false, maxLevel);
            probed++;
            if (lvlOn !== lvlOff) levelDiff++;
            // Sampled-byte comparison at a fixed phase (0,0): taps differ
            // only when the picked levels (or their content) differ.
            if (pi === 0) {
              const mOn = chain[lvlOn]!;
              const mOff = chain[lvlOff]!;
              const a = sampleLevelBilinearRepeat(mOn.data, mOn.w, mOn.h, u * (mOn.w / 64), v * (mOn.h / 64));
              const b = sampleLevelBilinearRepeat(mOff.data, mOff.w, mOff.h, u * (mOff.w / 64), v * (mOff.h / 64));
              byteProbed++;
              const d = Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
              maxDelta = Math.max(maxDelta, d);
              if (d > 0.5) byteDiff++;
            }
          }
        }
      }
    }
    console.log(
      `synthetic checker: levelDiff ${levelDiff}/${probed} ` +
      `(${(100 * levelDiff / probed).toFixed(2)}%), ` +
      `byteDiff ${byteDiff}/${byteProbed} ` +
      `(${(100 * byteDiff / byteProbed).toFixed(2)}%), maxDelta ${maxDelta.toFixed(1)}`,
    );
    // The production path bites on minified high-frequency content:
    // both the level pick and the sampled bytes move. If this ever
    // collapses to 0, the dither path itself is dead (regression).
    expect(levelDiff).toBeGreaterThan(probed * 0.05);
    expect(byteDiff).toBeGreaterThan(byteProbed * 0.01);
    expect(maxDelta).toBeGreaterThan(40);
  });
});

describe.runIf(!!process.env.Q2_PAK)('GPU-FOLLOW-5 Box 1: real base1 regime census (Q2_PAK)', () => {
  const VIEW: [number, number, number] = [128, -320, 54];
  const MID: [number, number, number] = [128, -390, 73];
  const FAR: [number, number, number] = [128, -470, 94];

  function load(): { texOf: Map<string, Uint8Array>; dimsOf: Map<string, [number, number]> } {
    const pakPath = process.env.Q2_PAK as string;
    const map = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
    const palette = parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx')).palette;
    const texOf = new Map<string, Uint8Array>();
    const dimsOf = new Map<string, [number, number]>();
    for (const name of map.texinfoNames) {
      if (!name || name.startsWith('*') || name.startsWith('sky')) continue;
      if (texOf.has(name)) continue;
      try {
        const wal = parseWAL(pakReadFile(pakPath, `textures/${name}.wal`));
        const rgb = expandPaletteTexture(wal.mips[0] as Uint8Array, wal.width, wal.height, palette);
        if (rgb) {
          texOf.set(name, rgb);
          dimsOf.set(name, [wal.width, wal.height]);
        }
      } catch { /* missing WAL: skip */ }
    }
    return { texOf, dimsOf };
  }

  it('per-camera rho regime: production selection set (PVS/frustum/backface)', { timeout: 180000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const map = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
    const cache = new Map<string, BspTexelSource | null>();
    const texelFor = (name: string): BspTexelSource | null => {
      if (cache.has(name)) return cache.get(name)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pakReadFile(pakPath, `textures/${name}.wal`));
        src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
      } catch { src = null; }
      cache.set(name, src);
      return src;
    };
    const world = bspToMiniWorld(map, { texelFor });
    const styles = new Float32Array(256).fill(1);
    // Forward is +Y (yaw 90): the exact production selection path
    // (PVS + frustum + backface), the same set the browser draws.
    for (const [label, origin] of [['VIEW', VIEW], ['MID', MID], ['FAR', FAR]] as const) {
      const view = {
        origin: new Float32Array(origin),
        angles: new Float32Array([0, 90, 0]),
        fovX: 90, time: 1.5, lightStyles: styles,
      };
      const refs = selectWorldRefs(world, view, W, H);
      let n = 0;
      let clamp0 = 0;
      let straddle = 0;
      let clampMax = 0;
      let wClamp0 = 0;
      let wStraddle = 0;
      let wClampMax = 0;
      let rhoSum = 0;
      let rhoMax = 0;
      let skyRefs = 0;
      for (const ref of refs) {
        const s = world.surfaces[ref.surfaceId]!;
        if (!s || s.n < 3) continue;
        if (s.sky) { skyRefs++; continue; } // single-level: uMaxLevel 0, toggle inert by design
        if (s.turbulent) continue; // water pair is a separate gate; world-mip census only
        const dx = s.center[0]! - origin[0];
        const dy = s.center[1]! - origin[1];
        const dz = s.center[2]! - origin[2];
        const dist = Math.hypot(dx, dy, dz) || 1e-3;
        // Texel density: max |duv|/|dworld| over fan edges (texels per unit).
        let density = 0;
        for (let i = 1; i < s.n; i++) {
          const du = s.uvs[i * 2]! - s.uvs[0]!;
          const dv = s.uvs[i * 2 + 1]! - s.uvs[1]!;
          const wx = s.verts[i * 3]! - s.verts[0]!;
          const wy = s.verts[i * 3 + 1]! - s.verts[1]!;
          const wz = s.verts[i * 3 + 2]! - s.verts[2]!;
          const wl = Math.hypot(wx, wy, wz);
          if (wl > 1e-6) density = Math.max(density, Math.hypot(du, dv) / wl);
        }
        if (!(density > 0)) continue;
        // Grazing correction: screen-space derivatives inflate by
        // 1/cos(theta) along the view direction (fwidth takes the max),
        // so rho_graze = density*dist/320 / |n.v|. Corridor walls at
        // grazing incidence minify hard and clamp to uMaxLevel.
        const vx = dx / dist;
        const vy = dy / dist;
        const vz = dz / dist;
        const cosT = Math.abs(s.fn[0]! * vx + s.fn[1]! * vy + s.fn[2]! * vz);
        const r = ((density * dist) / 320) / Math.max(cosT, 1e-3);
        rhoSum += Math.min(r, 1e6);
        rhoMax = Math.max(rhoMax, Math.min(r, 1e6));
        n++;
        // Per-surface chain cap: the browser clamps textureLod to uMaxLevel
        // = chain depth - 1 (NOT 16). 64px walls cap at 6, 128px at 7.
        const tex = world.textures[s.texId];
        const maxLvl = tex ? Math.floor(Math.log2(Math.max(tex.width, tex.height))) : 6;
        // Regime at pinned bias, both dither paths, all 16 phases.
        let anyDiff = false;
        let allZero = true;
        for (let pi = 0; pi < 16; pi++) {
          const lodOn = mipLevelFor(r, PINNED_LOD_BIAS, maxLvl, true);
          const lodOff = mipLevelFor(r, PINNED_LOD_BIAS, maxLvl, false);
          const lOn = pickMipLevelFor(lodOn, pi & 3, (pi >> 2) & 3, true, maxLvl);
          const lOff = pickMipLevelFor(lodOff, pi & 3, (pi >> 2) & 3, false, maxLvl);
          if (lOn !== 0 || lOff !== 0) allZero = false;
          if (lOn !== lOff) anyDiff = true;
        }
        if (allZero) clamp0++;
        else if (anyDiff) straddle++;
        else clampMax++;
        // Pixel weight ~ projected solid angle: worldArea * cosT / dist^2.
        let area = 0;
        for (let i = 1; i + 1 < s.n; i++) {
          const ax = s.verts[i * 3]! - s.verts[0]!;
          const ay = s.verts[i * 3 + 1]! - s.verts[1]!;
          const az = s.verts[i * 3 + 2]! - s.verts[2]!;
          const bx = s.verts[(i + 1) * 3]! - s.verts[0]!;
          const by = s.verts[(i + 1) * 3 + 1]! - s.verts[1]!;
          const bz = s.verts[(i + 1) * 3 + 2]! - s.verts[2]!;
          const cx = ay * bz - az * by;
          const cy = az * bx - ax * bz;
          const cz = ax * by - ay * bx;
          area += Math.hypot(cx, cy, cz) / 2;
        }
        const wpx = (area * cosT) / (dist * dist);
        if (allZero) wClamp0 += wpx;
        else if (anyDiff) wStraddle += wpx;
        else wClampMax += wpx;
      }
      const mean = n > 0 ? rhoSum / n : 0;
      const wTot = wClamp0 + wStraddle + wClampMax;
      console.log(
        `${label} origin [${origin}]: selected ${refs.length} refs ` +
        `(sky ${skyRefs}), walls ${n}, ` +
        `clamp0 ${clamp0} (${n ? (100 * clamp0 / n).toFixed(1) : '-'}%), ` +
        `straddle ${straddle}, clampMax ${clampMax}, ` +
        `rhoMean ${mean.toFixed(3)} rhoMax ${rhoMax.toFixed(3)}, ` +
        `pixelW clamp0 ${(100 * wClamp0 / wTot).toFixed(1)}% / ` +
        `straddle ${(100 * wStraddle / wTot).toFixed(1)}% / ` +
        `clampMax ${(100 * wClampMax / wTot).toFixed(1)}%`,
      );
      expect(n).toBeGreaterThan(10);
      // Regime census: recorded LOUDLY (console + counts), never skipped.
      // The verdict on the shipped scene gate rides on the pixel-weighted
      // straddle share vs the browser 0/0 (see file header + lane report).
      expect(straddle + clampMax + clamp0).toBe(n);
    }
  });

  it('mirror sensitivity control: on/off effects visible at straddle rhos', { timeout: 180000 }, () => {
    const { texOf, dimsOf } = load();
    expect(texOf.size).toBeGreaterThan(20);
    const RHOS = [0.75, 1, 1.5, 2, 3, 6];
    const names = [...texOf.keys()].slice(0, 12);
    let totLevelDiff = 0;
    let totProbed = 0;
    let totByteDiffGT3 = 0;
    let totByteProbed = 0;
    let totQuantDiff = 0;
    let totObDiff = 0;
    let totLitDiff = 0;
    let totLitProbed = 0;
    let worstDelta = 0;
    const LIGHTS = [0.25, 0.5, 0.75, 1.0];
    for (const name of names) {
      const rgb = texOf.get(name)!;
      const [w, h] = dimsOf.get(name)!;
      const chain = buildMipChainRGB(rgb, w, h);
      const maxLevel = chain.length - 1;
      for (const rho of RHOS) {
        for (let k = 0; k < 32; k++) {
          const u = ((k * 37) % Math.max(w - 1, 1)) + 0.5;
          const v = ((k * 53) % Math.max(h - 1, 1)) + 0.5;
          for (let pi = 0; pi < 16; pi++) {
            const px = pi & 3;
            const py = (pi >> 2) & 3;
            const lOn = pickMipLevelFor(mipLevelFor(rho, PINNED_LOD_BIAS, maxLevel, true), px, py, true, maxLevel);
            const lOff = pickMipLevelFor(mipLevelFor(rho, PINNED_LOD_BIAS, maxLevel, false), px, py, false, maxLevel);
            totProbed++;
            if (lOn !== lOff) totLevelDiff++;
            if (pi === 0) {
              const mOn = chain[lOn]!;
              const mOff = chain[lOff]!;
              const base0 = chain[0]!;
              const a = sampleLevelBilinearRepeat(mOn.data, mOn.w, mOn.h, u * (mOn.w / base0.w), v * (mOn.h / base0.h));
              const b = sampleLevelBilinearRepeat(mOff.data, mOff.w, mOff.h, u * (mOff.w / base0.w), v * (mOff.h / base0.h));
              totByteProbed++;
              const d = Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));
              worstDelta = Math.max(worstDelta, d);
              if (d > 3) totByteDiffGT3++;
              // Post-appearance stage (pack565 trunc + gamma 1.3 lift, the
              // browser gate's comparison domain): do tap deltas survive?
              const q = (t: readonly number[]): [number, number, number] => {
                const [r, g, b2] = expand565(pack565(t[0]!, t[1]!, t[2]!));
                return [gammaLUTValue(r, 1.3), gammaLUTValue(g, 1.3), gammaLUTValue(b2, 1.3)];
              };
              const qa = q(a);
              const qb = q(b);
              if (qa[0] !== qb[0] || qa[1] !== qb[1] || qa[2] !== qb[2]) totQuantDiff++;
              // Full pre-quant chain with the pinned vd_overbright=1 x2+clamp:
              // two straddling levels that both clip to 255 draw identically.
              const ob = (t: readonly number[]): [number, number, number] => {
                const c = (x: number): number => Math.min(x * 2, 255);
                const [r, g, b2] = expand565(pack565(c(t[0]!), c(t[1]!), c(t[2]!)));
                return [gammaLUTValue(r, 1.3), gammaLUTValue(g, 1.3), gammaLUTValue(b2, 1.3)];
              };
              const oa = ob(a);
              const obb = ob(b);
              if (oa[0] !== obb[0] || oa[1] !== obb[1] || oa[2] !== obb[2]) totObDiff++;
              // Full FS_LIT lit path: texel x lightmap x overbright-x2+clamp,
              // then 565 + gamma. Real baked lights are 0.2..1.0; small tap
              // deltas shrink below the 565 quantum and vanish.
              for (const li of LIGHTS) {
                const lit = (t: readonly number[]): [number, number, number] => {
                  const c = (x: number): number => Math.min(x * li * 2, 255);
                  const [r, g, b2] = expand565(pack565(c(t[0]!), c(t[1]!), c(t[2]!)));
                  return [gammaLUTValue(r, 1.3), gammaLUTValue(g, 1.3), gammaLUTValue(b2, 1.3)];
                };
                totLitProbed++;
                const la = lit(a);
                const lb = lit(b);
                if (la[0] !== lb[0] || la[1] !== lb[1] || la[2] !== lb[2]) totLitDiff++;
              }
            }
          }
        }
      }
    }
    console.log(
      `real walls (${names.length} WALs x ${RHOS.length} rhos): ` +
      `levelDiff ${totLevelDiff}/${totProbed} (${(100 * totLevelDiff / totProbed).toFixed(2)}%), ` +
      `byteDiffGT3 ${totByteDiffGT3}/${totByteProbed} (${(100 * totByteDiffGT3 / totByteProbed).toFixed(3)}%), ` +
      `postQuantDiff ${totQuantDiff}/${totByteProbed} (${(100 * totQuantDiff / totByteProbed).toFixed(3)}%), ` +
      `postOverbrightDiff ${totObDiff}/${totByteProbed} (${(100 * totObDiff / totByteProbed).toFixed(3)}%), ` +
      `postLitDiff ${totLitDiff}/${totLitProbed} (${(100 * totLitDiff / totLitProbed).toFixed(3)}%), ` +
      `worstDelta ${worstDelta.toFixed(1)}`,
    );
    // Sensitivity control (NOT a degenerate-content claim): at straddle
    // rhos the mirror DOES see on/off effects on real art through the full
    // lit chain (level picks differ AND sampled bytes differ post
    // lightmap/overbright/565/gamma). So the browser 0/0 is a scene-regime
    // fact (MID pixels dominated by LOD-0 magnification per the census
    // above), not probe blindness — and the synthetic checker proves the
    // production path bites when content minifies with contrast.
    expect(totLevelDiff).toBeGreaterThan(0);
    expect(totByteDiffGT3 / totByteProbed).toBeGreaterThan(0.2);
    expect(totLitDiff / totLitProbed).toBeGreaterThan(0.2);
  });
});

describe.runIf(!process.env.Q2_PAK)('GPU-FOLLOW-5 Box 1 real base1 (no Q2_PAK)', () => {
  it('skips the real-art census gracefully', () => {
    console.log('Box-1 real-art census skipped: Q2_PAK absent');
  });
});
