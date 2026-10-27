// @q2/testkit — surface-cache flythrough ledger (BRAIN.md §11, M3.2).
//
// The surface cache (r_surf.c equivalent) must stay hot across frames:
// round 1 over a fixed camera path fills it (misses), round 2 over the same
// path must be ~100% hits. Devroom steady-state is pinned in sw-renderer;
// this helper runs the same measurement over real base1 cameras (Q2_PAK)
// so the §11 ledger carries a number from a real map, not just devroom.
import { SoftwareRenderer } from '@q2/sw-renderer';
import type { MiniWorld } from '@q2/sw-renderer';
import type { Vec3 } from '@q2/math';

export interface FlythroughView {
  origin: Vec3;
  angles: Vec3;
  label: string;
}

export interface FlythroughRound {
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

export interface FlythroughResult {
  views: number;
  rounds: FlythroughRound[];
}

/**
 * Render every view in order (round 1: cold cache), reset stats, render
 * them again (round 2: steady state). One renderer throughout, so the
 * cache persists across views like a real flythrough. No allocation
 * beyond the returned summary.
 */
export function runCacheFlythrough(
  renderer: SoftwareRenderer,
  world: MiniWorld,
  views: FlythroughView[],
  opts: { fovX?: number; time?: number; lightStyles?: Float32Array } = {},
): FlythroughResult {
  const styles = opts.lightStyles ?? new Float32Array(256).fill(1);
  const rounds: FlythroughRound[] = [];
  for (let round = 0; round < 2; round++) {
    renderer.testResetCacheStats();
    for (const v of views) {
      renderer.beginFrame();
      renderer.renderView(
        {
          origin: v.origin, angles: v.angles,
          fovX: opts.fovX ?? 90, time: opts.time ?? 1.5, lightStyles: styles,
        },
        { name: 'flythrough', data: world },
        [],
      );
    }
    const s = renderer.testCacheStats();
    rounds.push({ hits: s.hits, misses: s.misses, evictions: s.evictions, hitRate: s.hitRate });
  }
  return { views: views.length, rounds };
}
