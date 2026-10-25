// q2ts-devtools: map/BSP inspector, lightmap viewer, frame differ.
// Graceful stubs until @q2/bsp + @q2/formats backends land: every probe
// reports { ok: false } instead of throwing, so the page/CLI keeps working.
export interface ProbeResult<T> {
  ok: boolean;
  reason?: string;
  value?: T;
}

export function probeBsp(_buf: ArrayBuffer): ProbeResult<{ leafs: number }> {
  return { ok: false, reason: 'parseBSP38 not implemented yet (M2.1 owns it)' };
}

/** Byte-compare two frames; returns differing pixel count. */
export function diffFrames(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff;
}

/** Compact hex dump for lump inspection. */
export function hexDump(bytes: Uint8Array, max = 64): string {
  const n = Math.min(bytes.length, max);
  let out = '';
  for (let i = 0; i < n; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}
