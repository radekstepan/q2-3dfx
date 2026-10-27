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
}

const scope = self as unknown as {
  postMessage(msg: unknown): void;
  onmessage: ((ev: MessageEvent) => void) | null;
};

scope.onmessage = (ev: MessageEvent): void => {
  const init = ev.data as InitMsg;
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
