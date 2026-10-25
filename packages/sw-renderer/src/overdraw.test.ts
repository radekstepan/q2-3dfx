// M3.3 option (b): overdraw attribution.
//
// The recalibrated budget (~2.5x ceiling) rests on the claim that the residual
// overdraw is in-frustum occluded span fill — the C-faithful z-buffer doing
// hidden-surface removal — and not bucketing waste (spans emitted for
// off-screen, backfacing, or already-known-hidden surfaces). These tests pin
// that claim with per-view accounting from SoftwareRenderer.testMeasureOverdraw:
// every PVS-admitted surface must land in exactly one bucket, emitted span
// pixels must reconcile with depth-written pixels, and no batch may hit the
// span-pool cap (which would silently drop spans).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { loadBsp } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { v3 } from '@q2/math';
import { createFramebuffer } from '@q2/renderer-api';
import { bspToMiniWorld, type BspTexelSource } from './bspWorld.js';
import { createDevroom, DEVROOM_CAMERA } from './devroom.js';
import { MAX_SPANS, SoftwareRenderer } from './frame.js';
import { formatOverdrawLine } from './overdraw.js';

/** Minimal PAK directory walk over an in-memory buffer (test-only). */
function pakReadFile(data: Buffer, name: string): ArrayBuffer {
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

describe('overdraw accounting (asset-free devroom)', () => {
  it('every PVS-admitted surface is attributed; span pixels reconcile with depth writes', () => {
    const W = 320, H = 240;
    const styles = new Float32Array(256).fill(1);
    const view = {
      origin: DEVROOM_CAMERA.origin, angles: DEVROOM_CAMERA.angles,
      fovX: DEVROOM_CAMERA.fovX, time: 1.5, lightStyles: styles,
    };
    // world-only frame (strip placed alias/sprites/particles so the depth
    // plane holds exactly the world-span writes the accounting assumes)
    const data = { ...createDevroom(), alias: [], sprites: [], particles: [] };
    const world = { name: 'devroom', data };

    // armed (attribution) vs plain render must be output-identical
    const fbA = createFramebuffer(W, H, true);
    const ra = new SoftwareRenderer();
    ra.init(fbA);
    ra.setPalette(new Uint8Array(768).fill(128));
    const { stats, detail } = ra.testMeasureOverdraw(view, world, []);
    const fbB = createFramebuffer(W, H, true);
    const rb = new SoftwareRenderer();
    rb.init(fbB);
    rb.setPalette(new Uint8Array(768).fill(128));
    rb.beginFrame();
    const plain = rb.renderView(view, world, []);
    expect([...fbA.index!]).toEqual([...fbB.index!]);
    expect([...fbA.depth!]).toEqual([...fbB.depth!]);
    expect(stats.pixels).toBe(plain.pixels);

    // stage accounting: every admitted surface lands in exactly one bucket
    expect(detail.surfaces).toBe(11);
    expect(
      detail.degenerate + detail.frustumCulled + detail.backfaceCulled +
      detail.clipRejected + detail.emitted,
    ).toBe(detail.pvsVisible);
    // span accounting: attribution sees the same candidates the backend drew
    expect(detail.candidatePixels).toBe(stats.pixels);
    // depth accounting: front-to-back BSP order + strict `>` test means each
    // pixel is written at most once, so written + z-rejected === candidate
    expect(detail.writtenPixels + detail.zRejectedPixels).toBe(detail.candidatePixels);
    expect(detail.writtenPixels).toBeLessThanOrEqual(W * H);
    // no batch hit the pool cap (dropped spans would break the reconciliation)
    expect(detail.maxBatchSpans).toBeLessThan(MAX_SPANS);
    expect(detail.overdraw).toBeLessThan(2);
    console.log(formatOverdrawLine('devroom', detail));
  });
});

describe.runIf(!!process.env.Q2_PAK)('overdraw attribution on real base1 (Q2_PAK)', () => {
  it('residual overdraw is in-frustum occluded spans; worst under the recalibrated 2.5x ceiling', { timeout: 300000 }, () => {
    const pakPath = process.env.Q2_PAK as string;
    const data = readFileSync(pakPath);
    const map = loadBsp(pakReadFile(data, 'maps/base1.bsp'));
    const walCache = new Map<string, BspTexelSource | null>();
    const texelFor = (walName: string): BspTexelSource | null => {
      if (walCache.has(walName)) return walCache.get(walName)!;
      let src: BspTexelSource | null = null;
      try {
        const wal = parseWAL(pakReadFile(data, `textures/${walName}.wal`));
        src = { texels: wal.mips[0]!, width: wal.width, height: wal.height };
      } catch { src = null; }
      walCache.set(walName, src);
      return src;
    };
    const world = bspToMiniWorld(map, { texelFor });
    const pcx = parsePCX(pakReadFile(data, 'pics/colormap.pcx'));
    const W = 640, H = 480;
    const views = [
      { origin: v3(128, -320, 54), angles: v3(0, 90, 0), label: 'spawn-north' },
      { origin: v3(128, -320, 54), angles: v3(0, 180, 0), label: 'spawn-west' },
      { origin: v3(-944, 1552, 0), angles: v3(0, 180, 0), label: 'lowroad-west' },
      { origin: v3(-1648, 1544, 16), angles: v3(0, 0, 0), label: 'trench-east' },
    ];
    let worst = 0;
    for (const v of views) {
      const fb = createFramebuffer(W, H, true);
      const r = new SoftwareRenderer();
      r.init(fb);
      r.setPalette(pcx.palette);
      const { stats, detail } = r.testMeasureOverdraw(
        {
          origin: v.origin, angles: v.angles, fovX: 90, time: 1.5,
          lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'base1', data: world },
        [],
      );
      // structural proof, per view: admitted surfaces fully bucketed ...
      expect(
        detail.degenerate + detail.frustumCulled + detail.backfaceCulled +
        detail.clipRejected + detail.emitted,
      ).toBe(detail.pvsVisible);
      // ... candidates reconcile with the backend count ...
      expect(detail.candidatePixels).toBe(stats.pixels);
      // ... and with depth writes (each pixel written at most once, so the
      // remainder lost the depth test: in-frustum occluded span fill).
      expect(detail.writtenPixels + detail.zRejectedPixels).toBe(detail.candidatePixels);
      expect(detail.writtenPixels).toBeLessThanOrEqual(W * H);
      expect(detail.maxBatchSpans).toBeLessThan(MAX_SPANS);
      // occluded-surface fill dominates the residual on every real view ...
      expect(detail.zRejectedPixels).toBeGreaterThan(0);
      expect(detail.occludedShare).toBeGreaterThan(0.4);
      // ... while the bucketing stages name every admitted-but-unemitted
      // surface (zero unaccounted bucketing waste).
      expect(detail.frustumCulled + detail.backfaceCulled).toBeGreaterThan(0);
      expect(stats.pixels).toBeGreaterThan(W * H * 0.15);
      expect(new Set(fb.index!).size).toBeGreaterThan(20); // real WAL texels
      let h = 2166136261;
      const idx = fb.index!;
      for (let i = 0; i < idx.length; i++) {
        h ^= idx[i]!;
        h = Math.imul(h, 16777619);
      }
      const hash = (h >>> 0).toString(16).padStart(8, '0');
      console.log(
        `${formatOverdrawLine(`base1 ${v.label}`, detail)} ` +
        `spans=${stats.spans} hash=${hash} wals=${walCache.size}`,
      );
      worst = Math.max(worst, detail.overdraw);
    }
    console.log(`overdraw base1 worst=${worst.toFixed(3)} (recalibrated M3.3 ceiling 2.5)`);
    expect(worst).toBeLessThan(2.5);
  });
});
