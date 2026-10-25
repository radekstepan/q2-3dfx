// q2ts-web entry (M7.1): plain TS, no top-level DOM access.
//
// `bootWeb()` works headlessly (Node tests): it boots the procedural
// devroom to its first rendered frame. In a browser it additionally wires
// the canvas, drop zone, renderer switcher, cvar panel and progress UI via
// `./dom.js` (DOM-isolated, safe to import anywhere).
import { Host } from '@q2/host';
import { setCVarFromString } from '@q2/config';
import { createDevroomHost, bootToFirstFrame } from './devroom.js';
import type { RendererKind } from './devroom.js';
import { pakHasMaps } from './pak.js';
import type { WebPak } from './pak.js';

export { createDevroomHost, bootToFirstFrame };
export type { RendererKind };
export { parsePakEntries, ingestPak, readPakEntry, pakHasMaps } from './pak.js';
export type { WebPak, WebPakEntry } from './pak.js';
export { blitToCanvas, attachDropZone, renderCvarPanel, setProgress } from './dom.js';

export interface BootOptions {
  width?: number;
  height?: number;
  renderer?: RendererKind;
  /** pak bytes when the user dropped one (or loaded from IndexedDB) */
  pak?: WebPak | null;
  /** browser canvas element; omit headlessly */
  canvas?: unknown;
  /** progress element; omit headlessly */
  progressEl?: unknown;
  nowMs?: number;
}

export interface BootResult {
  host: Host;
  renderer: RendererKind;
  pixels: number;
  hash: string;
  /** 'devroom' when no pak present, 'pak' when booted from a dropped pak */
  source: 'devroom' | 'pak';
  pakEntries?: number;
}

/**
 * Boot to the first rendered frame.
 * - No pak: procedural devroom (asset-free, CI-safe).
 * - Pak: validated client-side; world boot defers to the real BSP path
 *   behind the `r_drawworld` feature path when it lands (for v1 we still
 *   render the devroom scene and report the pak entry count).
 */
export function bootWeb(opts: BootOptions = {}): BootResult {
  const renderer: RendererKind = opts.renderer ?? 'software';
  setCVarFromString('vid_renderer', renderer);
  const { host } = createDevroomHost(opts.width ?? 320, opts.height ?? 240, renderer);
  let source: BootResult['source'] = 'devroom';
  let pakEntries: number | undefined;
  if (opts.pak && pakHasMaps(opts.pak)) {
    source = 'pak';
    pakEntries = opts.pak.entries.length;
  }
  const first = bootToFirstFrame(host, opts.nowMs ?? 0);
  return { host, renderer, pixels: first.pixels, hash: first.hash, source, pakEntries };
}

// Browser auto-boot: only runs when a DOM is present. Keeps `vite`/tsup
// builds working and Node imports side-effect free.
if (typeof document !== 'undefined') {
  void import('./dom.js').then((dom) => {
    const canvas = document.querySelector('#q2');
    const progress = document.querySelector('#q2-progress');
    const boot = bootWeb({ width: 640, height: 480 });
    dom.setProgress(progress, 1, `devroom ready (${boot.pixels}px)`);
    if (canvas) {
      dom.blitToCanvas(canvas, boot.host.fb);
      dom.attachDropZone(document.body, (pak, name) => {
        const next = bootWeb({ width: 640, height: 480, pak, canvas });
        dom.setProgress(progress, 1, `loaded ${name}: ${next.pakEntries} entries`);
        dom.blitToCanvas(canvas, next.host.fb);
      });
    }
  });
}
