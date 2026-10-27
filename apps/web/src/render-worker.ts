// q2ts-web render worker entry (M8.1 browser lane).
//
// Runs INSIDE a Web Worker (module). Receives its slice assignment once via
// postMessage, attaches the shared frame-accum views, then enters the SAME
// bandWorkerLoop the Node pool uses (single source of truth in
// @q2/sw-renderer/bands): Atomics.wait is legal in workers, so the wakeup
// side stays Atomics-only while completion flows back via postMessage (the
// main thread can never block). Spawned by BrowserBandPool
// (render-workers.ts); never imported by the main thread directly.
import {
  CTL_SEQ,
  attachFrameAccum,
  bandWorkerLoop,
} from '@q2/sw-renderer';

interface InitMsg {
  sab: SharedArrayBuffer;
  w: number;
  h: number;
  y0: number;
  y1: number;
  band: number;
  /**
   * V2d: optional frame VoodooState snapshot (see snapshotVoodooState in
   * render-workers.ts). Stashed as the band's latest frame state for the
   * future worker-side voodoo backend; the current bandWorkerLoop ignores
   * it (scanout stays global-serial on the main thread). Same snapshot
   * object is sent to every band — never per-pixel state reads.
   */
  voodoo?: unknown;
  /** V2d: lightweight per-frame state refresh (same contract as voodoo). */
  voodooState?: unknown;
}

const scope = self as unknown as {
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

/**
 * V2d: latest frame VoodooState snapshot stashed from init / `voodooState`
 * messages. Reserved for the future worker-side voodoo backend (same
 * snapshot object across all bands, absolute screen coords); the current
 * raster loop never reads it — scanout stays global-serial on the main
 * thread so filter taps cross band boundaries.
 */
let latestVoodoo: unknown = null;

/** Test/observability hook: the currently stashed frame state (null until set). */
export function latestVoodooState(): unknown {
  return latestVoodoo;
}

scope.onmessage = (ev: MessageEvent): void => {
  const init = ev.data as InitMsg;
  // V2d: a bare `{ voodooState }` message refreshes the stashed frame state
  // (init carries no `sab`); anything without `sab` is state-only.
  if (init.sab === undefined) {
    if (init.voodooState !== undefined) latestVoodoo = init.voodooState;
    else if (init.voodoo !== undefined) latestVoodoo = init.voodoo;
    return;
  }
  if (init.voodoo !== undefined) latestVoodoo = init.voodoo;
  const shared = attachFrameAccum(init.sab, init.w, init.h);
  bandWorkerLoop(
    shared.views,
    shared.ctl,
    init.y0,
    init.y1,
    init.band,
    init.w,
    (s: number): void => {
      try {
        Atomics.wait(shared.ctl, CTL_SEQ, s);
      } catch {
        /* dispatcher tore down; the loop exits on the next SEQ check */
      }
    },
    { postMessage: (msg: unknown): void => scope.postMessage(msg) },
  );
};
