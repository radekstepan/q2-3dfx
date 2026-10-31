// q2ts-web devroom boot: procedural room when no pak is present (M7.1).
//
// Uses only the integration layer (Host + NullRefresh): no engine internals
// that don't exist yet are imported. Feature flags in @q2/config gate the
// real backends when they land.
import { Host } from '@q2/host';
import { NullRefresh, devroomWorld } from '@q2/renderer-api';
import { hashFrame } from '@q2/testkit';

export type RendererKind = 'software' | 'webgl2-experimental';

export interface DevroomBoot {
  host: Host;
  renderer: RendererKind;
}

/** Create an offline host rendering the procedural devroom. */
export function createDevroomHost(width = 320, height = 240, renderer: RendererKind = 'software'): DevroomBoot {
  // Both backends resolve through the null head for v1; the switcher records
  // intent via cvar so the real renderers can take over behind the flag.
  void renderer;
  const refresh = new NullRefresh();
  const host = new Host({ refresh, width, height, indexed: true, world: devroomWorld() });
  return { host, renderer };
}

// --- demo1-era fallback map (asset-free) --------------------------------------
// Why the no-pak fallback is NOT demo1 itself (BRAIN.md §3, asset legality):
// `demo1.dm2` is a recording of the retail `maps/base1` — playing it back
// needs the retail pak (BSP, WALs, MD2s), and the pak may never be committed,
// cooked, or fetched by CI. So the fallback stays procedural: `maps/devroom`
// (the room the demo page + golden tests boot) doubles as the demo1-era
// stand-in. The real demo1/base1 path stays Q2_PAK-gated.

/** Asset-free fallback map id (== the procedural devroom, BRAIN.md §8). */
export const DEMO_FALLBACK_MAP = 'maps/devroom';

export interface DemoFallbackCamera {
  name: string;
  origin: [number, number, number];
  angles: [number, number, number];
  fovX: number;
}

/** Fixed demo-page cameras over the fallback map (mirrors @q2/testkit demoFallbackViews). */
export function demoFallbackCameras(): DemoFallbackCamera[] {
  return [
    { name: 'demo-spawn', origin: [0, 0, 48], angles: [0, 0, 0], fovX: 90 },
    { name: 'demo-pillar', origin: [-168, 0, 32], angles: [0, 0, 0], fovX: 90 },
    { name: 'demo-wide', origin: [120, -120, 96], angles: [-10, 45, 0], fovX: 90 },
  ];
}

/** Advance the host to its first rendered frame; returns stats + hash. */
export function bootToFirstFrame(host: Host, nowMs = 0): { pixels: number; hash: string; ms: number } {
  host.frame(nowMs);
  // Run enough 10Hz ticks to have two snapshots (interp needs a pair).
  host.frame(nowMs + 120);
  const stats = host.frame(nowMs + 220);
  return { pixels: stats.pixels, hash: hashFrame(host.fb.color), ms: stats.ms };
}
