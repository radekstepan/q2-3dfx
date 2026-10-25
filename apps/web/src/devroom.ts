// q2ts-web devroom boot: procedural room when no pak is present (M7.1).
//
// Uses only the integration layer (Host + NullRefresh): no engine internals
// that don't exist yet are imported. Feature flags in @q2/config gate the
// real backends when they land.
import { Host } from '@q2/host';
import { NullRefresh, devroomWorld } from '@q2/renderer-api';
import { hashFrame } from '@q2/testkit';

export type RendererKind = 'software' | 'voodoo';

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

/** Advance the host to its first rendered frame; returns stats + hash. */
export function bootToFirstFrame(host: Host, nowMs = 0): { pixels: number; hash: string; ms: number } {
  host.frame(nowMs);
  // Run enough 10Hz ticks to have two snapshots (interp needs a pair).
  host.frame(nowMs + 120);
  const stats = host.frame(nowMs + 220);
  return { pixels: stats.pixels, hash: hashFrame(host.fb.color), ms: stats.ms };
}
