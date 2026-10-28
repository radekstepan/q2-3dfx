// @q2/testkit — working voodoo baseline gates (no HW calibration).
//
// All deterministic, asset-free (procedural devroom fixtures only;
// Q2_PAK is never read). Tests gate on recomputed hashes/pixel assertions
// against the COMMITTED manifest (baseline-manifests/voodoo-baseline.json),
// never on committed pixels. Regenerate with:
//   yarn workspace @q2/testkit baseline

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { parsePCX, parseWAL } from '@q2/formats';
import { createFramebuffer } from '@q2/renderer-api';
import { v3 } from '@q2/math';
import {
  bspToMiniWorld,
  createDevroom,
  DEVROOM_CAMERA,
  isRGBWorldEnabled,
  setRGBWorldEnabled,
  SoftwareRenderer,
} from '@q2/sw-renderer';
import type { BspTexelSource } from '@q2/sw-renderer';
import {
  BASELINE_HEIGHT,
  BASELINE_MANIFEST_DIR,
  BASELINE_MANIFEST_FILE,
  BASELINE_SCENES,
  BASELINE_WIDTH,
  baselineCameraFor,
  baselineProfile,
  crossStageStats,
  generateBaseline,
  hashBaseline,
  paintBaselineScene,
  resolveRaw565Display,
  resolveReconstructedDisplay,
  writeBaselineOutputs,
  type BaselineManifest,
} from './voodoo-baseline.js';
import { DEMO_FALLBACK_MAP } from './demo-fallback.js';

const W = BASELINE_WIDTH;
const H = BASELINE_HEIGHT;

/** Package dir of @q2/testkit derived from this test's location. */
function testkitDir(): string {
  return new URL('../', import.meta.url).pathname;
}

async function readCommittedManifest(): Promise<BaselineManifest> {
  const fs = await import('fs');
  const pathname = `${testkitDir()}${BASELINE_MANIFEST_DIR}/${BASELINE_MANIFEST_FILE}`;
  let text: string;
  try {
    const raw = fs.readFileSync(pathname) as unknown as Uint8Array | string;
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    throw new Error(
      '[testkit] committed baseline manifest missing — regenerate with `yarn workspace @q2/testkit baseline`',
    );
  }
  return JSON.parse(text) as BaselineManifest;
}

describe('voodoo working baseline', () => {
  it('writes regen outputs on demand only (VOODOO_BASELINE_WRITE=1)', async () => {
    if (process.env.VOODOO_BASELINE_WRITE !== '1') return; // default: no writes.
    const dir = testkitDir();
    const outDir = `${dir}test-output/voodoo-baseline/`;
    const committed = `${dir}${BASELINE_MANIFEST_DIR}/${BASELINE_MANIFEST_FILE}`;
    const head = process.env.BASELINE_HEAD ?? 'unrecorded';
    const { manifestPath, files } = await writeBaselineOutputs(outDir, committed, head);
    expect(files.length).toBe(7 * 3 * 2 + 1);
    expect(manifestPath).toBe(committed);
    const reread = await readCommittedManifest();
    expect(reread.scenes.length).toBe(BASELINE_SCENES.length);
  }, 120000);

  it('saved profile round-trips through JSON and matches the pinned vd_* set', () => {
    const profile = baselineProfile();
    const roundTripped = JSON.parse(JSON.stringify(profile)) as typeof profile;
    expect(roundTripped).toEqual(profile);
    expect(profile).toEqual({
      vd_16bit: 1,
      vd_dither: 1,
      vd_postfilter: 1,
      vd_bilinear: 1,
      vd_mipdither: 1,
      vd_lodbias: -0.35,
      vd_fog: 1,
      vd_gamma: 1.3,
      vd_maxtexsize: 256,
      vd_zbits: 16,
      vd_palettetex: 1,
      vd_overbright: 1,
      vd_dithermode: '4x4',
      vd_reconmode: 'legacy',
      vd_rgbmaxdelta: '0,0,0',
    });
  });

  it('every scene is deterministic (same hash twice, fixed 640x480)', () => {
    expect([W, H]).toEqual([640, 480]);
    for (const scene of BASELINE_SCENES) {
      const a = hashBaseline(paintBaselineScene(scene, W, H));
      const b = hashBaseline(paintBaselineScene(scene, W, H));
      expect(a, scene).toBe(b);
    }
  });

  it('raw-vs-reconstructed DIFFER on dithered gradients (ramp, edge)', () => {
    for (const scene of ['ramp', 'edge'] as const) {
      const src = paintBaselineScene(scene, W, H);
      const raw = resolveRaw565Display(src, W, H, 1.3);
      const recon = resolveReconstructedDisplay(src, W, H, 1.3);
      const stats = crossStageStats(raw, recon);
      // The 2x2 box melts the 4x4 dither pattern: well over 1% of pixels
      // must move by more than 1 LSB, or dither/recon is disconnected.
      expect(stats.fraction, `${scene} fraction`).toBeGreaterThan(0.01);
      expect(stats.maxAbsDelta, `${scene} maxAbsDelta`).toBeGreaterThan(1);
    }
  });

  it('raw-vs-reconstructed AGREE on flat fields (within one 565 quantum)', () => {
    const src = paintBaselineScene('flat', W, H);
    const raw = resolveRaw565Display(src, W, H, 1.3);
    const recon = resolveReconstructedDisplay(src, W, H, 1.3);
    const stats = crossStageStats(raw, recon);
    // Reconstruction of a uniform field can only redistribute the dither
    // pattern: no channel may move more than one 565 quantum (8 LSB red).
    expect(stats.maxAbsDelta).toBeLessThanOrEqual(8);
  });

  it('red/blue lit wall retains distinct hues through both stages', () => {
    const src = paintBaselineScene('litwall', W, H);
    for (const buf of [resolveRaw565Display(src, W, H, 1.3), resolveReconstructedDisplay(src, W, H, 1.3)]) {
      let lr = 0;
      let lb = 0;
      let rr = 0;
      let rb = 0;
      let n = 0;
      const y = (H / 2) | 0;
      for (let x = 0; x < W; x++) {
        const px = buf[y * W + x]!;
        const r = px & 255;
        const b = (px >> 16) & 255;
        if (x < W * 0.3) {
          lr += r;
          lb += b;
          n++;
        } else if (x > W * 0.7) {
          rr += r;
          rb += b;
        }
      }
      // Left patch is red-lit, right patch blue-lit — hues must survive.
      expect(lr / n).toBeGreaterThan((lb / n) + 40);
      expect(rb / n).toBeGreaterThan((rr / n) + 40);
    }
  });

  it('transparent hole shows the backdrop, field does not', () => {
    const src = paintBaselineScene('hole', W, H);
    const holePx = (x: number, y: number): number => src[y * W + x]!;
    const cx = (W / 2) | 0;
    const cy = (H / 2) | 0;
    const backdrop = (0xff000000 | (0 << 16) | (192 << 8) | 0) >>> 0;
    expect(holePx(cx, cy)).toBe(backdrop);
    expect(holePx(10, 10)).not.toBe(backdrop);
    for (const buf of [resolveRaw565Display(src, W, H, 1.3), resolveReconstructedDisplay(src, W, H, 1.3)]) {
      const g = (buf[cy * W + cx]! >> 8) & 255;
      const r = buf[cy * W + cx]! & 255;
      // Green backdrop stays green-dominant after resolve, not gray fringe.
      expect(g).toBeGreaterThan(r + 40);
    }
  });

  it('checker LOD spans black and white and stays opaque', () => {
    const src = paintBaselineScene('checker', W, H);
    let min = 255;
    let max = 0;
    let nonOpaque = 0;
    for (let i = 0; i < src.length; i++) {
      const px = src[i]!;
      const v = px & 255;
      if (v < min) min = v;
      if (v > max) max = v;
      if (px >>> 24 !== 255) nonOpaque++;
    }
    expect(nonOpaque).toBe(0);
    expect(min).toBeLessThanOrEqual(16);
    expect(max).toBeGreaterThanOrEqual(235);
  });

  it('committed manifest matches recomputation (hashes + profile)', async () => {
    const committed = await readCommittedManifest();
    expect(committed.scenes.map((s) => s.scene)).toEqual([...BASELINE_SCENES]);
    const { manifest } = generateBaseline(W, H, 'test');
    for (const entry of manifest.scenes) {
      const saved = committed.scenes.find((s) => s.scene === entry.scene);
      expect(saved, `${entry.scene} in manifest`).toBeDefined();
      expect(saved!.profile).toEqual(entry.profile);
      expect(saved!.stages['raw-565'].hash).toBe(entry.stages['raw-565'].hash);
      expect(saved!.stages.reconstructed.hash).toBe(entry.stages.reconstructed.hash);
      expect(saved!.stages.display.hash).toBe(entry.stages.display.hash);
      expect(saved!.resolution).toEqual({ width: W, height: H });
      expect(saved!.map).toBe(DEMO_FALLBACK_MAP);
      expect(saved!.renderPath).toBe('serial');
    }
  });

  it('captures are asset-free: every scene is a procedural devroom fixture', () => {
    const { manifest } = generateBaseline(W, H, 'test');
    for (const entry of manifest.scenes) {
      expect(entry.map).toBe(DEMO_FALLBACK_MAP);
      // Camera is one of the fixed demoFallbackViews (round-robin).
      const { name } = baselineCameraFor(manifest.scenes.indexOf(entry));
      expect(entry.camera.name).toBe(name);
    }
  });

  it('every manifest entry records map/camera/sim/res/cvars/revision/stage (§6)', async () => {
    // Astra guide §6: each reference capture is recorded with map/assets,
    // camera, simulation time, resolution, all cvars, renderer revision and
    // capture stage. Asserted against BOTH the committed manifest and a
    // fresh in-memory regen, so neither can silently lose a field.
    const committed = await readCommittedManifest();
    const { manifest: fresh } = generateBaseline(W, H, 'test');
    const expectedProfileKeys = [
      'vd_16bit', 'vd_dither', 'vd_postfilter', 'vd_bilinear', 'vd_mipdither',
      'vd_lodbias', 'vd_fog', 'vd_gamma', 'vd_maxtexsize', 'vd_zbits',
      'vd_palettetex', 'vd_overbright', 'vd_dithermode', 'vd_reconmode',
      'vd_rgbmaxdelta',
    ].sort();
    for (const manifest of [committed, fresh]) {
      expect(manifest.scenes.length).toBe(BASELINE_SCENES.length);
      for (const entry of manifest.scenes) {
        expect(typeof entry.map, `${entry.scene}.map`).toBe('string');
        expect(entry.map.length).toBeGreaterThan(0);
        expect(typeof entry.camera.name, `${entry.scene}.camera.name`).toBe('string');
        expect(entry.camera.name.length).toBeGreaterThan(0);
        for (const axis of ['origin', 'angles'] as const) {
          expect(Array.isArray(entry.camera[axis]), `${entry.scene}.camera.${axis}`).toBe(true);
          expect(entry.camera[axis]).toHaveLength(3);
          for (const v of entry.camera[axis]) expect(Number.isFinite(v)).toBe(true);
        }
        expect(Number.isFinite(entry.camera.fovX), `${entry.scene}.camera.fovX`).toBe(true);
        expect(Number.isFinite(entry.simTime), `${entry.scene}.simTime`).toBe(true);
        expect(entry.resolution, entry.scene).toEqual({ width: W, height: H });
        expect(entry.renderPath, entry.scene).toBe('serial');
        expect(Object.keys(entry.profile).sort(), `${entry.scene}.profile`).toEqual(expectedProfileKeys);
        expect(typeof entry.renderer.revision, `${entry.scene}.renderer.revision`).toBe('string');
        expect(entry.renderer.revision.length).toBeGreaterThan(0);
        expect(entry.renderer.resolve, entry.scene).toBe('pinned-duplicate@5e13d42');
        expect(Object.keys(entry.stages).sort(), `${entry.scene}.stages`).toEqual(
          ['display', 'raw-565', 'reconstructed'],
        );
        for (const stage of ['raw-565', 'reconstructed', 'display'] as const) {
          expect(entry.stages[stage].hash, `${entry.scene}.${stage}`).toMatch(/^[0-9a-f]{8}$/);
          expect(entry.stages[stage].pixels, `${entry.scene}.${stage}`).toBe(W * H);
        }
      }
    }
  });

  it('sim-time advancement covers t=0/1.5/3 across scenes', () => {
    // The three fixed fallback cameras sit at t=0/1.5/3 and scenes take
    // them round-robin — every capture timestamp must stay represented so a
    // dropped/renamed camera cannot silently collapse the time axis.
    const { manifest } = generateBaseline(W, H, 'test');
    const times = new Set(manifest.scenes.map((s) => s.simTime));
    for (const t of [0, 1.5, 3]) expect(times.has(t), `simTime ${t}`).toBe(true);
  });

  it('game adapter sanity: REAL instance RGB hook + real render cover (no source-text probes)', () => {
    // The RGB-world switch is a REAL instance method on SoftwareRenderer
    // (`packages/sw-renderer/src/frame.ts`) plus the module-level pair it
    // drives. Probe the prototype (never source text — testkit must not
    // parse apps/* and must not depend on backend file layout) and prove
    // the instance hook drives a real RGB pass through the real devroom:
    // cover > 0 + used when armed via the instance, 0/unused when off.
    expect(typeof SoftwareRenderer.prototype.setRGBWorldEnabled).toBe('function');
    expect(typeof SoftwareRenderer.prototype.isRGBWorldEnabled).toBe('function');
    const pal = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = (i * 5) & 255;
      pal[i * 3 + 1] = (i * 3 + 40) & 255;
      pal[i * 3 + 2] = (i * 2 + 80) & 255;
    }
    const renderDevroomRGB = (on: boolean): { used: boolean; cover: number } => {
      const r = new SoftwareRenderer();
      r.init(createFramebuffer(160, 120, true));
      r.setPalette(pal);
      r.setRGBWorldEnabled(on); // the REAL instance method under test
      expect(r.isRGBWorldEnabled()).toBe(on);
      expect(isRGBWorldEnabled()).toBe(on); // instance drives the shared flag
      r.beginFrame();
      r.renderView(
        {
          origin: DEVROOM_CAMERA.origin,
          angles: DEVROOM_CAMERA.angles,
          fovX: DEVROOM_CAMERA.fovX,
          time: 1.5,
          lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'devroom', data: createDevroom() },
        [],
      );
      r.endFrame();
      const st = r.testRGBStats();
      r.setRGBWorldEnabled(false); // never leak the module-global flag
      return { used: st.used, cover: st.coverPixels };
    };
    try {
      const off = renderDevroomRGB(false);
      expect(off.used).toBe(false);
      expect(off.cover).toBe(0);
      const on = renderDevroomRGB(true);
      expect(on.used).toBe(true);
      // The RGB backend drew world spans: the coverage mask is non-zero.
      expect(on.cover).toBeGreaterThan(0);
    } finally {
      setRGBWorldEnabled(false);
    }
    expect(isRGBWorldEnabled()).toBe(false);
  });

  describe('real-map (base1) voodoo capture note (Q2_PAK-gated)', () => {
    // The committed baseline above is procedural-devroom-only by design
    // (asset-free, Q2_PAK never read). This block records the real-map
    // counterpart as a NOTE, not a gate: when Q2_PAK is present it renders
    // the base1 spawn view through the real pipeline (indexed + RGB via
    // the real instance hook) and logs both resolve-stage hashes; when
    // absent it records the skip explicitly so the log shows the note was
    // considered, not silently dropped.
    const Q2_PAK = process.env.Q2_PAK;

    it.runIf(!!Q2_PAK)('renders base1 spawn through indexed + real RGB and logs the capture note', { timeout: 300000 }, () => {
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
      const W2 = 320;
      const H2 = 240;
      const view = {
        origin: v3(128, -320, 54),
        angles: v3(0, 90, 0),
        fovX: 90,
        time: 1.5,
        lightStyles: new Float32Array(256).fill(1),
      };
      const renders: Record<'indexed' | 'rgb', { color: Uint32Array; cover: number; used: boolean }> = {
        indexed: { color: new Uint32Array(0), cover: 0, used: false },
        rgb: { color: new Uint32Array(0), cover: 0, used: false },
      };
      try {
        for (const mode of ['indexed', 'rgb'] as const) {
          const r = new SoftwareRenderer();
          r.init(createFramebuffer(W2, H2, true));
          r.setPalette(pcx.palette);
          r.setRGBWorldEnabled(mode === 'rgb'); // real instance hook
          r.beginFrame();
          r.renderView(view, { name: 'base1', data: world }, []);
          r.endFrame();
          const live = r.getFramebuffer();
          renders[mode] = {
            color: live.color.slice(),
            cover: r.testRGBStats().coverPixels,
            used: r.testRGBStats().used,
          };
        }
      } finally {
        setRGBWorldEnabled(false);
      }
      // Sanity only (no hash pinning — the renderer is owned by parallel
      // lanes): real WAL texels, opaque frame, RGB pass covered the map.
      for (const mode of ['indexed', 'rgb'] as const) {
        const { color } = renders[mode];
        expect(color.length).toBe(W2 * H2);
        for (let i = 0; i < color.length; i++) expect(color[i]! >>> 24).toBe(0xff);
      }
      expect(new Set(renders['indexed'].color).size).toBeGreaterThan(20);
      expect(renders['rgb'].used).toBe(true);
      expect(renders['rgb'].cover).toBeGreaterThan(0);
      // The NOTE: both resolve stages over the real RGB frame, logged for
      // the human-review side-by-side (M4.1 tail), never gated.
      const profile = baselineProfile();
      const raw = resolveRaw565Display(renders['rgb'].color, W2, H2, profile.vd_gamma);
      const recon = resolveReconstructedDisplay(renders['rgb'].color, W2, H2, profile.vd_gamma);
      console.log(
        `[testkit] base1 voodoo capture note: spawn-north ${W2}x${H2} ` +
          `indexed=${hashBaseline(renders['indexed'].color)} rgb=${hashBaseline(renders['rgb'].color)} ` +
          `raw-565=${hashBaseline(raw)} reconstructed=${hashBaseline(recon)} rgbCover=${renders['rgb'].cover}`,
      );
    });

    it.runIf(!Q2_PAK)('records the skip explicitly (no Q2_PAK in this environment)', () => {
      console.log(
        '[testkit] base1 voodoo capture SKIPPED: Q2_PAK is unset — ' +
          'committed baseline stays procedural-devroom-only (see VOODOO_BASELINE_APPROXIMATIONS.md).',
      );
      expect(process.env.Q2_PAK).toBeFalsy();
    });
  });

  it('voodoo stable API feature detection (passes with or without the package)', async () => {    let voodoo: Record<string, unknown> | null = null;
    try {
      const spec = '@q2/' + 'voodoo';
      voodoo = (await import(/* @vite-ignore */ spec)) as unknown as Record<string, unknown>;
    } catch {
      voodoo = null;
    }
    if (voodoo === null) return; // package not resolvable here — baseline stands alone.
    expect(typeof voodoo['resolveFrame']).toBe('function');
    expect(typeof voodoo['expandRGB565']).toBe('function');
    const expand = voodoo['expandRGB565'] as (v: number) => number;
    // Stable property (immune to parallel-lane internals): expand inverts a
    // 565 pack to within one quantum per channel (R/B <= 8, G <= 4).
    for (const [r, g, b] of [[0, 0, 0], [128, 128, 128], [255, 255, 255], [200, 60, 60], [60, 80, 200]] as const) {
      const v = (((r & 0xf8) << 8) | ((g & 0xfc) << 3) | ((b & 0xf8) >> 3)) & 0xffff;
      const px = expand(v) >>> 0;
      expect(Math.abs((px & 255) - r)).toBeLessThanOrEqual(8);
      expect(Math.abs(((px >> 8) & 255) - g)).toBeLessThanOrEqual(4);
      expect(Math.abs(((px >> 16) & 255) - b)).toBeLessThanOrEqual(8);
      expect(px >>> 24).toBe(255);
    }
  });
});
