// @q2/testkit — GPU-FOLLOW-3A real-pixel sky regressions (Node-only harness).
//
// Renders through the PRODUCTION WebGLRenderer + production shaders in real
// headless Chromium (SwiftShader WebGL2) and reads back actual pixels
// (test-only capture; production stays readback-free). This is the pixel
// evidence FOLLOW-3A box 1/2 require: stub draw counts cannot prove borders
// or window backgrounds.
//
// Gating: chromium binary must be present (else skip gracefully); the real
// base1 legs additionally require Q2_PAK (else they record a skip while the
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
import { buildSkyProbePageHtml } from './gpu-sky-pixels-page.js';
import { gpuBrowserLibPaths } from './gpu-browser-page.js';

const PAK_PATH = resolvePakPath();
const CHROMIUM_BIN = chromiumBinaryPath();

/**
 * Extract one map's six env/<sky>*.pcx faces into the served assets dir
 * (the shared extractPakAssets only covers the proof-route set + WALs).
 * Returns the sky key (base1: unit1_) or null when unavailable.
 */
function extractSkyAssets(pakPath: string, outDir: string): string | null {
  const pakBytes = readFileSync(pakPath) as unknown as Buffer;
  const dirOfs = pakBytes.readUInt32LE(4);
  const dirLen = pakBytes.readUInt32LE(8);
  const byName = new Map<string, { off: number; len: number }>();
  for (let o = dirOfs; o + 64 <= dirOfs + dirLen && o + 64 <= pakBytes.length; o += 64) {
    const name = pakBytes.subarray(o, o + 56).toString().replace(/\0.*$/, '').toLowerCase();
    if (name) byName.set(name, { off: pakBytes.readUInt32LE(o + 56), len: pakBytes.readUInt32LE(o + 60) });
  }
  // Sky key from base1 worldspawn (fixed retail value, verified by the
  // apps/web sky replay legs pinning unit1_).
  const sky = 'unit1_';
  for (const suf of ['rt', 'bk', 'lf', 'ft', 'up', 'dn']) {
    const e = byName.get(`env/${sky}${suf}.pcx`);
    if (!e) return null;
    const dest = join(outDir, 'env', `${sky}${suf}.pcx`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, pakBytes.subarray(e.off, e.off + e.len));
  }
  return sky;
}

interface SkyProof {
  done: boolean;
  error: string | null;
  webgl2: boolean;
  glVersion: string;
  glRenderer: string;
  synth: {
    edge: { bad: number; black: number; perFace: number[]; badIdx: number[]; centre: number };
    corner: { bad: number; black: number; perFace: number[]; badIdx: number[] };
    nearest: { bad: number; black: number; perFace: number[]; badIdx: number[] };
    tamper: { bad: number; want: number; match: boolean };
  };
  window: { bad: number; black: number; perFace: number[]; blackFrac: number; lastSky: { mode: string; refs: number } | null };
  windowCleared: { blackFrac: number; diffVsTextured: number; lastSky: { mode: string; refs: number } | null };
  real: {
    turned: { skyRefs: number; lastSky: { mode: string; refs: number } | null; diffVsCleared: number; diffNonBlack: number; replayDiff: number; fovX: number };
    windowBest: { id: number; skyRefs: number; diff: number; diffNonBlack: number; lastSky: { mode: string; refs: number } | null } | null;
    windowBestZero: { id: number; skyRefs: number; diff: number; diffNonBlack: number; lastSky: { mode: string; refs: number } | null } | null;
    windowTried: number;
  } | null;
  realError?: string;
}

describe.runIf(!CHROMIUM_BIN)('gpu sky pixels (skipped)', () => {
  it('logs the skip reason', () => {
    console.log(`[sky-pixels] SKIP: chromium absent (Q2_PAK=${PAK_PATH ?? 'absent'})`);
  });
});

describe.runIf(!!CHROMIUM_BIN)('gpu sky pixels (real WebGL2)', () => {
  it(
    'face edges isolate and zero-ref windows keep the textured background',
    { timeout: 240000 },
    async () => {
      const testDir = dirname(fileURLToPath(import.meta.url));
      const packagesDir = join(testDir, '..', '..');
      const scratch = makeProofScratchDir();
      mkdirSync(join(scratch, 'assets'), { recursive: true });
      if (PAK_PATH) {
        const n = extractPakAssets(PAK_PATH, join(scratch, 'assets'));
        const sky = extractSkyAssets(PAK_PATH, join(scratch, 'assets'));
        console.log(`[sky-pixels] extracted ${n} assets, sky=${sky ?? 'missing'}`);
      } else {
        console.log('[sky-pixels] no Q2_PAK: real-map legs will record a skip');
      }
      writeFileSync(join(scratch, 'page.html'), buildSkyProbePageHtml(gpuBrowserLibPaths('/lib')));
      mkdirSync(join(scratch, 'profile'), { recursive: true });

      let server: StaticServer | null = null;
      let chromium: ChromiumHandle | null = null;
      let cdp: CdpConnection | null = null;
      try {
        server = await serveProofTestDir(scratch, packagesDir);
        const pageUrl = `${server.url}/page.html`;
        console.log(`[sky-pixels] serving ${pageUrl} (chromium=${CHROMIUM_BIN})`);
        chromium = await launchChromium(pageUrl, join(scratch, 'profile'));
        cdp = await connectCdp(chromium.port);
        const proof = await waitForProofDone<SkyProof>(cdp, 200000);
        const consoleLines = cdp.consoleLines();
        console.log(`[sky-pixels] page console:\n${consoleLines.join('\n')}`);

        expect(proof.error).toBeNull();
        expect(proof.done).toBe(true);
        expect(proof.webgl2).toBe(true);
        console.log(`[sky-pixels] GL: ${proof.glVersion} | ${proof.glRenderer}`);

        // --- S1/S2/S3: every rendered pixel is exactly a face color ---
        expect(proof.synth.edge.bad).toBe(0);
        expect(proof.synth.edge.black).toBe(0);
        expect(proof.synth.corner.bad).toBe(0);
        expect(proof.synth.nearest.bad).toBe(0);
        // Orientation: yaw-45 sees rt(tile0) + bk(tile1) halves with thin
        // up/dn slivers at the frame top/bottom; lf(tile2)/ft(tile3) face
        // away. (Tile order is strip order [rt,bk,lf,ft,up,dn].)
        const pf = proof.synth.edge.perFace;
        expect(pf[0]).toBeGreaterThan(0.2 * 320 * 240);
        expect(pf[1]).toBeGreaterThan(0.2 * 320 * 240);
        expect(pf[2]).toBe(0);
        expect(pf[3]).toBe(0);
        expect(pf[4] + pf[5]).toBeLessThan(0.05 * 320 * 240);
        // Frame centre sits on the rt/bk edge: exactly one face wins.
        expect([0, 1]).toContain(proof.synth.edge.centre);

        // --- S4: the exactness predicate is live (flags 8 blended pixels) ---
        expect(proof.synth.tamper.bad).toBe(proof.synth.tamper.want);
        expect(proof.synth.tamper.match).toBe(true);

        // --- W1: zero selected sky refs still draw the textured background ---
        expect(proof.window.lastSky?.mode).toBe('textured-box');
        expect(proof.window.lastSky?.refs).toBe(0);
        expect(proof.window.bad).toBe(0);
        expect(proof.window.blackFrac).toBe(0);
        // Cleared control: the same view is clear-black (background came
        // from the strip, not from geometry or the clear color).
        expect(proof.windowCleared.blackFrac).toBeGreaterThanOrEqual(0.999);
        expect(proof.windowCleared.diffVsTextured).toBeGreaterThanOrEqual(0.999);

        // --- R1/R2: real base1 before/after (Q2_PAK only) ---
        if (!PAK_PATH) {
          console.log('[sky-pixels] real legs skipped (no Q2_PAK)');
        } else {
          expect(proof.real, `real legs must run with Q2_PAK (realError=${proof.realError ?? 'none'})`).not.toBeNull();
          const real = proof.real!;
          // Turned spawn view carries the 2 known sky refs; stripping and
          // re-registering the same strip replays byte-identical pixels
          // (pixel-stable cold-boot/switch/restore on real art).
          expect(real.turned.skyRefs).toBe(2);
          expect(real.turned.lastSky?.mode).toBe('textured-box');
          expect(real.turned.replayDiff).toBe(0);
          console.log(`[sky-pixels] R1 turned: ${JSON.stringify(real.turned)}`);
          // Window hunt: at least one near-spawn glass view must change
          // when the strip is stripped (textured, nonblack pixels — the
          // background box contributes through transparent surfaces), and
          // any zero-sky-ref changer is pinned explicitly.
          expect(real.windowTried).toBeGreaterThan(0);
          expect(real.windowBest).not.toBeNull();
          expect(real.windowBest!.diff).toBeGreaterThan(0.02);
          expect(real.windowBest!.diffNonBlack).toBeGreaterThan(0.01);
          console.log(`[sky-pixels] R2 best: ${JSON.stringify(real.windowBest)} tried=${real.windowTried}`);
          if (real.windowBestZero && real.windowBestZero.diff > 0.005) {
            expect(real.windowBestZero.diffNonBlack).toBeGreaterThan(0.0025);
            console.log(`[sky-pixels] R2 bestZero: ${JSON.stringify(real.windowBestZero)}`);
          } else {
            console.log(`[sky-pixels] R2 bestZero: none with diff (best=${JSON.stringify(real.windowBestZero)}); zero-ref mechanism covered by synthetic W1`);
          }
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
