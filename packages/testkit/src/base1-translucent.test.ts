// Base1 translucency golden (glass TRANS33/TRANS66 engine-wide port).
// Q2_PAK-gated: boots real base1 (pak ingest, BSP38, WALs, real palette +
// real colormap.pcx alphamap) and renders the low-road pool — 102 worldspawn
// SURF_TRANS66 faces (e1u1/bluwter) drawn through the deferred alpha pass
// (R_DrawAlphaSurfaces: depth-tested, never depth-writing, alphamap blend,
// water warp). Mode 0 (opaque fallback) vs mode 1 (blend) must differ; the
// mode-1 index hash is the pinned golden.
//
// Why the pool and not the *20 window: the 17 TRANS33 window faces belong
// to brush model *20 (unreachable from the worldspawn node tree — proven by
// face-reachability: 7536/7537 not in the node-0 walk), so the base path
// never emits them; they ride the same SPAN_TRANS33 code once the web mover
// graft submits them (graft-owned). TRANS33 itself is pinned exactly in
// sw-renderer (C index orders, stipple lattices, no-depth-write).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { bspToMiniWorld } from '@q2/sw-renderer';
import type { BspTexelSource } from '@q2/sw-renderer';
import { SoftwareRenderer } from '@q2/sw-renderer';
import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import { v3 } from '@q2/math';

const Q2_PAK = process.env.Q2_PAK;

function fnvIdx(idx: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < idx.length; i++) {
    h ^= idx[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

describe.runIf(!!Q2_PAK)('base1 translucency golden: low-road pool (Q2_PAK)', () => {
  it('TRANS66 water blends (mode 1 hash pinned, real alphamap)', { timeout: 300000 }, () => {
    resetCVars();
    const bytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(bytes.length);
    new Uint8Array(buf).set(bytes);
    const pak = new PakFile(buf);
    const map = loadBsp(pak.readFile('maps/base1.bsp')) as BspMap;
    const walCache = new Map<string, BspTexelSource | null>();
    const texelFor = (walName: string): BspTexelSource | null => {
      if (walCache.has(walName)) return walCache.get(walName)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pak.readFile(`textures/${walName}.wal`));
        src = { texels: wal.mips[0]!, width: wal.width, height: wal.height };
      } catch { src = null; }
      walCache.set(walName, src);
      return src;
    };
    const world = bspToMiniWorld(map, { texelFor });
    const pcx = parsePCX(pak.readFile('pics/colormap.pcx'));
    // low-road pool from above (drowning-lane survey: surface ~-250)
    const view = {
      origin: v3(430, 620, -150), angles: v3(90, 0, 0),
      fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    const W = 320, H = 240;
    const renders: Array<{ hash: string; tspans: number }> = [];
    for (const mode of [0, 1]) {
      resetCVars();
      setCVar('r_translucency', mode);
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pcx.palette);
      // C-exact blend tables from the real colormap.pcx
      expect(r.setAlphamapFromColormapPcx(pcx.pixels)).toBe(true);
      r.beginFrame();
      r.renderView(view, { name: 'base1', data: world }, []);
      r.endFrame();
      renders.push({ hash: fnvIdx(fb.index!), tspans: r.testTranslucentSpans() });
    }
    const [off, on] = renders as [{ hash: string; tspans: number }, { hash: string; tspans: number }];
    console.log(`GLASS-GOLDEN base1 pool 320x240: off=${off!.hash} on=${on!.hash} tspans=${on!.tspans}`);
    // the alpha pass engages and changes the frame (full-screen water)
    expect(on!.tspans).toBeGreaterThan(0);
    expect(on!.hash).not.toBe(off!.hash);
    // pinned golden (real alphamap, deterministic)
    expect(on!.hash).toBe('06456518');
    resetCVars();
  });
});
