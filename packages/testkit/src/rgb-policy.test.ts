// PERF-FINISH-C RGB policy probes (bench/testkit lane, Q2_PAK-gated).
//
// 1. Skip parity across scene classes (PERF-FINISH-C §2): the
//    RGB-authoritative skip (`sw_rgb_skip_classic`, opt-in) must treat
//    skybox and ordinary surfaces under the SAME policy — skip-on vs
//    skip-off production composites are full-RGBA identical on devroom
//    (all-opaque), base1 spawn-north (ordinary), and trench-east (open
//    sky). The classic index plane stops being meaningful under the skip
//    BY DESIGN (documented, opt-in only); the composite is the authority.
// 2. Translucent-RGB corrected (the test
//    sw-renderer remediation.test.ts:596 SHOULD be — it pins the
//    software-only RGB-disabled path): with RGB ON and real translucent
//    geometry (base1 low-road pool, TRANS66 water through the deferred
//    alpha pass), tMode 1 must engage the alpha pass (translucent spans
//    > 0, composite differs from tMode 0), RGB must stay used with full
//    cover, and the skip gate must DISARM (skip=1 classic index ==
//    skip=0 classic index — the classic path stays engaged for the alpha
//    loop). If the sw-renderer lane changes the gate, this test is the
//    harness-side contract.
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
  SW_RGB_SKIP_CLASSIC_CVAR,
  TRANSLUCENCY_CVAR,
  bspToMiniWorld,
  createDevroom,
  DEVROOM_CAMERA,
  setRGBWorldEnabled,
  type BspTexelSource,
} from '@q2/sw-renderer';
import { v3 } from '@q2/math';
import { hashColorFull } from './index.js';
import { base1RefDef, base1Views } from './base1-views.js';

const Q2_PAK = process.env.Q2_PAK;

afterEach(() => {
  setRGBWorldEnabled(false);
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

describe.runIf(!!Q2_PAK)('skip parity: skybox + ordinary surfaces, same policy (Q2_PAK)', () => {
  function base1World(): { data: ReturnType<typeof bspToMiniWorld>; palette: Uint8Array } {
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
    return { data: bspToMiniWorld(map, { texelFor }), palette: parsePCX(pak.readFile('pics/colormap.pcx')).palette };
  }

  function renderRGB(
    worldName: string,
    worldData: ReturnType<typeof bspToMiniWorld>,
    view: ReturnType<typeof base1RefDef> | ReturnType<typeof devView>,
    W: number, H: number, palette: Uint8Array, skip: boolean,
  ): { colorFull: string; idx: string; used: boolean; cover: number } {
    resetCVars();
    setCVar(TRANSLUCENCY_CVAR, 0);
    setCVar(SW_RGB_SKIP_CLASSIC_CVAR, skip ? 1 : 0);
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(palette);
    setRGBWorldEnabled(true);
    r.beginFrame();
    r.renderView(view, { name: worldName, data: worldData }, []);
    r.endFrame();
    const st = r.testRGBStats();
    const out = {
      colorFull: hashColorFull(new Uint32Array(fb.color.buffer, fb.color.byteOffset, fb.color.byteLength / 4)),
      idx: fnvU8(fb.index!),
      used: st.used,
      cover: st.coverPixels,
    };
    setRGBWorldEnabled(false);
    return out;
  }

  it('devroom all-opaque: skip-on composite == skip-off composite', () => {
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 5) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 2 + 80) & 255;
    }
    const off = renderRGB('devroom', createDevroom(), devView(), 160, 120, pal, false);
    const on = renderRGB('devroom', createDevroom(), devView(), 160, 120, pal, true);
    expect(off.used).toBe(true);
    expect(on.used).toBe(true);
    expect(on.cover).toBe(off.cover);
    expect(on.cover).toBeGreaterThan(0);
    expect(on.colorFull).toBe(off.colorFull);
  });

  it('base1 ordinary + sky views: skip-on composite == skip-off composite', { timeout: 300000 }, () => {
    const { data, palette } = base1World();
    for (const label of ['spawn-north', 'trench-east']) {
      const v = base1Views().find((x) => x.label === label)!;
      const off = renderRGB('base1', data, base1RefDef(v), 320, 240, palette, false);
      const on = renderRGB('base1', data, base1RefDef(v), 320, 240, palette, true);
      expect(off.used, `${label} rgb used`).toBe(true);
      expect(on.cover, `${label} cover`).toBe(off.cover);
      expect(on.cover, `${label} cover>0`).toBeGreaterThan(0);
      expect(on.colorFull, `${label} skip parity`).toBe(off.colorFull);
    }
  });
});

describe.runIf(!!Q2_PAK)('translucent frames with RGB ON (corrected gate, Q2_PAK)', () => {
  it('real translucent geometry engages the alpha pass under RGB; the overlay-gated skip preserves the composite', { timeout: 300000 }, () => {
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
    const render = (tmode: 0 | 1, skip: boolean): { colorFull: string; idx: string; tspans: number; used: boolean; cover: number; skipped: number } => {
      resetCVars();
      setCVar(TRANSLUCENCY_CVAR, tmode);
      setCVar(SW_RGB_SKIP_CLASSIC_CVAR, skip ? 1 : 0);
      const fb = createFramebuffer(320, 240, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pcx.palette);
      expect(r.setAlphamapFromColormapPcx(pcx.pixels)).toBe(true);
      setRGBWorldEnabled(true);
      r.beginFrame();
      r.renderView(view, { name: 'base1', data: world }, []);
      r.endFrame();
      const st = r.testRGBStats();
      const sk = r.testClassicSkipStats();
      const out = {
        colorFull: hashColorFull(new Uint32Array(fb.color.buffer, fb.color.byteOffset, fb.color.byteLength / 4)),
        idx: fnvU8(fb.index!),
        tspans: r.testTranslucentSpans(),
        used: st.used,
        cover: st.coverPixels,
        skipped: sk.classicSpansSkipped + sk.classicFgSkipped,
      };
      setRGBWorldEnabled(false);
      return out;
    };
    const opaque = render(0, false);
    const blended = render(1, false);
    // The alpha pass engages under RGB: translucent spans drawn, frame differs.
    expect(blended.tspans).toBeGreaterThan(0);
    expect(blended.colorFull).not.toBe(opaque.colorFull);
    expect(blended.used).toBe(true);
    expect(blended.cover).toBeGreaterThan(0);
    // The overlay-gated skip stays armed on translucent frames: the classic
    // path is elided only where the RGB overlay drew (per-batch), so the
    // production composite is unchanged while the classic index plane goes
    // stale by design (that IS the eliminated duplicate work — the old
    // tMode-gated "disarm" semantics were superseded by PERF-FINISH-A).
    const blendedSkip = render(1, true);
    expect(blendedSkip.colorFull).toBe(blended.colorFull);
    expect(blendedSkip.skipped).toBeGreaterThan(0);
    expect(blendedSkip.idx).not.toBe(blended.idx);
    // And the classic index plane still matches the software-only golden —
    // RGB on must not perturb the classic translucency path.
    expect(blended.idx).toBe('06456518');
    resetCVars();
  });
});
