// Classic translucency policy pins (bench/testkit lane, Q2_PAK-gated).
//
// NOTE (RELEASE-8): the RGB composite and its opt-in classic skip
// (`sw_rgb_skip_classic`, `setRGBWorldEnabled`) retired. What stays pinned
// here is the CLASSIC indexed path, which the RGB mode used to perturb:
//
// 1. Real translucent geometry (base1 low-road pool, TRANS66 water through
//    the deferred alpha pass) engages the alpha pass: tMode 1 draws
//    translucent spans and the composite differs from tMode 0.
// 2. The classic index plane still matches the software golden for the
//    low-road pool scene (`06456518`) — the retired RGB mode must not have
//    perturbed the classic translucency path, and the indexed path keeps
//    proving it.
// 3. Devroom all-opaque rendering is deterministic across runs.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  SoftwareRenderer,
  TRANSLUCENCY_CVAR,
  bspToMiniWorld,
  createDevroom,
  DEVROOM_CAMERA,
  type BspTexelSource,
} from '@q2/sw-renderer';
import { v3 } from '@q2/math';
import { hashColorFull } from './index.js';
import { base1RefDef, base1Views } from './base1-views.js';

const Q2_PAK = process.env.Q2_PAK;

afterEach(() => {
  resetCVars();
});

function fnvU8(a: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < a.length; i++) {
    h ^= a[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function devView() {
  return {
    origin: DEVROOM_CAMERA.origin,
    angles: DEVROOM_CAMERA.angles,
    fovX: DEVROOM_CAMERA.fovX,
    time: 1.5,
    lightStyles: new Float32Array(256).fill(1),
  };
}

describe('classic determinism: devroom all-opaque', () => {
  it('serial indexed devroom is deterministic with cover', () => {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 5) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 2 + 80) & 255;
    }
    const renderOnce = (): { colorFull: string; cover: number } => {
      resetCVars();
      const fb = createFramebuffer(160, 120, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pal);
      r.beginFrame();
      r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
      r.endFrame();
      const live = r.getFramebuffer();
      // Cover = depth-written pixels (the depth plane clears to 0).
      let cover = 0;
      for (let i = 0; i < live.depth!.length; i++) if (live.depth![i] !== 0) cover++;
      const out = {
        colorFull: hashColorFull(live.color),
        cover,
      };
      resetCVars();
      return out;
    };
    const a = renderOnce();
    const b = renderOnce();
    expect(a.cover).toBeGreaterThan(0);
    expect(b.colorFull).toBe(a.colorFull);
    expect(b.cover).toBe(a.cover);
  });
});

describe.runIf(!!Q2_PAK)('translucent frames on the classic path (Q2_PAK)', () => {
  it('real translucent geometry engages the alpha pass; classic index plane matches the software golden', { timeout: 300000 }, () => {
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
    // Low-road pool from above (same survey as base1-translucent.test.ts).
    const view = {
      origin: v3(430, 620, -150), angles: v3(90, 0, 0),
      fovX: 90, time: 1.5, lightStyles: new Float32Array(256).fill(1),
    };
    const render = (tmode: 0 | 1): { colorFull: string; idx: string; tspans: number } => {
      resetCVars();
      setCVar(TRANSLUCENCY_CVAR, tmode);
      const fb = createFramebuffer(320, 240, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pcx.palette);
      expect(r.setAlphamapFromColormapPcx(pcx.pixels)).toBe(true);
      r.beginFrame();
      r.renderView(view, { name: 'base1', data: world }, []);
      r.endFrame();
      const live = r.getFramebuffer();
      const out = {
        colorFull: hashColorFull(live.color),
        idx: fnvU8(live.index!),
        tspans: r.testTranslucentSpans(),
      };
      resetCVars();
      return out;
    };
    const opaque = render(0);
    const blended = render(1);
    // The alpha pass engages on the classic path: translucent spans drawn,
    // frame differs.
    expect(blended.tspans).toBeGreaterThan(0);
    expect(blended.colorFull).not.toBe(opaque.colorFull);
    // The classic index plane still matches the software golden.
    expect(blended.idx).toBe('06456518');
    resetCVars();
  });

  it('base1 ordinary + sky views render with cover (indexed)', { timeout: 300000 }, () => {
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
    const palette = parsePCX(pak.readFile('pics/colormap.pcx')).palette;
    for (const label of ['spawn-north', 'trench-east']) {
      const v = base1Views().find((x) => x.label === label)!;
      const mk = (): { colorFull: string; cover: number } => {
        resetCVars();
        const fb = createFramebuffer(320, 240, true);
        const r = new SoftwareRenderer();
        r.init(fb);
        r.setPalette(palette);
        r.beginFrame();
        r.renderView(base1RefDef(v), { name: 'base1', data: world }, []);
        r.endFrame();
        const live = r.getFramebuffer();
        let cover = 0;
        for (let i = 0; i < live.index!.length; i++) if (live.index![i] !== 0) cover++;
        const out = { colorFull: hashColorFull(live.color), cover };
        resetCVars();
        return out;
      };
      const a = mk();
      const b = mk();
      expect(a.cover, `${label} cover>0`).toBeGreaterThan(0);
      expect(b.colorFull, `${label} deterministic`).toBe(a.colorFull);
      expect(b.cover, `${label} cover stable`).toBe(a.cover);
    }
  });
});
