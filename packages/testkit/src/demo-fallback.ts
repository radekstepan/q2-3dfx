// @q2/testkit — demo1-era fallback fixture (asset-free).
//
// Why there is no real demo1 here (BRAIN.md §3, asset legality): `demo1.dm2`
// is a recording of the retail `maps/base1` — playing it back needs the
// retail pak (`maps/base1.bsp`, WAL textures, MD2 models), and the pak may
// never be committed, cooked, or fetched by CI. So the no-pak fallback stays
// procedural: `maps/devroom` (the same room the demo page and the golden
// tests boot) doubles as the demo1-era stand-in. These fixed cameras give the
// demo page and the golden suite something deterministic to render WITHOUT
// assets; the real demo1/base1 path stays Q2_PAK-gated (see
// `base1-render.test.ts`).

import type { RefDef } from '@q2/renderer-api';
import type { Vec3 } from '@q2/math';
import { devroomView, devroomWorld } from '@q2/renderer-api';

/** Asset-free fallback map id (== the procedural devroom, BRAIN.md §8). */
export const DEMO_FALLBACK_MAP = 'maps/devroom';

/** Fixed demo-page cameras over the fallback map (name + RefDef). */
export function demoFallbackViews(): Array<{ name: string; view: RefDef }> {
  const mk = (
    name: string,
    origin: [number, number, number],
    angles: [number, number, number],
    time: number,
  ): { name: string; view: RefDef } => {
    const view = devroomView(time);
    view.origin = new Float32Array(origin) as Vec3;
    view.angles = new Float32Array(angles) as Vec3;
    return { name, view };
  };
  return [
    mk('demo-spawn', [0, 0, 48], [0, 0, 0], 0),
    mk('demo-pillar', [-168, 0, 32], [0, 0, 0], 1.5),
    mk('demo-wide', [120, -120, 96], [-10, 45, 0], 3.0),
  ];
}

/** World descriptor for the fallback map (re-exports the devroom world). */
export function demoFallbackWorld(): ReturnType<typeof devroomWorld> {
  return devroomWorld();
}
