// @q2/testkit — PROOF-3 boxes 4-5: real-browser integration tests (Node-only).
//
// Boots the real base1 F0/F1 proof-route scene in headless Chromium (real
// WebGL2), compiles the PRODUCTION shaders, renders with the PRODUCTION
// WebGLRenderer, and checks geometry/gun presence, occlusion and
// transparency — plus a report-only end-to-end rAF timing loop (box 5).
//
// Gating: Q2_PAK (asset pak) AND a chromium binary must be present; when
// either is absent the browser suite skips gracefully with a log line (the
// production-path readback scan below ALWAYS runs).
//
// Frame capture/readback happens here and in the harness-generated page
// (test-only). The normal production path stays readback-free — pinned by
// the always-on scan below.
//
// Thresholds are predeclared constants with rationale; bands are WIDE (order
// of magnitude below/above the pilot measurements, never fitted tight).
// A blank/partial scene fails closed via the coverage floors.

import { describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { buildProofPageHtml, gpuBrowserLibPaths } from './gpu-browser-page.js';

// --- Predeclared bands (rationale inline; pilot-calibrated, wide) ------------

// F0/F1 are interior spawn-room frames: walls + entities fill most of the
// 640x480 frame. Anything below 20% covered means a blank/partial scene.
const COVER_MIN = 0.2;
// F0 (no gun/lights/particles) vs F1 (combat) must differ by >>1%: the gun
// viewmodel alone covers a large bottom-center block.
const F0F1_MIN_FRAC = 0.01;
// Gun-on vs gun-off: the differing pixels concentrate in the gun bbox; >1%
// of that bbox must differ (gun covers wall where they overlap).
const GUN_BBOX_MIN_FRAC = 0.01;
const GUN_BBOX_MIN_PX = 1000;
// Beam-on vs beam-off: a ~1.5px camera-facing strip; the diff bbox hugs it,
// so >0.5% of the bbox must differ and the strip must be tens of pixels.
const BEAM_BBOX_MIN_FRAC = 0.005;
const BEAM_MIN_PX = 40;
// Occlusion: depth-test-off vs depth-test-on full-frame diff. Overlapping
// opaque batches resolve differently without depth testing; >0.5% of the
// frame must change or depth is not deciding anything (fail closed).
const OCCLUSION_MIN_FRAC = 0.005;
// Shaders: all three production programs (lit/alias/flat — the full route
// variant set) must compile+link cleanly; the gate needs at least two.
const PROGRAM_MIN = 2;
// Scene presence: the stub-leg invariant (>100 surfaces for the F1
// frustum) must also hold in the real browser.
const SCENE_MIN_SURFACES = 100;
// Timings (box 5, report-only): >=120 rAF samples of the F1 combat frame.
const TIMING_MIN_FRAMES = 120;

interface ProofDiffSummary {
  count: number;
  frac: number;
  bbox: [number, number, number, number] | null;
  bboxArea?: number;
  bboxFrac: number;
}

interface ProofResult {
  done: boolean;
  error: string | null;
  webgl2: boolean;
  glVersion: string;
  glRenderer: string;
  glVendor: string;
  programs: Array<{ name: string; compiled: boolean; linked: boolean; logLength?: number; log?: string }>;
  scene: { surfaces: number; worldRefs: number; entityRefs: number };
  stats: {
    drawsF0: number;
    drawsF1: number;
    coverageF0: { covered: number; frac: number };
    coverageF1: { covered: number; frac: number };
    f1vsF1b: ProofDiffSummary;
    f0vsF1: ProofDiffSummary;
    gun: ProofDiffSummary;
    beam: ProofDiffSummary;
    soldier: ProofDiffSummary;
    sprite: ProofDiffSummary;
    depthOff: ProofDiffSummary;
    centroidGun: { x: number; y: number; n: number } | null;
    centroidBeam: { x: number; y: number; n: number } | null;
    centroidSoldier: { x: number; y: number; n: number } | null;
    centroidSprite: { x: number; y: number; n: number } | null;
  };
  warningsF1: string[];
  uploadsF1: { uploads: number };
  framesSubmitted: number;
  timings: { frames: number; min: number; median: number; p95: number; max: number; mean: number };
}

// --- Always-on production-path readback scan ---------------------------------

describe('gpu-browser production readback check', () => {
  it('webgl-renderer src contains no readPixels (production path stays readback-free)', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const srcDir = join(testDir, '..', '..', 'webgl-renderer', 'src');
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts')).sort();
    expect(files.length).toBeGreaterThan(0);
    const callRe = /\.readPixels\s*\(/;
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(join(srcDir, f)).toString();
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        // Real calls are banned everywhere (including tests — the stub-leg
        // assertion only mentions the method NAME in a startsWith string).
        if (callRe.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        // Non-test sources may reference readPixels only in // comments
        // (e.g. the documented no-readback invariant); any code mention is
        // a production-path capture and fails the pin.
        else if (!f.endsWith('.test.ts') && line.replace(/\/\/.*$/, '').includes('readPixels')) {
          offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

// --- Gated real-browser suite -------------------------------------------------

const PAK_PATH = resolvePakPath();
const CHROMIUM_BIN = chromiumBinaryPath();
const GATE = PAK_PATH !== null && CHROMIUM_BIN !== null;

describe.runIf(!GATE)('gpu-browser real-browser proof (skipped)', () => {
  it('logs the skip reason', () => {
    console.log(
      `[gpu-browser] SKIP: Q2_PAK=${PAK_PATH ?? 'absent'} chromium=${CHROMIUM_BIN ?? 'absent'} ` +
        '(set Q2_PAK to a pak0.pak; chromium lives at /usr/bin/chromium)',
    );
  });
});

describe.runIf(GATE)('gpu-browser real-browser proof (PROOF-3 boxes 4-5)', () => {
  it(
    'production shaders compile; geometry/gun/occlusion/transparency hold; timings reported',
    { timeout: 480000 },
    async () => {
      const pak = PAK_PATH as string;
      const testDir = dirname(fileURLToPath(import.meta.url));
      const packagesDir = join(testDir, '..', '..');
      const scratch = makeProofScratchDir();
      const assetsDir = join(scratch, 'assets');
      const extracted = extractPakAssets(pak, assetsDir);
      console.log(`[gpu-browser] extracted ${extracted.length} assets to ${assetsDir}`);
      writeFileSync(join(scratch, 'page.html'), buildProofPageHtml(gpuBrowserLibPaths('/lib')));
      mkdirSync(join(scratch, 'profile'), { recursive: true });

      let server: StaticServer | null = null;
      let chromium: ChromiumHandle | null = null;
      let cdp: CdpConnection | null = null;
      try {
        server = await serveProofTestDir(scratch, packagesDir);
        const pageUrl = `${server.url}/page.html`;
        console.log(`[gpu-browser] serving ${pageUrl} (chromium=${CHROMIUM_BIN})`);
        chromium = await launchChromium(pageUrl, join(scratch, 'profile'));
        cdp = await connectCdp(chromium.port);
        const proof = await waitForProofDone<ProofResult>(cdp, 420000);
        const shot = await cdp.screenshot();
        const consoleLines = cdp.consoleLines();

        console.log(`[gpu-browser] page console:\n${consoleLines.join('\n')}`);
        console.log(`[gpu-browser] proof: ${JSON.stringify(proof)}`);

        // Evidence artifacts next to the test output dir.
        const outDir = join(testDir, '..', 'test-output');
        mkdirSync(outDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const base = join(outDir, `gpu-browser-${stamp}`);
        writeFileSync(
          `${base}.json`,
          JSON.stringify(
            {
              stamp,
              pak,
              chromium: CHROMIUM_BIN,
              bands: {
                COVER_MIN,
                F0F1_MIN_FRAC,
                GUN_BBOX_MIN_FRAC,
                GUN_BBOX_MIN_PX,
                BEAM_BBOX_MIN_FRAC,
                BEAM_MIN_PX,
                OCCLUSION_MIN_FRAC,
                PROGRAM_MIN,
                SCENE_MIN_SURFACES,
                TIMING_MIN_FRAMES,
              },
              proof,
              consoleLines,
            },
            null,
            2,
          ),
        );
        writeFileSync(`${base}.png`, shot);
        console.log(`[gpu-browser] artifacts: ${base}.json + ${base}.png`);

        // --- page health ---
        expect(proof.error).toBeNull();
        expect(proof.done).toBe(true);
        expect(proof.webgl2).toBe(true);
        console.log(`[gpu-browser] GL: ${proof.glVersion} | ${proof.glRenderer} | ${proof.glVendor}`);

        // --- box 4a: shaders compile in the real browser ---
        expect(proof.programs.length).toBeGreaterThanOrEqual(PROGRAM_MIN);
        for (const p of proof.programs) {
          expect(`${p.name}: compiled=${p.compiled} linked=${p.linked} log=${p.log ?? ''}`).toBe(
            `${p.name}: compiled=true linked=true log=`,
          );
          expect(p.logLength ?? 0).toBe(0);
        }

        // --- box 4b: geometry presence (coverage bands, fail closed) ---
        expect(proof.scene.surfaces).toBeGreaterThan(SCENE_MIN_SURFACES);
        expect(proof.stats.drawsF1).toBeGreaterThan(0);
        expect(proof.stats.coverageF0.frac).toBeGreaterThanOrEqual(COVER_MIN);
        expect(proof.stats.coverageF1.frac).toBeGreaterThanOrEqual(COVER_MIN);
        // Determinism probe: the identical F1 frame twice must be
        // byte-identical (no dither/phase in the PROOF-3 shaders). Any drift
        // here invalidates every variant diff below — fail closed.
        expect(proof.stats.f1vsF1b.count).toBe(0);
        expect(proof.stats.f0vsF1.frac).toBeGreaterThanOrEqual(F0F1_MIN_FRAC);
        console.log(
          `[gpu-browser] coverage: F0=${proof.stats.coverageF0.frac.toFixed(4)} ` +
            `F1=${proof.stats.coverageF1.frac.toFixed(4)} F0vsF1=${proof.stats.f0vsF1.frac.toFixed(4)} ` +
            `drawsF0=${proof.stats.drawsF0} drawsF1=${proof.stats.drawsF1} ` +
            `surfaces=${proof.scene.surfaces} uploads=${proof.uploadsF1.uploads}`,
        );
        console.log(`[gpu-browser] renderer warnings: ${JSON.stringify(proof.warningsF1)}`);

        // --- box 4c: gun presence (gun-on vs gun-off in the gun bbox) ---
        // Expected screen slots (GL coords, y=0 bottom) read off the CPU
        // F1 reference: gun bottom-right, soldier bottom-center, sprite
        // top-left billboard, beam mid-left. Quadrant checks are wide; a
        // misplaced class fails closed (production-code gap, not a band).
        //
        // KNOWN PRODUCTION DEFECT (2026-10-29, reported, not fixed here —
        // testkit owns no production code): the placement gates below FAIL
        // because buildProjectionMatrix negates the Y row (m[5] = -fy in
        // packages/webgl-renderer/src/matrices.ts). View-space up must map
        // to NDC up with the same sign (CPU: screen y = yCenter - IY*...,
        // so IY>0 renders above center); the minus flips the whole frame
        // vertically vs the CPU reference (contract §3: a GPU flip is a
        // bug, not a tolerance item). Measured in real Chromium (SwiftShader
        // WebGL2): soldier centroid GL (297,380) vs expected lower half,
        // gun (469,389) vs expected bottom-right, sprite (313,127) vs
        // expected top-left, beam (60,320) vs expected ~(60,160). The
        // owning lane's fix is the m[5] sign (matrices.test.ts pins only
        // center + depth, not the sign); on the fixed tree these gates go
        // green unchanged.
        const gun = proof.stats.gun;
        expect(gun.bbox).not.toBeNull();
        expect(gun.bboxFrac).toBeGreaterThanOrEqual(GUN_BBOX_MIN_FRAC);
        expect(gun.count).toBeGreaterThanOrEqual(GUN_BBOX_MIN_PX);
        // Viewmodel sits at the screen bottom (GL coords: y=0 is the bottom).
        expect(gun.bbox![1]).toBeLessThan(240);
        console.log(`[gpu-browser] gun: ${JSON.stringify(gun)}`);
        const cg = proof.stats.centroidGun;
        console.log(`[gpu-browser] centroids: ${JSON.stringify({
          gun: proof.stats.centroidGun,
          beam: proof.stats.centroidBeam,
          soldier: proof.stats.centroidSoldier,
          sprite: proof.stats.centroidSprite,
        })}`);
        expect(cg).not.toBeNull();
        expect(cg!.y).toBeLessThan(240); // bottom half
        expect(cg!.x).toBeGreaterThan(320); // right half
        const cs = proof.stats.centroidSoldier;
        expect(cs).not.toBeNull();
        expect(proof.stats.soldier.count).toBeGreaterThanOrEqual(GUN_BBOX_MIN_PX);
        expect(cs!.y).toBeLessThan(240);
        expect(cs!.x).toBeGreaterThan(160);
        expect(cs!.x).toBeLessThan(480);
        const cp = proof.stats.centroidSprite;
        expect(cp).not.toBeNull();
        expect(proof.stats.sprite.count).toBeGreaterThanOrEqual(GUN_BBOX_MIN_PX);
        expect(cp!.y).toBeGreaterThan(240); // top half
        expect(cp!.x).toBeLessThan(320); // left half
        const cb = proof.stats.centroidBeam;
        expect(cb).not.toBeNull();
        expect(cb!.x).toBeLessThan(320);
        expect(cb!.y).toBeLessThan(240); // lower half (CPU beam: GL y~180)

        // --- box 4d: occlusion (depth-off vs depth-on differs; gun wins) ---
        expect(proof.stats.depthOff.frac).toBeGreaterThanOrEqual(OCCLUSION_MIN_FRAC);
        console.log(`[gpu-browser] depthOff-vs-on: ${JSON.stringify(proof.stats.depthOff)}`);

        // --- box 4e: transparency (beam-on vs beam-off in the beam region) ---
        const beam = proof.stats.beam;
        expect(beam.bbox).not.toBeNull();
        expect(beam.bboxFrac).toBeGreaterThanOrEqual(BEAM_BBOX_MIN_FRAC);
        expect(beam.count).toBeGreaterThanOrEqual(BEAM_MIN_PX);
        console.log(`[gpu-browser] beam: ${JSON.stringify(beam)}`);

        // --- box 5: timings (REPORT-ONLY, never a pass/fail gate) ---
        const t = proof.timings;
        expect(t.frames).toBeGreaterThanOrEqual(TIMING_MIN_FRAMES);
        console.log(
          `[gpu-browser] TIMINGS (report-only, SwiftShader software GL): ` +
            `frames=${t.frames} min=${t.min.toFixed(2)}ms median=${t.median.toFixed(2)}ms ` +
            `p95=${t.p95.toFixed(2)}ms max=${t.max.toFixed(2)}ms mean=${t.mean.toFixed(2)}ms`,
        );
        expect(proof.framesSubmitted).toBeGreaterThanOrEqual(TIMING_MIN_FRAMES);
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
