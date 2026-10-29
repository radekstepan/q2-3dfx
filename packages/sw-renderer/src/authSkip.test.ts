// PERF-FINISH-A item A migration gate: cvar-0 oracle vs default-on
// authoritative skip on REAL base1 views (Q2_PAK-gated).
//
// For each view x workload the test renders the RGB frame twice — once
// with the classic oracle (sw_rgb_skip_classic=0, classic always drew) and
// once with the production default (skip armed) — and pins:
// - DISPLAY IDENTITY: the resolved RGB composite (fb.color) is identical.
//   Any depth-tie pixel where float-1/z and quantised window-Z disagree
//   would show up here; base1 shows zero (see the diff-count probe below).
// - ELIMINATED WORK: skip counters are > 0 wherever classic draws existed
//   (world spans always; foreground draws with entities).
// - SOFTWARE UNTOUCHED: with RGB off, oracle and default index planes are
//   identical (the skip never arms without the overlay).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { createFramebuffer, type Entity } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  SoftwareRenderer, setRGBWorldEnabled, SW_RGB_SKIP_CLASSIC_CVAR,
} from './frame.js';
import { createBoxMesh } from './alias.js';
import { bspToMiniWorld, type BspTexelSource, type MiniWorld } from './index.js';
import { loadBsp } from '@q2/bsp';
import { parseMD2, parsePCX, parseWAL } from '@q2/formats';

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

interface PakWorld {
  world: MiniWorld;
  palette: Uint8Array;
  soldierMd2: ArrayBuffer;
  soldierSkin: { pixels: Uint8Array; width: number; height: number };
}

function loadPakWorld(pakPath: string): PakWorld {
  const bsp = loadBsp(pakReadFile(pakPath, 'maps/base1.bsp'));
  const walCache = new Map<string, BspTexelSource | null>();
  const texelFor = (walName: string): BspTexelSource | null => {
    if (walCache.has(walName)) return walCache.get(walName)!;
    let src: BspTexelSource | null = null;
    try {
      const wal = parseWAL(pakReadFile(pakPath, `textures/${walName}.wal`));
      src = { texels: wal.mips[0] as Uint8Array, width: wal.width, height: wal.height };
    } catch { src = null; }
    walCache.set(walName, src);
    return src;
  };
  const skin = parsePCX(pakReadFile(pakPath, 'models/monsters/soldier/skin.pcx'));
  return {
    world: bspToMiniWorld(bsp, { texelFor }),
    palette: parsePCX(pakReadFile(pakPath, 'pics/colormap.pcx')).palette,
    soldierMd2: pakReadFile(pakPath, 'models/monsters/soldier/tris.md2'),
    soldierSkin: { pixels: skin.pixels, width: skin.width, height: skin.height },
  };
}

function fnvU8(a: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function fnvU32(a: Uint32Array): string {
  return fnvU8(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
}

interface View { origin: [number, number, number]; yaw: number; label: string }

const VIEWS: View[] = [
  { origin: [128, -320, 54], yaw: 90, label: 'spawn-north' },
  { origin: [128, -320, 54], yaw: 45, label: 'spawn-sweep' },
  { origin: [-1648, 1544, 16], yaw: 0, label: 'trench-east' },
];

const W = 320, H = 240;

function baseEntities(
  r: SoftwareRenderer, fw: PakWorld,
  origin: [number, number, number], yawDeg: number, mode: 'none' | 'soldier' | 'combat',
): Entity[] {
  if (mode === 'none') return [];
  const yaw = (yawDeg * Math.PI) / 180;
  const fx = Math.cos(yaw), fy = Math.sin(yaw);
  const [ox, oy, oz] = origin;
  const md2 = parseMD2(fw.soldierMd2.slice(0));
  const mh = r.registerModel({ name: 'soldier', kind: 'md2', data: md2 });
  const sh = r.registerSkinPixels('soldier-skin', fw.soldierSkin.pixels, fw.soldierSkin.width, fw.soldierSkin.height);
  // Soldier-only workload: single opaque entity, no translucency/dlights.
  const ents: Entity[] = [{
    model: mh, origin: new Float32Array([ox + fx * 48, oy + fy * 48, oz - 30]),
    angles: new Float32Array([0, yawDeg + 180, 0]), frame: 4, skin: sh,
  }];
  if (mode === 'combat') {
    // Translucent explosion overlapping the soldier (alpha blend vs the old
    // screen-door stipple) + a live muzzle-flash dlight: the overlapping-
    // translucency + combat case the card calls out.
    const boom = r.registerModel({ name: 'boom', kind: 'md2', data: createBoxMesh(8) });
    const bs = r.registerSkinPixels('boom', fw.soldierSkin.pixels, fw.soldierSkin.width, fw.soldierSkin.height);
    ents.push({
      model: boom, origin: new Float32Array([ox + fx * 60, oy + fy * 60, oz - 20]),
      angles: new Float32Array([0, yawDeg, 0]), frame: 0, skin: bs, alpha: 0.5,
    });
    r.testAddDynamicLight({
      origin: new Float32Array([ox + fx * 80, oy + fy * 80, oz]),
      intensity: 300, color: new Float32Array([1, 0.8, 0.6]),
    });
  }
  return ents;
}

interface FrameResult {
  colorHash: string; idxHash: string; cover: number;
  classicSpansSkipped: number; classicFgSkipped: number;
  color: Uint32Array;
}

function renderFrame(
  fw: PakWorld, v: View, rgb: boolean, skip: boolean, mode: 'none' | 'soldier' | 'combat',
): FrameResult {
  resetCVars();
  const r = new SoftwareRenderer();
  const fb = createFramebuffer(W, H, true);
  r.init(fb);
  r.setPalette(fw.palette);
  setCVar(SW_RGB_SKIP_CLASSIC_CVAR, skip ? 1 : 0);
  setRGBWorldEnabled(rgb);
  const ents = rgb ? baseEntities(r, fw, v.origin, v.yaw, mode) : [];
  r.beginFrame();
  r.renderView(
    {
      origin: new Float32Array(v.origin),
      angles: new Float32Array([0, v.yaw, 0]), fovX: 90, time: 1.5,
      lightStyles: new Float32Array(256).fill(1),
    },
    { name: 'base1', data: fw.world },
    ents,
  );
  r.endFrame();
  const live = r.getFramebuffer();
  const sk = r.testClassicSkipStats();
  const color = live.color.slice();
  const out: FrameResult = {
    colorHash: fnvU32(color), idxHash: fnvU8(live.index!),
    cover: r.testRGBStats().coverPixels,
    classicSpansSkipped: sk.classicSpansSkipped,
    classicFgSkipped: sk.classicFgSkipped,
    color,
  };
  setRGBWorldEnabled(false);
  resetCVars();
  return out;
}

describe.runIf(!!process.env.Q2_PAK)('authoritative skip vs oracle on real base1 (Q2_PAK)', () => {
  it('display-identical, work eliminated, software untouched (3 views x none/soldier/combat)', {
    timeout: 300000,
  }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const fw = loadPakWorld(pakPath);
    let totalDiff = 0;
    let totalPx = 0;
    for (const v of VIEWS) {
      for (const mode of ['none', 'soldier', 'combat'] as const) {
        const tag = `${v.label}+${mode}`;
        const oracle = renderFrame(fw, v, true, false, mode);
        const prod = renderFrame(fw, v, true, true, mode);
        // Cover identical (same RGB draws admitted).
        expect(prod.cover, `${tag} cover`).toBe(oracle.cover);
        expect(prod.cover, `${tag} cover>0`).toBeGreaterThan(0);
        // Eliminated classic work is proven absent by the counters.
        expect(prod.classicSpansSkipped, `${tag} world spans skipped`).toBeGreaterThan(0);
        if (mode === 'none') {
          expect(prod.classicFgSkipped, `${tag} fg draws skipped`).toBe(0);
        } else {
          expect(prod.classicFgSkipped, `${tag} fg draws skipped`).toBeGreaterThan(0);
        }
        expect(oracle.classicSpansSkipped, `${tag} oracle spans`).toBe(0);
        expect(oracle.classicFgSkipped, `${tag} oracle fg`).toBe(0);
        // Display identity: count differing composite pixels.
        let diff = 0;
        for (let i = 0; i < W * H; i++) {
          if (prod.color[i] !== oracle.color[i]) diff++;
        }
        totalDiff += diff;
        totalPx += W * H;
        expect(diff, `${tag} RGB composite diff pixels`).toBe(0);
        // Software untouched: skip never arms without the overlay.
        const swOracle = renderFrame(fw, v, false, false, 'none');
        const swProd = renderFrame(fw, v, false, true, 'none');
        expect(swProd.idxHash, `${tag} software idx`).toBe(swOracle.idxHash);
        expect(swProd.colorHash, `${tag} software color`).toBe(swOracle.colorHash);
      }
    }
    expect(totalPx).toBeGreaterThan(0);
    // Honest residual ledger: zero is the goal; the number is the proof.
    expect(totalDiff).toBe(0);
  });
});
