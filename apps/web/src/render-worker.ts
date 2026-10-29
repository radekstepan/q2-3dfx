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
  attachRGBAccum,
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
   * V2d: optional per-frame VoodooState snapshot (see snapshotVoodooState /
   * broadcastVoodooState in render-workers.ts). Stashed as the band's
   * latest frame state for the future worker-side voodoo backend; the
   * current bandWorkerLoop ignores it (scanout stays global-serial on the
   * main thread). The shell posts the SAME snapshot values to every band
   * with absolute y0/y1/width/height — never per-pixel state reads.
   */
  voodoo?: unknown;
  /**
   * V2d: lightweight per-frame state refresh (same contract as voodoo):
   * `{ voodooState, y0, y1, width, height, band }` (see VoodooBandMessage).
   * Absolute screen coords so dither phase stays global across bands.
   */
  voodooState?: unknown;
  /** Absolute slice / full-frame dims travelling with a state refresh. */
  width?: unknown;
  height?: unknown;
}

const scope = self as unknown as {
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

/**
 * V2d: latest frame VoodooState snapshot stashed from init / `voodooState`
 * messages. Reserved for the future worker-side voodoo backend (same
 * snapshot values across all bands, absolute screen coords); the current
 * raster loop never reads it — scanout stays global-serial on the main
 * thread so filter taps cross band boundaries.
 *
 * Forward-compat note (browser lane, Goal A): this entry delegates every
 * kick to `bandWorkerLoop` unchanged. Unknown future JOB codes fall
 * through to that loop's ordered raster path (depth-guarded, band-local),
 * and its completion message already carries `{ seq, band, pixels, spans }`
 * — the main-thread pool attributes arrivals per band from those fields,
 * so a future foreground/RGB kick needs no entry change, only the
 * renderer-side staging protocol. Serial + worker-failure fallbacks live
 * in the pool (`BrowserBandPool`), never here: this file is transport.
 *
 * TODO(worker-rgb-backend): consume the envelope in `renderVoodooBand`
 * (worker entry, name assumed) / wasm `voodoo_raster_band` (name assumed)
 * once the backend lands; until then this stash is protocol groundwork
 * only and `selectVoodooBandPath` stays `serial`.
 */
let latestVoodoo: unknown = null;

/** V2d: absolute slice/dims travelling with the latest state refresh. */
let latestVoodooCoords: { y0: number; y1: number; width: number; height: number; band: number } | null = null;

/** Test/observability hook: the currently stashed frame state (null until set). */
export function latestVoodooState(): unknown {
  return latestVoodoo;
}

scope.onmessage = (ev: MessageEvent): void => {
  const init = ev.data as InitMsg;
  // V2d: a bare `{ voodooState, ...coords }` message refreshes the stashed
  // frame state (init carries `sab`; anything without `sab` is state-only).
  if (init.sab === undefined) {
    if (init.voodooState !== undefined) {
      latestVoodoo = init.voodooState;
      latestVoodooCoords = {
        y0: typeof init.y0 === 'number' ? init.y0 : 0,
        y1: typeof init.y1 === 'number' ? init.y1 : 0,
        width: typeof init.width === 'number' ? init.width : 0,
        height: typeof init.height === 'number' ? init.height : 0,
        band: typeof init.band === 'number' ? init.band : 0,
      };
    } else if (init.voodoo !== undefined) latestVoodoo = init.voodoo;
    return;
  }
  if (init.voodoo !== undefined) latestVoodoo = init.voodoo;
  const shared = attachFrameAccum(init.sab, init.w, init.h);
  const rgb = attachRGBAccum(init.sab, init.w, init.h);
  // PERF-NEXT-2 acknowledged-stop handshake: the pool quarantines with a
  // cooperative shutdown signal (CTL_SEQ < 0) before terminating. When the
  // loop observes it and returns, report the exit so the pool's bounded
  // completed-termination join can prove this worker is gone. The finally
  // covers abnormal loop exits too (a throwing loop still cannot write
  // after it stops). Stale exits (no quarantine armed) are ignored.
  const band = typeof init.band === 'number' ? init.band : -1;
  try {
    bandWorkerLoop(
      shared.views,
      rgb.views,
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
  } finally {
    try {
      scope.postMessage({ exited: true, band });
    } catch {
      /* dispatcher gone */
    }
  }
};
