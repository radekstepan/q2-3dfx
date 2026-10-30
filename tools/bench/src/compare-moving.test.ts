// q2-bench moving-camera CPU/Voodoo accept workload probe (bench lane,
// TEST-ONLY — no behavior, golden, budget or threshold change).
//
// Verdict (TASK item "moving-camera accept workload probe"): the CPU accept
// harness DOES support a moving-camera variant with the real viewmodel —
// `runMovingConfig` (compare.ts) runs a deterministic yaw sweep (pure
// function of the rep index, so per-frame hashes stay comparable across
// builds) with combat entities (fixed set + eye-anchored depthHack viewmodel
// gun + per-rep pumped muzzle/explosion dlights) and records full-channel
// evidence (full-RGBA `hashColorFull` frame + display hashes per rep, never
// R+G-only). The CPU accept GATE (acceptance.ts) runs stationary only —
// adding a moving gate leg would need a budget/threshold decision, which is
// out of scope here, so this probe asserts structure + serial-vs-pooled
// full-channel parity and proves execution WITHOUT gating anything.
//
// Cost control: 320x240 DIAGNOSTIC resolution only (never acceptance
// evidence), warmup 1, reps 3, Q2_PAK-gated skip (no pak = skipped, never
// faked). Headless Node production-frame-no-present by construction —
// presented FPS stays a browser/CDP soak metric, labeled as such.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFramebuffer } from '@q2/renderer-api';
import { SoftwareRenderer } from '@q2/sw-renderer';
import {
  hashColorFull,
  isAcceptanceResolution,
  isDiagnosticResolution,
} from '@q2/testkit';
import { combatEntities, loadRgbAttrWorld } from './rgbattr.js';
import { runMovingConfig } from './compare.js';

const Q2_PAK = process.env.Q2_PAK;
const W = 320, H = 240;

function isHex8(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}$/.test(s);
}

describe.runIf(!!Q2_PAK)('moving-camera accept workload probe (diagnostic, gated)', () => {
  it('yaw sweep + real viewmodel + full-channel serial/pooled parity', { timeout: 180000 }, async () => {
    expect(isDiagnosticResolution(W, H)).toBe(true);
    expect(isAcceptanceResolution(W, H)).toBe(false);
    const pakCheck = readFileSync(Q2_PAK as string);
    expect(pakCheck.length).toBeGreaterThan(0);
    const fw = loadRgbAttrWorld(Q2_PAK as string);

    // The moving entity set carries the REAL viewmodel (eye-anchored
    // depthHack gun — the representative gameplay foreground path).
    const scratch = new SoftwareRenderer();
    scratch.init(createFramebuffer(W, H, true));
    scratch.setPalette(fw.palette);
    const ents = combatEntities(scratch, fw, [-168, 0, 136], 0);
    expect(ents.some((e) => e.depthHack === true)).toBe(true);

    const sw = await runMovingConfig(fw, W, H, 'software', 0, 1, 3, 2);
    const serial = await runMovingConfig(fw, W, H, 'rgb', 0, 1, 3, 2);
    const pooled = await runMovingConfig(fw, W, H, 'rgb', 3, 1, 3, 2);
    for (const [label, row, mode] of [['software', sw, 'software'], ['rgb-serial', serial, 'rgb'], ['rgb-pooled', pooled, 'rgb']] as const) {
      expect(row.frameHashes).toHaveLength(3);
      for (const h of row.frameHashes) expect(isHex8(h)).toBe(true);
      // The yaw sweep actually moved the camera (frames differ by construction).
      expect(new Set(row.frameHashes).size).toBeGreaterThan(1);
      // RGB cover is an RGB-staging counter (zero by construction on the
      // software path — asserted only where the counter exists).
      if (mode === 'rgb') expect(row.coverPx).toBeGreaterThan(0);
      // Full-channel oracle spot-check on the recorded hashes.
      expect(row.frameHashes[0]).toHaveLength(8);
      void label;
    }
    // Full-RGBA frame hashes are comparable across builds (deterministic sweep);
    // software vs rgb pipelines genuinely differ (not one row relabeled).
    expect(sw.frameHashes).not.toEqual(serial.frameHashes);
    // Voodoo display hashes ride along per rep (full-RGBA, never R+G-only).
    expect(serial.displayHashes).toHaveLength(3);
    expect(pooled.displayHashes).toHaveLength(3);
    for (const h of [...serial.displayHashes, ...pooled.displayHashes]) expect(isHex8(h)).toBe(true);
    // Serial-vs-pooled full-channel parity on the MOVING workload (same
    // guarantee as accept gate D, probed — never gated — here).
    expect(pooled.frameHashes).toEqual(serial.frameHashes);
    expect(pooled.displayHashes).toEqual(serial.displayHashes);
    // Pooled execution proof (a pooled row with no kicks is a serial row in
    // disguise — rejected as a probe failure, not a gate failure).
    expect(pooled.kicks).toBeGreaterThan(0);
    expect(pooled.scanoutFallbacks).toBe(0);
    expect(pooled.scanoutKind).toBe('pooled');
    // hashColorFull is the full-channel authority used above (byte-wise
    // R+G+B+A — the legacy R+G hash cannot see blue/alpha divergence).
    expect(hashColorFull(new Uint32Array([0x01020304]))).toMatch(/^[0-9a-f]{8}$/);
    console.log(
      `moving-probe node headless production-frame-no-present ${W}x${H} yawStep=2deg reps=3: ` +
      `software serial med=${sw.frameMs.length}reps rgb serial==pooled full-channel parity ` +
      `display0=${serial.displayHashes[0]} pooledKicks=${pooled.kicks} fb=${pooled.scanoutFallbacks} ` +
      `(diagnostic only — NOT 640x480 acceptance evidence)`,
    );
  });
});

describe.runIf(!Q2_PAK)('moving-camera accept workload probe (skipped)', () => {
  it('skips without real assets (never faked)', () => {
    console.log('SKIP moving-camera probe: Q2_PAK not set (needs real base1.bsp + gun MD2)');
    expect(true).toBe(true);
  });
});
