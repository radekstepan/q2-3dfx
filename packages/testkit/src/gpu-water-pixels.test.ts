// @q2/testkit — GPU-FOLLOW-3B real-pixel water regressions (Node-only harness).
//
// Renders through the PRODUCTION WebGLRenderer + production shaders (the
// LOD-unwarped + highp repair) in real headless Chromium (SwiftShader
// WebGL2) and reads back actual pixels (test-only capture; production stays
// readback-free). This is the lifecycle image evidence FOLLOW-3B box 3 /
// FOLLOW-5 require: formula mirrors and nonblack/color-count checks cannot
// prove the tile seams are gone, and they pass with missing textures.
//
// Legs (see ./gpu-water-pixels-page.js):
//   synth (asset-free, always): hand-built turbulent+translucent quad pair
//     (combined material, mirrors base1 faces 117/118) at multiple times
//     incl. the turb phase wrap 1023->0 (t=15.984375/16.0), with a
//     detached-world negative control.
//   real (Q2_PAK): base1 pool view over textures/e1u1/bluwter.wal water
//     (102 turbulent TRANS66 faces), same time lattice, with a
//     bluwter-withheld negative control (required asset removed).
//
// Gating: chromium binary must be present (else skip gracefully); the real
// legs additionally require Q2_PAK (else they record a skip while the
// synthetic legs still run).

import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chromiumBinaryPath,
  connectCdp,
  extractPakAssets,
  launchChromium,
  makeProofScratchDir,
  resolvePakPath,
  serveProofTestDir,
  waitForProofDone,
  type CdpConnection,
  type ChromiumHandle,
  type StaticServer,
} from './gpu-browser.js';
import { buildWaterProbePageHtml } from './gpu-water-pixels-page.js';
import { gpuBrowserLibPaths } from './gpu-browser-page.js';

const PAK_PATH = resolvePakPath();
const CHROMIUM_BIN = chromiumBinaryPath();

interface DiffStat {
  count: number;
  frac: number;
  bbox: [number, number, number, number] | null;
  bboxArea: number;
}

interface WaterProof {
  done: boolean;
  error: string | null;
  webgl2: boolean;
  glVersion: string;
  glRenderer: string;
  synth: {
    turbSelected: number;
    sceneSurfaces: number;
    nonBlack: number;
    det: DiffStat;
    anim: DiffStat;
    wrap: DiffStat;
    emptyVsTextured: DiffStat;
    overlapAnimWater: number;
  };
  real: {
    map: string;
    material: string;
    origin: number[];
    yaw: number;
    pitch: number;
    fovX: number;
    times: number[];
    turbSelected: number;
    sceneSurfaces: number;
    nonBlack: number;
    det: DiffStat;
    anim: DiffStat;
    anim15: DiffStat;
    wrap: DiffStat;
    dryVsWet: DiffStat;
    overlapAnimWater: number;
    overlapWrapWater: number;
  } | null;
  realError?: string;
}

describe.runIf(!CHROMIUM_BIN)('gpu water pixels (skipped)', () => {
  it('logs the skip reason', () => {
    console.log(`[water-pixels] SKIP: chromium absent (Q2_PAK=${PAK_PATH ?? 'absent'})`);
  });
});

describe.runIf(!!CHROMIUM_BIN)('gpu water pixels (real WebGL2)', () => {
  it(
    'repaired water renders deterministically, moves, and survives asset removal controls',
    { timeout: 240000 },
    async () => {
      const testDir = dirname(fileURLToPath(import.meta.url));
      const packagesDir = join(testDir, '..', '..');
      const scratch = makeProofScratchDir();
      mkdirSync(join(scratch, 'assets'), { recursive: true });
      if (PAK_PATH) {
        const n = extractPakAssets(PAK_PATH, join(scratch, 'assets'));
        console.log(`[water-pixels] extracted ${n} assets`);
      } else {
        console.log('[water-pixels] no Q2_PAK: real legs will record a skip');
      }
      writeFileSync(join(scratch, 'page.html'), buildWaterProbePageHtml(gpuBrowserLibPaths('/lib')));
      mkdirSync(join(scratch, 'profile'), { recursive: true });

      let server: StaticServer | null = null;
      let chromium: ChromiumHandle | null = null;
      let cdp: CdpConnection | null = null;
      try {
        server = await serveProofTestDir(scratch, packagesDir);
        const pageUrl = `${server.url}/page.html`;
        console.log(`[water-pixels] serving ${pageUrl} (chromium=${CHROMIUM_BIN})`);
        chromium = await launchChromium(pageUrl, join(scratch, 'profile'));
        cdp = await connectCdp(chromium.port);
        const proof = await waitForProofDone<WaterProof>(cdp, 200000);
        const consoleLines = cdp.consoleLines();
        console.log(`[water-pixels] page console:\n${consoleLines.join('\n')}`);

        expect(proof.error).toBeNull();
        expect(proof.done).toBe(true);
        expect(proof.webgl2).toBe(true);
        console.log(`[water-pixels] GL: ${proof.glVersion} | ${proof.glRenderer}`);

        // --- Synthetic legs (asset-free, combined turbulent+translucent) ---
        const s = proof.synth;
        // Independent expectation: the quad pair is actually selected.
        expect(s.turbSelected).toBe(2);
        expect(s.nonBlack).toBeGreaterThan(0.05);
        // Determinism: same scene + time replays byte-identical (the matched
        // before/after crop baseline; also proves the comparator can pass).
        expect(s.det.count).toBe(0);
        // Liveness: the warp moves real pixels between distant times (the
        // same comparator that passes above must fail here).
        expect(s.anim.frac).toBeGreaterThan(0.02);
        // Phase-wrap continuity: the 1023->0 turb-phase step moves far
        // fewer pixels than genuine motion (relational, not a magic bound).
        expect(s.wrap.frac).toBeLessThan(s.anim.frac);
        // Negative control: detaching the water world changes the frame
        // substantially (the water pixels come from the geometry, not the
        // clear color or a stale target).
        expect(s.emptyVsTextured.frac).toBeGreaterThan(0.05);
        // The motion bbox overlaps the geometry-removal bbox: the moving
        // pixels ARE the water quads.
        expect(s.overlapAnimWater).toBeGreaterThan(0);

        // --- Real legs (Q2_PAK only) ---
        if (!PAK_PATH) {
          console.log('[water-pixels] real legs skipped (no Q2_PAK)');
        } else {
          expect(proof.real, `real legs must run with Q2_PAK (realError=${proof.realError ?? 'none'})`).not.toBeNull();
          const r = proof.real!;
          expect(r.map).toBe('base1');
          expect(r.times).toEqual([0, 1.5, 7.25, 15.984375, 16.0]);
          // Independent expectation: retail turbulent water is selected
          // (combined turbulent+translucent material on bluwter).
          expect(r.turbSelected).toBeGreaterThan(0);
          console.log(`[water-pixels] real: turbSelected=${r.turbSelected} scene=${r.sceneSurfaces} nonBlack=${r.nonBlack.toFixed(3)}`);
          // Deterministic replay at fixed time.
          expect(r.det.count).toBe(0);
          // Motion alive at two time deltas on retail art.
          expect(r.anim.frac).toBeGreaterThan(0.005);
          expect(r.anim15.frac).toBeGreaterThan(0.005);
          // Phase-wrap step is bounded far below genuine motion.
          expect(r.wrap.frac).toBeLessThan(r.anim.frac);
          expect(r.wrap.frac).toBeLessThan(r.anim15.frac);
          // Negative control (required asset removed): withholding bluwter
          // changes a real region (not a few pixels, not the void).
          expect(r.dryVsWet.frac).toBeGreaterThan(0.01);
          expect(r.dryVsWet.bbox).not.toBeNull();
          expect(r.dryVsWet.bboxArea / (320 * 240)).toBeGreaterThan(0.01);
          // The motion bbox overlaps the water bbox: the moving pixels ARE
          // the water region (not sky, walls, or noise elsewhere).
          expect(r.overlapAnimWater).toBeGreaterThan(0);
          console.log(
            `[water-pixels] anim=${r.anim.frac.toFixed(4)} wrap=${r.wrap.frac.toFixed(4)} ` +
            `dryVsWet=${r.dryVsWet.frac.toFixed(4)} overlap=${r.overlapAnimWater.toFixed(4)}`,
          );
        }
      } finally {
        if (cdp) {
          await cdp.close().catch(() => undefined);
          cdp = null;
        }
        if (chromium) {
          chromium.kill();
          chromium = null;
        }
        if (server) {
          server.close();
          server = null;
        }
      }
    },
  );
});
