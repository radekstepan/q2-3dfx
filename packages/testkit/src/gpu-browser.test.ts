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
import {
  GPU_PROOF_HEIGHT,
  GPU_PROOF_TOLERANCES,
  GPU_PROOF_WIDTH,
  compareGpuProofFrames,
  formatGpuProofReport,
} from './gpu-proof.js';
import {
  abgrToRgb,
  buildDiffRgb,
  encodePpm,
  loadCpuProofWorld,
  packRgbaBytesToAbgr,
  renderCpuProofFrame,
  rgbaToRgb,
} from './gpu-proof-cpu.js';

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
  /** Covered-pixel denominator (masked fixtures only; full-frame otherwise). */
  covered?: number;
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
    coverageTurn: { covered: number; frac: number };
    drawsTurn: number;
    turnVsF0: ProofDiffSummary;
    reselectVsFresh: ProofDiffSummary;
    uploadsReselect: { before: number; after: number };
    /** FOLLOW-5 F2 moving-combat capture (proof-route yaw +6deg, own selection). */
    coverageF2: { covered: number; frac: number };
    drawsF2: number;
    f2vsF1: ProofDiffSummary;
    centroidGun: { x: number; y: number; n: number } | null;
    centroidBeam: { x: number; y: number; n: number } | null;
    centroidSoldier: { x: number; y: number; n: number } | null;
    centroidSprite: { x: number; y: number; n: number } | null;
  };
  warningsF1: string[];
  uploadsF1: { uploads: number };
  framesSubmitted: number;
  timings: { frames: number; min: number; median: number; p95: number; max: number; mean: number };
  /** PROOF-4 appearance fixtures (pinned profile + production pass). */
  appearance: {
    flatDistinctOn: number;
    flatDistinctOff: number;
    flatPeriodViolations: number;
    flatMembershipViolations: number;
    flatOnVsOff: ProofDiffSummary;
    flatCovered: number;
    rampDistinctR: number;
    rampDistinctG: number;
    rampDistinctB: number;
    rampTriplesOn: number;
    rampTriplesOff: number;
    rampMembershipViolations: number;
    rampGammaVsLinear: ProofDiffSummary;
    rampCovered: number;
    /** Fraction of the full canvas the appearance pass resolves (~1.0 when correct). */
    resolveCoverage: number;
    fogVsOff: ProofDiffSummary;
    fogOffIdentity: ProofDiffSummary;
    farVsNear: ProofDiffSummary;
    mipOnOff: ProofDiffSummary;
    f1PinnedVsF1: ProofDiffSummary;
    pinnedBeam: ProofDiffSummary;
    pinnedDepth: ProofDiffSummary;
    drawsFar: number;
  };
  mipChain: { levels: number; lastW: number; lastH: number; lastMean: [number, number, number] };
  /** FOLLOW-2B same-camera triage (diffuse-only / lightmap-only / final). */
  follow2b: {
    diffuse: { mean: number; nonblackFrac: number };
    light: { mean: number; nonblackFrac: number };
    final: { mean: number; nonblackFrac: number };
    diffuseVsFinal: ProofDiffSummary;
    lightVsFinal: ProofDiffSummary;
    farView: { mean: number; nonblackFrac: number };
    farViewVsNear: ProofDiffSummary;
    farViewMipOnOff: ProofDiffSummary;
    /** FOLLOW-5 mid-distance camera (the mip-gate regime): content + pair. */
    midView: { mean: number; nonblackFrac: number };
    midViewVsNear: ProofDiffSummary;
    midViewMipOnOff: ProofDiffSummary;
    mipFlagsMid: [boolean, boolean];
    f1MipOnOff: ProofDiffSummary;
    mipFlags: [boolean, boolean];
    mipFlagF1Off: boolean;
    atlas: { width: number; height: number; rects: number; skipped: number; shortFallback: number } | null;
    materials: { diffuseTextures: number; skinTextures: number; atlas: boolean; warnings: number };
    policyUploads: { on: number; off: number };
    glFirstErrors: { pre: number[]; postDraw: number[]; postRead: number[] } | null;
    warnings: string[];
    warningCount: number;
    uploadErrors: string[];
    preExistingGLErrors: string[];
    glErrorsPreFar: number[] | null;
    glErrorsPreTriage: number[];
    glErrorsPostTriage: number[];
    glErrorAfterCaptures: number;
  };
  /** FOLLOW-5 gun-skin-withheld negative control (top-level proof.negControl). */
  negControl?: {
    noGunSkinVsF1: ProofDiffSummary;
    warnings: string[];
    uploads: { uploads: number };
  };
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
        // Placement gates: each representative class must render where the
        // CPU reference puts it (contract §3: a GPU flip is a bug, not a
        // tolerance item — these fail closed on misplacement). Bands are
        // wide on purpose; the sprite band admits muzzle-flash envelope
        // variance run to run (full-frame centroid, top-center).
        //
        // NOTE (fixed 2026-10-29, was a production defect): the placement
        // gates below once FAILED because buildProjectionMatrix negated the
        // Y row (m[5] = -fy). Fixed in-tree (m[5] = +fy, pinned by
        // appearance.test.ts + the resolve-coverage fixture); the stale
        // void-era band fits were re-baselined to full-frame centroids.
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
        expect(cp!.x).toBeGreaterThan(200); // full-frame billboard centroid
        expect(cp!.x).toBeLessThan(440); // (flash envelope varies run to run)
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

        // --- FOLLOW-2: moving-camera visibility in the real browser ---
        // The 180-degree turn covers real geometry (not a void) and differs
        // from the spawn view (the camera actually moved). Re-selecting the
        // same renderer to the turn scene renders byte-identical to a fresh
        // turn renderer with no additional upload (the frozen spawn-subset
        // path fails reselectVsFresh: it repeats the spawn subset).
        expect(proof.stats.coverageTurn.frac).toBeGreaterThanOrEqual(COVER_MIN);
        expect(proof.stats.drawsTurn).toBeGreaterThan(0);
        expect(proof.stats.turnVsF0.frac).toBeGreaterThanOrEqual(F0F1_MIN_FRAC);
        expect(proof.stats.reselectVsFresh.count).toBe(0);
        expect(proof.stats.uploadsReselect.after).toBe(proof.stats.uploadsReselect.before);
        expect(proof.uploadsF1.uploads).toBe(1);
        console.log(
          `[gpu-browser] FOLLOW-2 turn: coverage=${proof.stats.coverageTurn.frac.toFixed(4)} ` +
            `turnVsF0=${proof.stats.turnVsF0.frac.toFixed(4)} ` +
            `reselectVsFresh=${proof.stats.reselectVsFresh.count} ` +
            `uploads=${proof.stats.uploadsReselect.before}->${proof.stats.uploadsReselect.after}`,
        );

        // --- FOLLOW-2B: same-camera triage + upload/atlas/material pins ---
        const f2b = proof.follow2b;
        expect(f2b, 'page must publish proof.follow2b (FOLLOW-2B triage)').toBeDefined();
        // Both diagnostic views render real content (not black): diffuse has
        // lit walls/skins without lighting, lightmap has baked blocks.
        expect(f2b.diffuse.nonblackFrac).toBeGreaterThan(0.05);
        expect(f2b.light.nonblackFrac).toBeGreaterThan(0.05);
        expect(f2b.final.nonblackFrac).toBeGreaterThan(0.05);
        // Views differ from final (lighting/fog apply) but share the frame.
        expect(f2b.diffuseVsFinal.count).toBeGreaterThan(0);
        expect(f2b.lightVsFinal.count).toBeGreaterThan(0);
        // Atlas + materials: real world blocks packed, real skins uploaded.
        expect(f2b.atlas).not.toBeNull();
        expect(f2b.atlas!.rects).toBeGreaterThan(100);
        expect(f2b.atlas!.width).toBe(1024);
        expect(f2b.materials.atlas).toBe(true);
        expect(f2b.materials.diffuseTextures).toBeGreaterThan(10);
        expect(f2b.materials.skinTextures).toBeGreaterThanOrEqual(2);
        // Real texImage2D failures must be zero; stale per-context flags
        // drained at uploads are reported separately (draw-side root cause
        // still open) and must not fail the upload gate by misattribution.
        expect(f2b.uploadErrors).toEqual([]);
        console.log(`[gpu-browser] FOLLOW-2B pre-existing GL flags: ${JSON.stringify(f2b.preExistingGLErrors)}`);
        console.log(`[gpu-browser] FOLLOW-2B GL flags: preFar=${JSON.stringify(f2b.glErrorsPreFar)} preTriage=${JSON.stringify(f2b.glErrorsPreTriage)} postTriage=${JSON.stringify(f2b.glErrorsPostTriage)}`);
        expect(f2b.glErrorsPostTriage).toEqual([]);
        console.log(
          `[gpu-browser] FOLLOW-2B far camera: nonblack=${f2b.farView.nonblackFrac.toFixed(3)} ` +
            `farVsNear=${f2b.farViewVsNear.frac.toFixed(4)} ` +
            `mipOnOff=${f2b.farViewMipOnOff.count} ` +
            `triage: diffuse=${f2b.diffuse.nonblackFrac.toFixed(3)} ` +
            `light=${f2b.light.nonblackFrac.toFixed(3)} final=${f2b.final.nonblackFrac.toFixed(3)} ` +
            `atlasRects=${f2b.atlas?.rects} skipped=${f2b.atlas?.skipped} short=${f2b.atlas?.shortFallback} ` +
            `diffuseTex=${f2b.materials.diffuseTextures} skins=${f2b.materials.skinTextures} ` +
            `warnings=${f2b.warningCount}`,
        );
        // The far camera must show real minified content that differs from
        // the near frame. mipFlags proves the cvar reached the frame state
        // at capture time and policyUploads proves both values reached GL
        // uploads in-page (distinguishes broken propagation from sampling
        // invariance: propagation is proven alive).
        expect(f2b.mipFlags).toEqual([true, false]);
        expect(f2b.mipFlagF1Off).toBe(false);
        expect(f2b.policyUploads.on).toBeGreaterThan(0);
        expect(f2b.policyUploads.off).toBeGreaterThan(0);
        // Dither pixel invariance is EXPECTED at these cameras, not a
        // regression, by construction: magnified taps clamp lod to 0 where
        // the Bayer pick always selects n (f=0, 0<=bayer); extreme
        // minification clamps to uMaxLevel (comp killed by the clamp); and
        // base1's flat walls converge per-tile once atlas bleed is removed.
        // The pre-fix far diffs measured bleed + unsettled first-submit, not
        // dither response. Report-only here; the shipped PROOF-4 far/mip
        // gates are left untouched (still reporting, never loosened).
        console.log(
          `[gpu-browser] FOLLOW-2B dither invariance (expected at these cameras): ` +
            `F1near=${f2b.f1MipOnOff.count} farView=${f2b.farViewMipOnOff.count} ` +
            `uploads=${JSON.stringify(f2b.policyUploads)}`,
        );
        console.log(`[gpu-browser] FOLLOW-2B first GL flag: ${JSON.stringify(f2b.glFirstErrors)}`);
        expect(f2b.farView.nonblackFrac).toBeGreaterThan(0.05);
        expect(f2b.farViewVsNear.frac).toBeGreaterThan(0.05);

        console.log(
          `[gpu-browser] FOLLOW-5 mid camera: nonblack=${f2b.midView.nonblackFrac.toFixed(3)} ` +
            `midVsNear=${f2b.midViewVsNear.frac.toFixed(4)} ` +
            `midMipOnOff=${f2b.midViewMipOnOff.count} mipFlagsMid=${JSON.stringify(f2b.mipFlagsMid)}`,
        );
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

// --- Predeclared PROOF-4 appearance bands (rationale inline; wide) ------------

// Flat field (constant gray 100 through production FS_APPEARANCE, gamma 1,
// postfilter off): same phase + same input MUST give the same output
// (exact determinism); every output channel is expand565 by construction
// (exact); dither-off collapses to one quantum (exact); dither-on must
// spread beyond one triple (min 2 — the covered 4-combo model yields 3 on
// SwiftShader; the exact split at the 96/104 quantum boundaries is float
// luck, so only the floor is pinned).
const FLAT_PERIOD_VIOL_MAX = 0;
const FLAT_MEMBERSHIP_VIOL_MAX = 0;
const FLAT_DISTINCT_OFF_EXACT = 1;
const FLAT_DISTINCT_ON_MIN = 2;
const FLAT_ONOFF_MIN_FRAC = 0.25;
// Full-range gray ramp (0..255, covered pixels only): truncate-quantize must
// hit nearly every 565 level. Exact-boundary columns read one quantum low
// (deterministic float round-trip, same input gives same output — an
// authorized linear-vs-exact approximation, not a defect).
const RAMP_R_MIN = 30;
const RAMP_G_MIN = 60;
const RAMP_B_MIN = 30;
const RAMP_MEMBERSHIP_VIOL_MAX = 0;
const RAMP_GAMMA_MIN_FRAC = 0.5;
// Resolve coverage (full-canvas flat field through the production pass):
// a correct fullscreen pass resolves ~1.0 over the whole canvas. Pinned at
// 0.99 — fails loudly on any void region (regression pin for the fixed
// VS_POST half-triangle defect).
const RESOLVE_COVERAGE_MIN = 0.99;
// Upload-time mip chain of a balanced 64x64 checker: 64→1 halving is 7
// levels ending at 1x1; box filtering averages black/white to mid gray
// (band [120,136] absorbs rounding, never fitted tight).
const CHAIN_LEVELS_EXACT = 7;
const CHAIN_MEAN_LO = 120;
const CHAIN_MEAN_HI = 136;
// FORCED fog at full amount over a depth-varying interior scene must move
// many pixels (band at 0.05); clearing the override must restore the exact
// pinned render (production null => 0 contribution — exact).
const FOG_MIN_FRAC = 0.05;
const FOG_OFF_IDENTITY_MAX = 0;
// Explicit cvar pin == config defaults (seam neutrality — exact).
const PIN_IDENTITY_MAX = 0;
// Pulled-back camera must change the frame substantially (band at 0.05).
const FAR_MIN_FRAC = 0.05;
// Mip-dither on-vs-off at the minified camera: the pick must change
// minified texels (>=200 px) and scatter across surfaces (bbox covers >=5%
// of the frame — a single hard band edge would stay thin and localized).
const MIP_ONOFF_MIN_PX = 200;
const MIP_SCATTER_MIN_FRAC = 0.05;

describe.runIf(GATE)('gpu-browser PROOF-4 appearance (boxes 3-4)', () => {
  it(
    'appearance fixtures hold; F1 pinned capture vs CPU reference (gate reports, never auto-passes)',
    { timeout: 600000 },
    async () => {
      // Soft asserts throughout: collect EVERY violation in one run
      // (evidence + artifacts are written before the report), then fail
      // loudly. The resolve-coverage pin MUST pass (fullscreen-triangle fix);
      // the F1-vs-CPU review gate is EXPECTED to fail on authorized
      // rasterization differences — it reports loudly with artifacts and the
      // acceptance stays explicitly pending below, never loosened.
      const soft = expect.soft;
      const pak = PAK_PATH as string;
      const testDir = dirname(fileURLToPath(import.meta.url));
      const packagesDir = join(testDir, '..', '..');
      const scratch = makeProofScratchDir();
      const assetsDir = join(scratch, 'assets');
      const extracted = extractPakAssets(pak, assetsDir);
      console.log(`[gpu-proof-4] extracted ${extracted.length} assets to ${assetsDir}`);
      writeFileSync(join(scratch, 'page.html'), buildProofPageHtml(gpuBrowserLibPaths('/lib')));
      mkdirSync(join(scratch, 'profile'), { recursive: true });

      let server: StaticServer | null = null;
      let chromium: ChromiumHandle | null = null;
      let cdp: CdpConnection | null = null;
      // Filled inside try, consumed after infra teardown.
      let gpuBytesBottomFirst: Uint8Array | null = null;
      let gpuF0BytesBottomFirst: Uint8Array | null = null;
      let gpuF2BytesBottomFirst: Uint8Array | null = null;
      let proofJson: ProofResult | null = null;
      let shot: Uint8Array | null = null;
      let mipScatter = 0;
      try {
        server = await serveProofTestDir(scratch, packagesDir);
        const pageUrl = `${server.url}/page.html`;
        console.log(`[gpu-proof-4] serving ${pageUrl} (chromium=${CHROMIUM_BIN})`);
        chromium = await launchChromium(pageUrl, join(scratch, 'profile'));
        cdp = await connectCdp(chromium.port);
        const proof = await waitForProofDone<ProofResult>(cdp, 480000);
        shot = await cdp.screenshot();
        const consoleLines = cdp.consoleLines();
        console.log(`[gpu-proof-4] page console tail:\n${consoleLines.slice(-8).join('\n')}`);
        expect(proof.error).toBeNull();
        expect(proof.done).toBe(true);
        expect(proof.webgl2).toBe(true);
        proofJson = proof;

        // --- page-side fixture presence (hard: nothing else is interpretable) ---
        expect(proof.appearance, 'page must publish proof.appearance (PROOF-4 fixtures)').toBeDefined();
        expect(proof.mipChain, 'page must publish proof.mipChain').toBeDefined();
        if (!proof.appearance || !proof.mipChain) throw new Error('[gpu-proof-4] page omitted appearance fixtures');
        const ap = proof.appearance;
        console.log(`[gpu-proof-4] appearance: ${JSON.stringify(ap)}`);
        console.log(`[gpu-proof-4] mipChain: ${JSON.stringify(proof.mipChain)}`);

        // Soft asserts from here on (soft is function-scoped above): collect
        // EVERY violation in one run, then fail loudly (see the tail of
        // this test). Fixture failures are honest signals, never loosened;
        // the F1-vs-CPU gate reports loudly with artifacts while the
        // acceptance stays explicitly pending (see the tail).

        // --- (a) dither phase + 565 quantization (covered pixels only) ---
        soft(ap.flatPeriodViolations).toBeLessThanOrEqual(FLAT_PERIOD_VIOL_MAX);
        soft(ap.flatMembershipViolations).toBeLessThanOrEqual(FLAT_MEMBERSHIP_VIOL_MAX);
        soft(ap.flatDistinctOff).toBe(FLAT_DISTINCT_OFF_EXACT);
        soft(ap.flatDistinctOn).toBeGreaterThanOrEqual(FLAT_DISTINCT_ON_MIN);
        soft(ap.flatOnVsOff.frac).toBeGreaterThanOrEqual(FLAT_ONOFF_MIN_FRAC);
        console.log(
          `[gpu-proof-4] flat: covered=${ap.flatCovered} distinctOn=${ap.flatDistinctOn} distinctOff=${ap.flatDistinctOff} ` +
            `periodViol=${ap.flatPeriodViolations} membershipViol=${ap.flatMembershipViolations} ` +
            `onVsOff=${ap.flatOnVsOff.frac.toFixed(4)}`,
        );
        soft(ap.rampDistinctR).toBeGreaterThanOrEqual(RAMP_R_MIN);
        soft(ap.rampDistinctG).toBeGreaterThanOrEqual(RAMP_G_MIN);
        soft(ap.rampDistinctB).toBeGreaterThanOrEqual(RAMP_B_MIN);
        soft(ap.rampMembershipViolations).toBeLessThanOrEqual(RAMP_MEMBERSHIP_VIOL_MAX);
        soft(ap.rampTriplesOn).toBeGreaterThan(ap.rampTriplesOff);
        soft(ap.rampGammaVsLinear.frac).toBeGreaterThanOrEqual(RAMP_GAMMA_MIN_FRAC);
        console.log(
          `[gpu-proof-4] ramp: covered=${ap.rampCovered} R=${ap.rampDistinctR} G=${ap.rampDistinctG} B=${ap.rampDistinctB} ` +
            `triplesOn=${ap.rampTriplesOn} triplesOff=${ap.rampTriplesOff} ` +
            `gammaFrac=${ap.rampGammaVsLinear.frac.toFixed(4)}`,
        );

        // --- resolve coverage: fullscreen-triangle regression pin ---
        console.log(`[gpu-proof-4] resolveCoverage=${ap.resolveCoverage.toFixed(4)} (need >=${RESOLVE_COVERAGE_MIN})`);
        soft(ap.resolveCoverage).toBeGreaterThanOrEqual(RESOLVE_COVERAGE_MIN);

        // --- (c) mip chain (asset-free) ---
        soft(proof.mipChain.levels).toBe(CHAIN_LEVELS_EXACT);
        soft(proof.mipChain.lastW).toBe(1);
        soft(proof.mipChain.lastH).toBe(1);
        for (const m of proof.mipChain.lastMean) {
          soft(m).toBeGreaterThanOrEqual(CHAIN_MEAN_LO);
          soft(m).toBeLessThanOrEqual(CHAIN_MEAN_HI);
        }
        console.log(
          `[gpu-proof-4] mipChain: levels=${proof.mipChain.levels} ` +
            `lastMean=[${proof.mipChain.lastMean.join(',')}] drawsFar=${ap.drawsFar}`,
        );

        // --- (b) FORCED fog ---
        soft(ap.fogVsOff.frac).toBeGreaterThanOrEqual(FOG_MIN_FRAC);
        soft(ap.fogOffIdentity.count).toBeLessThanOrEqual(FOG_OFF_IDENTITY_MAX);
        console.log(
          `[gpu-proof-4] fog: forcedVsOff=${ap.fogVsOff.frac.toFixed(4)} ` +
            `offIdentity=${ap.fogOffIdentity.count}`,
        );

        // --- (d) seam neutrality: explicit pin == defaults ---
        soft(ap.f1PinnedVsF1.count).toBeLessThanOrEqual(PIN_IDENTITY_MAX);
        console.log(`[gpu-proof-4] pinned-vs-unpinned F1 identity: ${ap.f1PinnedVsF1.count} px`);

        // --- (c) live mip contrast: far view + dither on/off ---
        soft(ap.farVsNear.frac).toBeGreaterThanOrEqual(FAR_MIN_FRAC);
        soft(ap.mipOnOff.count).toBeGreaterThanOrEqual(MIP_ONOFF_MIN_PX);
        const scatter = (ap.mipOnOff.bboxArea ?? 0) / (GPU_PROOF_WIDTH * GPU_PROOF_HEIGHT);
        mipScatter = scatter;
        soft(scatter).toBeGreaterThanOrEqual(MIP_SCATTER_MIN_FRAC);
        console.log(
          `[gpu-proof-4] far: farVsNear=${ap.farVsNear.frac.toFixed(4)} ` +
            `mipOnOff=${ap.mipOnOff.count} bboxArea=${ap.mipOnOff.bboxArea} scatter=${scatter.toFixed(4)}`,
        );

        // --- FOLLOW-5 mid-camera regime evidence (report-only pins around the
        // shipped mip gate): the mid pair must show real minified content
        // that differs from near, and the dither toggle must reach both the
        // frame state (mipFlagsMid) and GL uploads (policyUploads on/off —
        // distinguishes broken propagation from sampling invariance).
        expect(proofJson?.follow2b, 'page must publish proof.follow2b').toBeDefined();
        const f2b = proofJson!.follow2b;
        soft(f2b.midView.nonblackFrac).toBeGreaterThan(0.05);
        console.log(
          `[gpu-proof-4] mid: nonblack=${f2b.midView.nonblackFrac.toFixed(3)} ` +
            `midVsNear=${f2b.midViewVsNear.frac.toFixed(4)} ` +
            `midMipOnOff=${f2b.midViewMipOnOff.count} ` +
            `mipFlagsMid=${JSON.stringify(f2b.mipFlagsMid)}`,
        );
        expect(f2b.mipFlagsMid).toEqual([true, false]);

        // --- FOLLOW-5 negative control: gun skin withheld (REQUIRED asset
        // removed). Hard asserts, wide bands: the viewmodel must warn and
        // differ from pinned F1 exactly where the gun is (structural,
        // tone-independent — no threshold tuning involved).
        const neg = proofJson!.negControl;
        expect(neg, 'page must publish proof.negControl (FOLLOW-5 negative control)').toBeDefined();
        if (!neg) throw new Error('[gpu-proof-4] page omitted the negative control');
        const negWarn = neg.warnings.join('\n');
        console.log(`[gpu-proof-4] negControl: ${JSON.stringify(neg.noGunSkinVsF1)} warnings=${neg.warnings.length}`);
        expect(negWarn).toMatch(/skin 1 missing/);
        expect(neg.noGunSkinVsF1.count).toBeGreaterThanOrEqual(5000);
        {
          const gb = proofJson!.stats.gun.bbox;
          const nb = neg.noGunSkinVsF1.bbox;
          expect(gb).not.toBeNull();
          expect(nb).not.toBeNull();
          if (gb && nb) {
            const ix0 = Math.max(gb[0], nb[0]);
            const iy0 = Math.max(gb[1], nb[1]);
            const ix1 = Math.min(gb[2], nb[2]);
            const iy1 = Math.min(gb[3], nb[3]);
            const inter = Math.max(0, ix1 - ix0 + 1) * Math.max(0, iy1 - iy0 + 1);
            const nbArea = neg.noGunSkinVsF1.bboxArea ?? 1;
            console.log(`[gpu-proof-4] negControl: gun bbox=${JSON.stringify(gb)} noSkin bbox=${JSON.stringify(nb)} overlap=${(inter / nbArea).toFixed(3)}`);
            expect(inter / nbArea).toBeGreaterThanOrEqual(0.5);
          }
        }

        // --- transparent overlap + depth through the PINNED appearance pass ---
        soft(ap.pinnedBeam.bbox).not.toBeNull();
        soft(ap.pinnedBeam.bboxFrac).toBeGreaterThanOrEqual(BEAM_BBOX_MIN_FRAC);
        soft(ap.pinnedBeam.count).toBeGreaterThanOrEqual(BEAM_MIN_PX);
        soft(ap.pinnedDepth.frac).toBeGreaterThanOrEqual(OCCLUSION_MIN_FRAC);
        console.log(
          `[gpu-proof-4] pinned: beam=${JSON.stringify(ap.pinnedBeam)} ` +
            `depthOff=${JSON.stringify(ap.pinnedDepth)}`,
        );

        // --- chunked F1 pinned-capture fetch (CDP returnByValue per slice) ---
        // FOLLOW-5 determinism pin: fetch the same capture twice with
        // DIFFERENT chunkings — the bytes must be identical (pins the
        // harness slice path end to end, so matched before/after crops are
        // evidence, not transport luck).
        const total = await cdp.evaluate<number>(
          'window.__q2capF1 ? window.__q2capF1.length : -1',
          120000,
        );
        expect(total).toBe(GPU_PROOF_WIDTH * GPU_PROOF_HEIGHT * 4);
        const CHUNK = 122880;
        const raw = new Uint8Array(total);
        for (let off = 0; off < total; off += CHUNK) {
          const end = Math.min(total, off + CHUNK);
          const slice = await cdp.evaluate<number[]>(
            `window.__q2capSlice(${off}, ${end})`,
            120000,
          );
          expect(slice.length).toBe(end - off);
          raw.set(slice, off);
        }
        gpuBytesBottomFirst = raw;
        console.log(`[gpu-proof-4] fetched pinned F1 capture: ${raw.length} bytes`);
        const CHUNK2 = 61140;
        const raw2 = new Uint8Array(total);
        for (let off = 0; off < total; off += CHUNK2) {
          const end = Math.min(total, off + CHUNK2);
          const slice = await cdp.evaluate<number[]>(
            `window.__q2capSlice(${off}, ${end})`,
            120000,
          );
          expect(slice.length).toBe(end - off);
          raw2.set(slice, off);
        }
        expect(Array.from(raw2)).toEqual(Array.from(raw));
        console.log('[gpu-proof-4] dual-chunking fetch identical (harness slice path deterministic)');
        // FOLLOW-5 matched F0/F2 GPU captures through the same slice path.
        for (const which of [0, 2] as const) {
          const capName = which === 2 ? '__q2capF2' : '__q2capF0';
          const len = await cdp.evaluate<number>(
            `window.${capName} ? window.${capName}.length : -1`,
            120000,
          );
          expect(len).toBe(GPU_PROOF_WIDTH * GPU_PROOF_HEIGHT * 4);
          const buf = new Uint8Array(len);
          for (let off = 0; off < len; off += CHUNK) {
            const end = Math.min(len, off + CHUNK);
            const slice = await cdp.evaluate<number[]>(
              `window.__q2capSliceN(${which}, ${off}, ${end})`,
              120000,
            );
            expect(slice.length).toBe(end - off);
            buf.set(slice, off);
          }
          if (which === 0) gpuF0BytesBottomFirst = buf;
          else gpuF2BytesBottomFirst = buf;
          console.log(`[gpu-proof-4] fetched F${which} GPU capture: ${buf.length} bytes`);
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

      // --- (d) CPU reference render in-Node (serial, pinned, raw-color/software) ---
      // RELEASE-8: the oracle is the raw-color software plane (cpu.color),
      // not the retired CPU Voodoo resolve. Tolerances unchanged.
      const pakBytes = readFileSync(pak);
      const buf = new ArrayBuffer(pakBytes.length);
      new Uint8Array(buf).set(pakBytes);
      const bw = loadCpuProofWorld(buf);
      const cpu = await renderCpuProofFrame(bw, 1);
      console.log(
        `[gpu-proof-4] CPU F1: color=${cpu.colorHash} display=${cpu.displayHash}(${cpu.displayKind})`,
      );
      expect(cpu.displayKind).toBe('raw-color');
      // FOLLOW-5 matched F0/F2 CPU references (same scene/time/cvars rule
      // as F1: stationary F0 without particles/pump, moving F2 at yaw +6deg
      // with combat entities + pump). Report-only: full-frame + max-delta
      // against the matching GPU captures below (no new gates).
      const cpuF0 = await renderCpuProofFrame(bw, 0);
      const cpuF2 = await renderCpuProofFrame(bw, 2);
      console.log(
        `[gpu-proof-4] CPU F0: color=${cpuF0.colorHash} F2: color=${cpuF2.colorHash}`,
      );

      // Page readPixels rows are bottom-first (GL); CPU planes are
      // top-first: flip vertically before packing to 0xAABBGGRR.
      const W = GPU_PROOF_WIDTH, H = GPU_PROOF_HEIGHT;
      const src = gpuBytesBottomFirst as Uint8Array;
      const gpuTopFirst = new Uint8Array(src.length);
      for (let y = 0; y < H; y++) {
        gpuTopFirst.set(src.subarray(y * W * 4, (y + 1) * W * 4), (H - 1 - y) * W * 4);
      }
      const gpuPacked = packRgbaBytesToAbgr(gpuTopFirst);
      const diff = compareGpuProofFrames(gpuPacked, cpu.color, GPU_PROOF_TOLERANCES, W);
      const gateLine = formatGpuProofReport('f1-gpu-vs-cpu', diff, GPU_PROOF_TOLERANCES);
      console.log(`[gpu-proof-4] F1 GATE: ${gateLine} (gate fraction<=${GPU_PROOF_TOLERANCES.maxFractionDiff})`);

      // FOLLOW-5 matched F0/F2 report-only comparisons (no new gates: the
      // numbers extend the F1 evidence, never re-baseline it).
      function flipBottomFirst(srcBottomFirst: Uint8Array): Uint8Array {
        const out = new Uint8Array(srcBottomFirst.length);
        for (let y = 0; y < H; y++) {
          out.set(srcBottomFirst.subarray(y * W * 4, (y + 1) * W * 4), (H - 1 - y) * W * 4);
        }
        return out;
      }
      const gpuF0TopFirst = flipBottomFirst(gpuF0BytesBottomFirst as Uint8Array);
      const gpuF2TopFirst = flipBottomFirst(gpuF2BytesBottomFirst as Uint8Array);
      const diffF0 = compareGpuProofFrames(packRgbaBytesToAbgr(gpuF0TopFirst), cpuF0.color, GPU_PROOF_TOLERANCES, W);
      const diffF2 = compareGpuProofFrames(packRgbaBytesToAbgr(gpuF2TopFirst), cpuF2.color, GPU_PROOF_TOLERANCES, W);
      const gateLineF0 = formatGpuProofReport('f0-gpu-vs-cpu', diffF0, GPU_PROOF_TOLERANCES);
      const gateLineF2 = formatGpuProofReport('f2-gpu-vs-cpu', diffF2, GPU_PROOF_TOLERANCES);
      console.log(`[gpu-proof-4] F0 REPORT-ONLY: ${gateLineF0}`);
      console.log(`[gpu-proof-4] F2 REPORT-ONLY: ${gateLineF2}`);

      // --- region analysis for the side-by-side review ---
      // Full-frame coverage (the void split below is ~empty since the
      // fullscreen-triangle fix — kept to separate any future void pixels
      // from the fidelity signal): pixel centers in GL coords (y up from
      // the bottom row).
      const coveredGl = (x: number, yGl: number): boolean => {
        void x;
        void yGl;
        return true;
      };
      const lsb = GPU_PROOF_TOLERANCES.perChannelLsb;
      const edge = GPU_PROOF_TOLERANCES.edgeExcludePx;
      let gunDiff = 0, gunN = 0, darkDiff = 0, darkN = 0;
      let covDiff = 0, covN = 0, covMax = 0, voidDiff = 0, voidN = 0;
      const gb = proofJson?.stats.gun.bbox ?? null;
      for (let i = 0; i < W * H; i++) {
        const x = i % W, y = Math.floor(i / W); // top-first rows
        if (x < edge || y < edge || x >= W - edge || y >= H - edge) continue;
        const yGl = H - 1 - y;
        const o = i * 4;
        const gr = gpuTopFirst[o]!, gg = gpuTopFirst[o + 1]!, gbb = gpuTopFirst[o + 2]!;
        const c = cpu.color[i]!;
        const cr = c & 255, cg = (c >> 8) & 255, cb = (c >> 16) & 255;
        const isDiff =
          Math.abs(gr - cr) > lsb || Math.abs(gg - cg) > lsb || Math.abs(gbb - cb) > lsb;
        if (coveredGl(x, yGl)) {
          covN++;
          if (isDiff) covDiff++;
          const m = Math.max(Math.abs(gr - cr), Math.abs(gg - cg), Math.abs(gbb - cb));
          if (m > covMax) covMax = m;
        } else {
          voidN++;
          if (isDiff) voidDiff++;
        }
        const luma = (cr + cg + cb) / 3;
        if (luma < 32) {
          darkN++;
          if (isDiff) darkDiff++;
        }
        if (gb) {
          // gun bbox is GL coords (y=0 bottom): convert to top-first.
          if (x >= gb[0] && x <= gb[2] && yGl >= gb[1] && yGl <= gb[3]) {
            gunN++;
            if (isDiff) gunDiff++;
          }
        }
      }
      console.log(
        `[gpu-proof-4] regions: coveredDiff=${covN > 0 ? (covDiff / covN).toFixed(4) : 'n/a'} ` +
          `(${covDiff}/${covN} maxΔ${covMax}) voidDiff=${voidN > 0 ? (voidDiff / voidN).toFixed(4) : 'n/a'} ` +
          `(${voidDiff}/${voidN}) gunDiff=${gunN > 0 ? (gunDiff / gunN).toFixed(4) : 'n/a'} ` +
          `(${gunDiff}/${gunN} in gun bbox) darkDiff=${darkN > 0 ? (darkDiff / darkN).toFixed(4) : 'n/a'} ` +
          `(${darkDiff}/${darkN} dark CPU px)`,
      );

      // --- review artifacts (gitignored test-output/; paths logged) ---
      const outDir = join(testDir, '..', 'test-output');
      mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = join(outDir, `gpu-proof4-${stamp}`);
      writeFileSync(`${base}-gpu.rgba`, gpuTopFirst);
      writeFileSync(`${base}-cpu.rgba`, new Uint8Array(cpu.color.buffer, cpu.color.byteOffset, cpu.color.byteLength));
      writeFileSync(`${base}-gpu.ppm`, encodePpm(W, H, rgbaToRgb(gpuTopFirst)));
      writeFileSync(`${base}-cpu.ppm`, encodePpm(W, H, abgrToRgb(cpu.color)));
      writeFileSync(`${base}-diff.ppm`, encodePpm(W, H, buildDiffRgb(gpuTopFirst, cpu.color, W, H)));
      if (shot) writeFileSync(`${base}-browser.png`, shot);
      const verdict =
        'human sign-off: STILL NEEDED (pending) — differences below are documented ' +
        'approximations, never invented approval';
      const report = {
        stamp,
        pak,
        chromium: CHROMIUM_BIN,
        gate: 'GPU_PROOF_TOLERANCES (fraction<=0.02 @lsb<=3, 1px edge, maxDeltaWarn=24 — REVIEW GATES, never auto-pass)',
        bands: {
          FLAT_PERIOD_VIOL_MAX,
          FLAT_MEMBERSHIP_VIOL_MAX,
          FLAT_DISTINCT_OFF_EXACT,
          FLAT_DISTINCT_ON_MIN,
          FLAT_ONOFF_MIN_FRAC,
          RAMP_R_MIN,
          RAMP_G_MIN,
          RAMP_B_MIN,
          RAMP_MEMBERSHIP_VIOL_MAX,
          RAMP_GAMMA_MIN_FRAC,
          RESOLVE_COVERAGE_MIN,
          CHAIN_LEVELS_EXACT,
          CHAIN_MEAN_LO,
          CHAIN_MEAN_HI,
          FOG_MIN_FRAC,
          FOG_OFF_IDENTITY_MAX,
          PIN_IDENTITY_MAX,
          FAR_MIN_FRAC,
          MIP_ONOFF_MIN_PX,
          MIP_SCATTER_MIN_FRAC,
          BEAM_BBOX_MIN_FRAC,
          BEAM_MIN_PX,
          OCCLUSION_MIN_FRAC,
        },
        appearance: proofJson?.appearance ?? null,
        mipChain: proofJson?.mipChain ?? null,
        // FOLLOW-5 triage block (carries the mid-camera regime evidence:
        // midView content + midViewMipOnOff + mipFlagsMid + policyUploads).
        follow2b: proofJson?.follow2b ?? null,
        cpu: { colorHash: cpu.colorHash, displayHash: cpu.displayHash, display: cpu.displayKind },
        f1gate: {
          diff: diff.diff,
          compared: diff.compared,
          fraction: diff.fraction,
          maxAbsDelta: diff.maxAbsDelta,
          pass: diff.pass,
          edgeExcluded: diff.edgeExcluded,
          line: gateLine,
        },
        // FOLLOW-5 matched F0/F2 report-only rows (same oracle + tolerances
        // as F1; never gates, never re-baselined).
        f0report: {
          cpuColorHash: cpuF0.colorHash,
          gpuCoverage: proofJson?.stats.coverageF0 ?? null,
          diff: diffF0.diff,
          compared: diffF0.compared,
          fraction: diffF0.fraction,
          maxAbsDelta: diffF0.maxAbsDelta,
          line: gateLineF0,
        },
        f2report: {
          cpuColorHash: cpuF2.colorHash,
          gpuCoverage: proofJson?.stats.coverageF2 ?? null,
          gpuF2vsF1: proofJson?.stats.f2vsF1 ?? null,
          diff: diffF2.diff,
          compared: diffF2.compared,
          fraction: diffF2.fraction,
          maxAbsDelta: diffF2.maxAbsDelta,
          line: gateLineF2,
        },
        negControl: proofJson?.negControl ?? null,
        regions: {
          gunDiff, gunN, gunFrac: gunN > 0 ? gunDiff / gunN : null,
          darkDiff, darkN, darkFrac: darkN > 0 ? darkDiff / darkN : null,
          covDiff, covN, covFrac: covN > 0 ? covDiff / covN : null, covMaxDelta: covMax,
          voidDiff, voidN, voidFrac: voidN > 0 ? voidDiff / voidN : null,
        },
        productionDefectFixed: {
          id: 'VS_POST half-triangle (owns: @q2/webgl-renderer) — FIXED in-tree',
          evidence: [
            `resolveCoverage=${proofJson?.appearance.resolveCoverage} (need >=${RESOLVE_COVERAGE_MIN})`,
            'VS_POST now emits the covering triangle (-1,-1),(3,-1),(-1,3); ' +
              'appearance.test.ts pins the VertexID bit math + viewport coverage',
          ],
          impact:
            'resolved: every capture is full-frame; the covered-region fraction ' +
            'below is the true appearance-fidelity signal over the whole frame',
        },
        approvedAsDocumentedApproximations: [
          'linear-vs-exact rasterization edges (1px edge exclusion absorbs)',
          'true SRC_ALPHA blending vs CPU screen-door (beam/sprite/particles)',
          'per-pixel dlights vs CPU per-luxel surface-cache lighting',
          'single-level mip pick with dither vs CPU per-miplevel baked blocks; lightmaps unmipped',
          'unwarped water turbulence (deferred to EXPAND)',
          'no per-draw RGB565 rounding between translucent draws (linear target, resolve at scanout)',
          'GL pre-test depth vs CPU post-hoc banding helper',
          'GPU box-resampled oversize skins vs CPU dims-only helper',
        ],
        verdict,
      };
      writeFileSync(`${base}-gate.json`, JSON.stringify(report, null, 2));
      console.log(`[gpu-proof-4] artifacts: ${base}-gate.json ${base}-gpu.ppm ${base}-cpu.ppm ${base}-diff.ppm (+.rgba raws, -browser.png)`);
      console.log(
        '[gpu-proof-4] SIDE-BY-SIDE REVIEW (textured gun / geometry / transparency / dark areas / minification):\n' +
          `  textured gun: present bottom-right on GPU (centroid=${JSON.stringify(proofJson?.stats.centroidGun)} ` +
          `bbox=${JSON.stringify(proofJson?.stats.gun.bbox)} count=${proofJson?.stats.gun.count}); ` +
          `gun-bbox GPU-vs-CPU diff frac=${gunN > 0 ? (gunDiff / gunN).toFixed(4) : 'n/a'} — viewmodel depth-hack + alias lerp + skin resample all diverge from the CPU path here by design.\n` +
          `  geometry: F1 coverage GPU=${((proofJson?.stats.coverageF1.frac ?? 0) * 100).toFixed(1)}% vs ` +
          `CPU non-trivial (>15% cover, >20 texel varieties pinned in gpu-proof.test.ts); ` +
          `raster edges/depth ties differ — the 1px edge exclusion absorbs exactly this class.\n` +
          `  transparency: beam/sprite/particles ride TRUE blending on GPU vs screen-door on CPU ` +
          `(pinned beam bboxFrac=${(proofJson?.appearance.pinnedBeam.bboxFrac ?? 0).toFixed(4)}); ` +
          `per-draw quantum rounding between translucent draws is NOT reproduced (contract §4 chosen approximation).\n` +
          `  dark areas: dark-CPU-pixel diff frac=${darkN > 0 ? (darkDiff / darkN).toFixed(4) : 'n/a'} — ` +
          `gamma-1.3-after-reconstruction lifts near-black differently than per-luxel CPU shading; inspect -diff.ppm red clusters in shadows.\n` +
          `  minification: far-vs-near frac=${(proofJson?.appearance.farVsNear.frac ?? 0).toFixed(4)} ` +
          `(repaired: FAR_VIEW capture, was 0/0 degenerate), ` +
          `mip-dither count=${proofJson?.appearance.mipOnOff.count} scatter=${mipScatter.toFixed(4)} (MID_VIEW pair) — transition is dithered (no hard band); ` +
          `single-level pick vs CPU baked miplevel blocks remains an authorized approximation.\n` +
          `  matched route: F0 ${gateLineF0} | F2 ${gateLineF2} (report-only, same oracle/tolerances as F1) — ` +
          `GPU F2-vs-F1 frac=${(proofJson?.stats.f2vsF1.frac ?? -1).toFixed(4)} (camera +6deg must move the frame).\n` +
          `  negative control (gun skin withheld): diff=${proofJson?.negControl?.noGunSkinVsF1.count} px ` +
          `overlap-localized to the gun bbox, warning present — lifecycle image checks respond to a removed required asset.\n` +
          `  fixed (was a defect, not a tolerance item): resolveCoverage=${(proofJson?.appearance.resolveCoverage ?? -1).toFixed(4)} — ` +
          `VS_POST now emits the covering triangle (owns: @q2/webgl-renderer, fixed in-tree, pinned by appearance.test.ts); ` +
          `GPU-vs-CPU diff frac=${covN > 0 ? (covDiff / covN).toFixed(4) : 'n/a'} ` +
          `(${covDiff}/${covN} maxΔ${covMax}) is the appearance-fidelity signal.\n` +
          `  gate: ${gateLine} — ${diff.pass ? 'inside' : 'OUTSIDE'} the predeclared review gate. ` +
          'Differences WILL exceed the gate in places (different rasterization is AUTHORIZED). ' +
          `${verdict}.`,
      );

      // --- the honest signals: fixtures fail loudly; the gate reports loudly
      // while the acceptance stays explicitly pending (PROOF-4 box 4: never
      // auto-approve, never loosen thresholds to pass) ---
      soft(
        proofJson?.appearance.resolveCoverage ?? -1,
        '[gpu-proof-4] RESOLVE-COVERAGE FAIL: the appearance pass leaves canvas void ' +
          `(need >=${RESOLVE_COVERAGE_MIN}) — artifacts: ${base}-gate.json`,
      ).toBeGreaterThanOrEqual(RESOLVE_COVERAGE_MIN);
      console.log(
        `[gpu-proof-4] GATE (report-only, acceptance pending): ${gateLine} — artifacts: ${base}-gate.json ${base}-diff.ppm ` +
          '(review the side-by-side captures; do NOT loosen GPU_PROOF_TOLERANCES to pass)',
      );
      // Acceptance pin: the verdict MUST record pending human sign-off.
      // Fails closed if anyone marks the gate approved without the review.
      expect(verdict).toContain('STILL NEEDED');
    },
  );
});
