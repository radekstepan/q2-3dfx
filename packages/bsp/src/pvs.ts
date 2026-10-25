// @q2/bsp — pvs.ts — leaf/cluster PVS decompression (CM_DecompressVis port).
//
// RLE scheme from qcommon/cmodel.c: literals are copied verbatim; a zero
// byte followed by count byte N emits N zero bytes. Output rows are
// (numclusters+7)>>3 bytes; overruns are clamped like the C code.
import { Com_Error } from '@q2/config';
import type { Bsp38 } from '@q2/formats';
import type { BspMap } from './bsp38.js';

function asFull(world: Bsp38): BspMap {
  const w = world as unknown as Partial<BspMap>;
  if (!w.visibility || !w.visBitofs || w.numClusters === undefined) {
    Com_Error('fatal', 'traceBox/pointLeaf/clusterPVS need a full BspMap from loadBsp (see M2.1 report)');
  }
  return world as unknown as BspMap;
}

export function asBspMap(world: Bsp38): BspMap {
  return asFull(world);
}

/** Decompress one visibility row. `src` is the raw visibility lump, `inOfs` the row offset. */
export function decompressVis(src: Uint8Array, inOfs: number, numClusters: number, out: Uint8Array): void {
  const row = (numClusters + 7) >> 3;
  if (out.length < row) Com_Error('fatal', 'decompressVis: output too small');
  if (inOfs === 0 || src.length === 0) {
    // No vis info (or cluster -1 convention): everything visible.
    out.fill(0xff, 0, row);
    return;
  }
  let ip = inOfs;
  let op = 0;
  do {
    if (ip >= src.length) Com_Error('fatal', 'decompressVis: truncated input');
    if (src[ip] !== 0) {
      out[op++] = src[ip++]!;
      continue;
    }
    if (ip + 1 >= src.length) Com_Error('fatal', 'decompressVis: truncated zero-run');
    let c = src[ip + 1]!;
    ip += 2;
    if (op + c > row) c = row - op; // clamp overrun, as the C code does
    while (c-- > 0) out[op++] = 0;
  } while (op < row);
}

/**
 * Potentially-visible set for a cluster (CM_ClusterPVS).
 * Returns a fresh Uint8Array of (numClusters+7)>>3 bytes; cluster < 0
 * (solid / no cluster) yields all zeros, matching the engine.
 */
export function clusterPVS(world: Bsp38, cluster: number): Uint8Array {
  const w = asFull(world);
  const row = (w.numClusters + 7) >> 3;
  const out = new Uint8Array(row);
  if (cluster < 0 || cluster >= w.numClusters) return out; // zeros, as in C
  decompressVis(w.visibility, w.visBitofs[cluster * 2]!, w.numClusters, out);
  return out;
}
