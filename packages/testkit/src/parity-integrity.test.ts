// PERF-FINISH-C parity integrity (bench/testkit lane, asset-free).
//
// What this pins:
//   1. Parity hashes cover ALL RGBA bytes. The bench R+G harness hash is
//      blind to blue-only and alpha-only corruption (proven below) — gates
//      MUST use `hashColorFull` for serial-vs-pooled raster AND display.
//   2. Pooled execution is PROVEN (stage counters/kick records), not
//      inferred from pool existence: a pooled indexed frame must show
//      pooled == true with spans/pixels > 0; serial must show
//      active == pooled == false.
//   3. Fallback integrity: a disposed pool falls back to inline raster
//      (bit-identical full-RGBA) AND indexed-resolve kick failure is
//      reported (`resolveFrame` false) with no use-after-dispose: a second
//      frame still matches serial and nothing is left pending.
//   4. Pooled resolve is deterministic: two resolves of the same live frame
//      produce identical full-RGBA color planes (no torn completion).
//
// Serial references always run from source; worker threads boot from the
// BUILT bundle (dist-gated like the sw-renderer pooled tests — skipped
// with a log line when dist is missing, never failing).
//
// NOTE (RELEASE-8): the RGB composite retired with its scanout path; the
// resolve legs below use the indexed `resolveFrame` kick.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { createFramebuffer } from '@q2/renderer-api';
import { resetCVars, setCVar } from '@q2/config';
import {
  BandWorkerPool,
  SoftwareRenderer,
  SW_ACCUM_CVAR,
  SW_WORKERS_CVAR,
  createDevroom,
  DEVROOM_CAMERA,
} from '@q2/sw-renderer';
import { hashColorFull } from './index.js';

afterEach(() => {
  resetCVars();
});

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

/** Legacy bench scheme: R+G only (blind to blue-only + alpha-only). */
function legacyHashRG(color: Uint32Array): string {
  let h = 2166136261;
  for (let i = 0; i < color.length; i++) {
    h ^= color[i]! & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (color[i]! >>> 8) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

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

interface SerialFrame {
  colorFull: string;
  indexHash: string;
  pooled: boolean;
  active: boolean;
  cover: number;
}

function renderSerial(W: number, H: number): { frame: SerialFrame; blue: string; alpha: string } {
  resetCVars();
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  r.beginFrame();
  r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
  r.endFrame();
  const wst = r.testWorkerStats();
  expect(wst.active).toBe(false);
  expect(wst.pooled).toBe(false);
  const live = r.getFramebuffer();
  // Cover = depth-written pixels (the depth plane clears to 0).
  let cover = 0;
  for (let i = 0; i < live.depth!.length; i++) if (live.depth![i] !== 0) cover++;
  expect(cover).toBeGreaterThan(0);
  const color = new Uint32Array(live.color.buffer, live.color.byteOffset, live.color.byteLength / 4);
  return {
    frame: { colorFull: hashColorFull(color), indexHash: fnvU8(live.index!), pooled: wst.pooled, active: wst.active, cover },
    blue: fnvU8(extractChannel(color, 2)),
    alpha: fnvU8(extractChannel(color, 3)),
  };
}

/** One channel of a 0xAABBGGRR plane as raw bytes (proves blue/alpha travel). */
function extractChannel(color: Uint32Array, byte: 0 | 1 | 2 | 3): Uint8Array {
  const out = new Uint8Array(color.length);
  for (let i = 0; i < color.length; i++) out[i] = (color[i]! >>> (byte * 8)) & 0xff;
  return out;
}

/** Built ESM bundle for worker bootstrap, or null (skip, never fail). */
function distOrSkip(): string | null {
  const url = new URL('../../sw-renderer/dist/index.mjs', import.meta.url);
  if (!existsSync(url)) {
    console.log('SKIP pooled parity test: sw-renderer dist not built (run yarn build first)');
    return null;
  }
  return url.pathname;
}

describe('parity hash strength: full RGBA vs legacy R+G', () => {
  it('blue-only corruption is caught by hashColorFull and missed by the legacy R+G hash', () => {
    const serial = renderColor(64, 48);
    // Corrupt ONLY the blue byte of 64 pixels (R, G, A untouched).
    for (let i = 0; i < 64; i++) serial.color[i] = (serial.color[i]! ^ (0x1 << 16)) >>> 0;
    expect(hashColorFull(serial.color)).not.toBe(serial.full);
    // The legacy gate hash cannot see this corruption (the documented hole).
    expect(legacyHashRG(serial.color)).toBe(serial.legacy);
  });

  it('alpha-only corruption is caught by hashColorFull and missed by the legacy R+G hash', () => {
    const serial = renderColor(64, 48);
    for (let i = 0; i < 64; i++) serial.color[i] = (serial.color[i]! ^ (0x1 << 24)) >>> 0;
    expect(hashColorFull(serial.color)).not.toBe(serial.full);
    expect(legacyHashRG(serial.color)).toBe(serial.legacy);
  });

  it('hashColorFull is deterministic and hex-pinned in shape', () => {
    const { frame } = renderSerial(64, 48);
    expect(frame.colorFull).toMatch(/^[0-9a-f]{8}$/);
    const again = renderSerial(64, 48);
    expect(again.frame.colorFull).toBe(frame.colorFull);
  });
});

/** Render devroom indexed-serially; return the live color plane + its hashes. */
function renderColor(W: number, H: number): { color: Uint32Array; full: string; legacy: string } {
  resetCVars();
  const fb = createFramebuffer(W, H, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(testPalette());
  r.beginFrame();
  r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
  r.endFrame();
  const live = r.getFramebuffer();
  const color = new Uint32Array(live.color.buffer, live.color.byteOffset, live.color.byteLength / 4).slice();
  return { color, full: hashColorFull(color), legacy: legacyHashRG(color) };
}

describe('serial-vs-pooled raster parity with execution proof (devroom indexed)', () => {
  it('pooled raster is full-RGBA identical to serial, with proven worker execution', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 160, H = 120;
    const serial = renderSerial(W, H);
    expect(serial.frame.pooled).toBe(false);
    expect(serial.frame.cover).toBeGreaterThan(0);

    resetCVars();
    setCVar(SW_WORKERS_CVAR, 2);
    setCVar(SW_ACCUM_CVAR, 1);
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    const pool = BandWorkerPool.create(1, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed');
    try {
      r.attachWorkerPool(pool);
      r.beginFrame();
      r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
      r.endFrame();
      // EXECUTION PROOF (not pool existence): bands drew spans/pixels.
      const wst = r.testWorkerStats();
      expect(wst.active).toBe(true);
      expect(wst.pooled).toBe(true);
      expect(wst.spans).toBeGreaterThan(0);
      expect(wst.pixels).toBeGreaterThan(0);
      const live = r.getFramebuffer();
      const color = new Uint32Array(live.color.buffer, live.color.byteOffset, live.color.byteLength / 4);
      expect(hashColorFull(color)).toBe(serial.frame.colorFull);
      expect(fnvU8(live.index!)).toBe(serial.frame.indexHash);
      // Blue and alpha channels specifically travel identically.
      expect(fnvU8(extractChannel(color, 2))).toBe(serial.blue);
      expect(fnvU8(extractChannel(color, 3))).toBe(serial.alpha);
    } finally {
      await pool.dispose();
    }
  });
});

describe('fallback integrity: raster AND resolve failure', () => {
  it('disposed pool falls back to identical inline raster; resolve kick reports failure; second frame still clean', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 160, H = 120;
    const serial = renderSerial(W, H);

    resetCVars();
    setCVar(SW_WORKERS_CVAR, 2);
    setCVar(SW_ACCUM_CVAR, 1);
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    const pool = BandWorkerPool.create(1, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed');
    r.attachWorkerPool(pool);
    await pool.dispose();

    // RASTER failure path: everything runs inline, output identical.
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
    r.endFrame();
    const wst = r.testWorkerStats();
    expect(wst.active).toBe(true);
    const live = r.getFramebuffer();
    const color = new Uint32Array(live.color.buffer, live.color.byteOffset, live.color.byteLength / 4);
    expect(hashColorFull(color)).toBe(serial.frame.colorFull);
    expect(fnvU8(live.index!)).toBe(serial.frame.indexHash);

    // RESOLVE failure path: kick on a dead pool reports false (caller runs
    // serial). Ownership: nothing left pending, no throw, no torn state.
    expect(pool.accumPending()).toBe(0);
    expect(pool.resolveFrame()).toBe(false);
    expect(pool.accumPending()).toBe(0);

    // Second frame after disposal: still serial-identical (no
    // use-after-dispose, no accumulated corruption).
    r.beginFrame();
    r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
    r.endFrame();
    const live2 = r.getFramebuffer();
    const color2 = new Uint32Array(live2.color.buffer, live2.color.byteOffset, live2.color.byteLength / 4);
    expect(hashColorFull(color2)).toBe(serial.frame.colorFull);
    expect(fnvU8(live2.index!)).toBe(serial.frame.indexHash);
    expect(pool.accumPending()).toBe(0);
  });

  it('live pooled resolve is deterministic (no torn completion)', { timeout: 120000 }, async () => {
    const dist = distOrSkip();
    if (!dist) return;
    const W = 160, H = 120;
    resetCVars();
    setCVar(SW_WORKERS_CVAR, 2);
    setCVar(SW_ACCUM_CVAR, 1);
    const fb = createFramebuffer(W, H, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    if (!r.syncWorkersFromCvar()) throw new Error('banded enable failed');
    const pool = BandWorkerPool.create(1, W, H, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed');
    try {
      r.attachWorkerPool(pool);
      r.beginFrame();
      r.renderView(devView(), { name: 'devroom', data: createDevroom() }, []);
      r.endFrame();
      // Resolve the SAME live frame again: identical color plane.
      expect(pool.resolveFrame()).toBe(true);
      const first = hashColorFull(new Uint32Array(
        r.getFramebuffer().color.buffer,
        r.getFramebuffer().color.byteOffset,
        r.getFramebuffer().color.byteLength / 4,
      ).slice(0, W * H));
      expect(pool.resolveFrame()).toBe(true);
      const second = hashColorFull(new Uint32Array(
        r.getFramebuffer().color.buffer,
        r.getFramebuffer().color.byteOffset,
        r.getFramebuffer().color.byteLength / 4,
      ).slice(0, W * H));
      expect(second).toBe(first);
    } finally {
      await pool.dispose();
    }
  });
});
