// @q2/testkit — DEMO1 determinism harness (asset-free).
//
// Scripted N-frame tick sequence over the fixed devroom cameras from
// `demo-fallback.ts`. Each camera advances at the 10 Hz server tick while
// light style 0 flickers, and every frame is hashed (color + index planes)
// with its origin and sim time recorded. Rerunning the sequence must
// reproduce every record exactly; the pinned hashes live in
// `demo-determinism.test.ts` (hashes only, never pixels/blobs).
//
// Engine path: `SoftwareRenderer` + `createDevroom()` (both stable
// `@q2/sw-renderer` exports, already used by `cache-flythrough.ts`).
// The NullRefresh demo-page path is deliberately NOT used here: it ignores
// `RefDef.time` and `lightStyles`, so a tick sequence over it could never
// prove sim-time advancement (see the gap note in
// `VOODOO_BASELINE_APPROXIMATIONS.md` §4).
//
// Light-style slot note: devroom's only style-1 lightmap sits on the
// turbulent water banner, which the span rasteriser draws unlit
// (fullbright warp), so styles[1] has no observable effect on any
// asset-free camera. The flicker below drives styles[0] instead — the slot
// every lit devroom surface consumes — which exercises the real
// style-scale → stylesHash → surface-cache-relight path. styles[1] is held
// at 1.0 and recorded, so a future devroom revision that lights the banner
// shows up as a pin mismatch, not silent drift.
//
// Real `demo1.dm2` playback still needs the retail pak (BRAIN.md §3) and
// stays Q2_PAK-gated in `base1-render.test.ts`; this file never touches
// Q2_PAK.

import { createFramebuffer } from '@q2/renderer-api';
import { SoftwareRenderer, createDevroom } from '@q2/sw-renderer';
import { DEMO_FALLBACK_MAP, demoFallbackViews } from './demo-fallback.js';
import { hashFrame } from './index.js';

/** Server tick rate the scripted sequence advances at (BRAIN.md §4). */
export const DEMO_TICK_HZ = 10;
/** Frames rendered per fixed camera. */
export const DEMO_TICKS_PER_CAMERA = 6;
/** Headless tick resolution (fast, still exercises real spans). */
export const DEMO_TICK_WIDTH = 160;
/** Headless tick resolution (fast, still exercises real spans). */
export const DEMO_TICK_HEIGHT = 120;

/** Style-0 flicker: even ticks full, odd ticks dimmed (exercises relight). */
export function demoTickStyle0(tick: number): number {
  return tick % 2 === 0 ? 1.0 : 0.75;
}

/** Deterministic warm-ramp palette (same fixture as the sw-renderer golden). */
export function demoTickPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

/** One rendered tick: hashed pixels plus the origin/time that produced them. */
export interface DemoTickFrame {
  camera: string;
  tick: number;
  /** Sim seconds: camera base time + tick / DEMO_TICK_HZ. */
  time: number;
  origin: [number, number, number];
  angles: [number, number, number];
  style0: number;
  style1: number;
  colorHash: string;
  indexHash: string;
}

/** JSON-serialisable manifest for a full sequence run (hashes only). */
export interface DemoTickManifest {
  tool: '@q2/testkit demo-determinism';
  map: string;
  resolution: { width: number; height: number };
  hz: number;
  ticksPerCamera: number;
  frames: DemoTickFrame[];
}

function fnvHex(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Render the full scripted sequence with one renderer + framebuffer (like a
 * real frame loop: the surface cache persists across ticks and style
 * changes). Fresh state per call, so two calls must agree exactly.
 */
export function runDemoTicks(
  ticksPerCamera: number = DEMO_TICKS_PER_CAMERA,
): DemoTickFrame[] {
  const views = demoFallbackViews();
  const fb = createFramebuffer(DEMO_TICK_WIDTH, DEMO_TICK_HEIGHT, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(demoTickPalette());
  const world = { name: DEMO_FALLBACK_MAP, data: createDevroom() };
  const frames: DemoTickFrame[] = [];
  for (const { name, view } of views) {
    for (let tick = 0; tick < ticksPerCamera; tick++) {
      const time = view.time + tick / DEMO_TICK_HZ;
      const style0 = demoTickStyle0(tick);
      const styles = new Float32Array(256).fill(1);
      styles[0] = style0;
      styles[1] = 1.0;
      r.beginFrame();
      r.renderView(
        { origin: view.origin, angles: view.angles, fovX: view.fovX, time, lightStyles: styles },
        world,
        [],
      );
      r.endFrame();
      frames.push({
        camera: name,
        tick,
        time,
        origin: [view.origin[0]!, view.origin[1]!, view.origin[2]!],
        angles: [view.angles[0]!, view.angles[1]!, view.angles[2]!],
        style0,
        style1: 1.0,
        colorHash: hashFrame(fb.color),
        indexHash: fnvHex(fb.index!),
      });
    }
  }
  return frames;
}

/** Wrap a sequence run in its JSON-serialisable manifest envelope. */
export function demoTickManifest(frames: DemoTickFrame[]): DemoTickManifest {
  return {
    tool: '@q2/testkit demo-determinism',
    map: DEMO_FALLBACK_MAP,
    resolution: { width: DEMO_TICK_WIDTH, height: DEMO_TICK_HEIGHT },
    hz: DEMO_TICK_HZ,
    ticksPerCamera: DEMO_TICKS_PER_CAMERA,
    frames,
  };
}
