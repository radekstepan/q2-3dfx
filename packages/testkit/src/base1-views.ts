// @q2/testkit — fixed base1 cameras for the PERF-1 attribution harness.
//
// Q2_PAK-gated scenes need the same fixed camera/time everywhere (bench,
// goldens, web gates): these four views match tools/bench BASE1_VIEWS
// exactly (same origins/angles/fov/time). Asset-free code — the pak bytes
// are loaded by the caller (bench loads base1.bsp + WALs + colormap).
// Known-good note: base1-render.test.ts renders these at 640x480 with real
// WAL texels and pins a <4.0 overdraw regression ceiling.

import type { RefDef } from '@q2/renderer-api';

export interface Base1View {
  label: string;
  origin: [number, number, number];
  angles: [number, number, number];
  /** Fixed simulation time (seconds) — light styles are a flat 1.0. */
  time: number;
  fovX: number;
}

/** Fixed base1 cameras (PERF-1 BEFORE baseline uses spawn-north + trench-east). */
export function base1Views(): Base1View[] {
  return [
    { origin: [128, -320, 54], angles: [0, 90, 0], label: 'spawn-north', time: 1.5, fovX: 90 },
    { origin: [128, -320, 54], angles: [0, 180, 0], label: 'spawn-west', time: 1.5, fovX: 90 },
    { origin: [-944, 1552, 0], angles: [0, 180, 0], label: 'lowroad-west', time: 1.5, fovX: 90 },
    { origin: [-1648, 1544, 16], angles: [0, 0, 0], label: 'trench-east', time: 1.5, fovX: 90 },
  ];
}

/** Build the fixed RefDef for a base1 view (flat lightStyles = 1.0). */
export function base1RefDef(v: Base1View): RefDef {
  return {
    origin: new Float32Array(v.origin),
    angles: new Float32Array(v.angles),
    fovX: v.fovX,
    time: v.time,
    lightStyles: new Float32Array(256).fill(1),
  };
}
