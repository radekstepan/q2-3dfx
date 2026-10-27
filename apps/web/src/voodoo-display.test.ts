// q2ts-web voodoo display freshness (astra §2 defect #1 + §6 fixtures).
//
// Pre-fix `resolveFrame` only fills `display` when `vd_postfilter` is on, so
// `resolveDisplay` returned last frame's pixels with the filter off (stale).
// These tests paint solid frames straight into the live renderer color plane
// and assert every `vd_16bit`/`vd_dither`/`vd_postfilter` combination shows
// the CURRENT frame — robust to both the old behaviour (web-side backfill)
// and the fixed voodoo `resolveFrame` (canary no-op).

import { describe, expect, it, afterEach } from 'vitest';
import { getCVarNumber, setCVar } from '@q2/config';
import { bootPlay, resolveDisplay, type PlayBoot } from './play.js';

const W = 32;
const H = 24;
const N = W * H;
// 0xAABBGGRR solid frames.
const RED = 0xff0000ff;
const GREEN = 0xff00ff00;

function paintLive(boot: PlayBoot, px: number): void {
  boot.refresh.getFramebuffer().color.fill(px);
}

function meanChannels(buf: Uint32Array): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    const px = buf[i]!;
    r += px & 255;
    g += (px >> 8) & 255;
    b += (px >> 16) & 255;
  }
  return { r: r / buf.length, g: g / buf.length, b: b / buf.length };
}

// Cvar sandbox: every test leaves the global registry as it found it.
const SAVED = new Map<string, number | string | boolean>();
function saveCvar(name: string): void {
  if (!SAVED.has(name)) {
    try {
      SAVED.set(name, getCVarNumber(name));
    } catch {
      /* absent cvar: nothing to restore */
    }
  }
}
function voodooSandbox(): void {
  for (const name of ['vid_renderer', 'r_brightness', 'vd_postfilter', 'vd_16bit', 'vd_dither', 'vd_gamma']) {
    saveCvar(name);
  }
  setCVar('vid_renderer', 'voodoo');
  setCVar('r_brightness', 1.0);
}
afterEach(() => {
  for (const [name, value] of SAVED) setCVar(name, value);
});

describe('voodoo display freshness (postfilter-off stale guard)', () => {
  it('postfilter 1->0->1 with changing solid frames shows no stale pixels', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    expect(boot.display.length).toBe(N);

    paintLive(boot, RED);
    setCVar('vd_postfilter', 1);
    let out = resolveDisplay(boot);
    let m = meanChannels(out);
    expect(m.r).toBeGreaterThan(200);
    expect(m.g).toBeLessThan(24);
    expect(m.b).toBeLessThan(24);

    // Filter off + new (green) frame: must be green, not stale red.
    paintLive(boot, GREEN);
    setCVar('vd_postfilter', 0);
    out = resolveDisplay(boot);
    m = meanChannels(out);
    expect(m.g).toBeGreaterThan(200);
    expect(m.r).toBeLessThan(24);
    expect(m.b).toBeLessThan(24);

    // Filter back on + red frame: red again, no green ghost.
    paintLive(boot, RED);
    setCVar('vd_postfilter', 1);
    out = resolveDisplay(boot);
    m = meanChannels(out);
    expect(m.r).toBeGreaterThan(200);
    expect(m.g).toBeLessThan(24);
    expect(m.b).toBeLessThan(24);
  });

  it('every vd_16bit/vd_dither/vd_postfilter combination tracks the current frame', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    let frame: number = RED;
    for (const bit16 of [1, 0]) {
      for (const dither of [1, 0]) {
        for (const post of [1, 0]) {
          setCVar('vd_16bit', bit16);
          setCVar('vd_dither', dither);
          setCVar('vd_postfilter', post);
          // Alternate the painted frame so a stale buffer always fails.
          frame = frame === RED ? GREEN : RED;
          paintLive(boot, frame);
          const out = resolveDisplay(boot);
          expect(out.length).toBe(N);
          const m = meanChannels(out);
          if (frame === RED) {
            expect(m.r).toBeGreaterThan(200);
            expect(m.g).toBeLessThan(24);
            expect(m.b).toBeLessThan(24);
          } else {
            expect(m.g).toBeGreaterThan(200);
            expect(m.r).toBeLessThan(24);
            expect(m.b).toBeLessThan(24);
          }
          // Opaque alpha in every combination (0xAABBGGRR display plane).
          for (let i = 0; i < out.length; i++) {
            expect(out[i]! >>> 24).toBe(0xff);
          }
        }
      }
    }
  });

  it('vd_16bit off preserves sub-565 values; on collapses them (true bypass)', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    // Low channels gamma-lifted but still sub-565 at gamma 1.0; dither off
    // so the quantise leg is deterministic. r=4/g=3/b=2 all truncate to 0
    // in 5:6:5 yet survive an RGB888 copy.
    setCVar('vd_gamma', 1.0);
    setCVar('vd_dither', 0);
    setCVar('vd_postfilter', 0);
    paintLive(boot, 0xff020304);

    setCVar('vd_16bit', 1);
    let out = resolveDisplay(boot);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]! & 255).toBe(0);
      expect((out[i]! >> 8) & 255).toBe(0);
      expect((out[i]! >> 16) & 255).toBe(0);
    }

    setCVar('vd_16bit', 0);
    out = resolveDisplay(boot);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]!).toBe(0xff020304);
    }
  });

  it('brightness lift still applies in voodoo mode without touching the engine buffer', () => {
    voodooSandbox();
    const boot = bootPlay({ width: W, height: H });
    setCVar('vd_gamma', 1.0);
    setCVar('vd_dither', 0);
    setCVar('vd_postfilter', 0);
    setCVar('vd_16bit', 0);
    paintLive(boot, 0xff404040);
    const live = boot.refresh.getFramebuffer().color;

    setCVar('r_brightness', 1.0);
    const plain = resolveDisplay(boot).slice();
    expect(meanChannels(plain).r).toBe(0x40);

    setCVar('r_brightness', 2.0);
    const lifted = resolveDisplay(boot);
    // 0x40 * 2 = 0x80 per channel.
    for (let i = 0; i < lifted.length; i++) {
      expect(lifted[i]!).toBe(0xff808080);
    }
    expect(meanChannels(lifted).r).toBeGreaterThan(meanChannels(plain).r);
    // Engine buffer never mutated by the lift.
    for (let i = 0; i < live.length; i++) {
      expect(live[i]).toBe(0xff404040);
    }
  });
});
