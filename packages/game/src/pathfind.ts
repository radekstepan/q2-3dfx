// @q2/game/pathfind — node-graph pathfinding stub: BFS over a supplied
// portal graph (m_move.c navigation is overkill for v1; the graph comes from
// the caller, e.g. cooked from a map's door/plat connectivity).

import type { Vec3 } from '@q2/math';

export type PortalGraph = Map<number, number[]>;

/** BFS shortest path (node ids) from start to goal, or null if unreachable. */
export function findPath(graph: PortalGraph, start: number, goal: number): number[] | null {
  if (start === goal) return [start];
  const prev = new Map<number, number>();
  const seen = new Set<number>([start]);
  const queue: number[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const neighbors = graph.get(cur) ?? [];
    for (const nb of neighbors) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      prev.set(nb, cur);
      if (nb === goal) {
        const path = [goal];
        let p = cur;
        while (p !== start) {
          path.unshift(p);
          p = prev.get(p)!;
        }
        path.unshift(start);
        return path;
      }
      queue.push(nb);
    }
  }
  return null;
}

/** Reachability check without building the path. */
export function isReachable(graph: PortalGraph, start: number, goal: number): boolean {
  return findPath(graph, start, goal) !== null;
}

/** Nearest nav node to a point (linear scan; graphs here are tiny). */
export function nearestNode(positions: Map<number, Vec3>, p: Vec3): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const [id, q] of positions) {
    const dx = q[0]! - p[0]!;
    const dy = q[1]! - p[1]!;
    const dz = q[2]! - p[2]!;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}
