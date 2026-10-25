// q2ts-web entry (M7.1+): real playable boot. Headless-safe: `bootWeb()`
// boots the procedural devroom (or base1 from pak bytes) to its first
// rendered frame through the real software renderer. In a browser the
// auto-boot below additionally wires canvas, drop zone, loop + HUD.
/// <reference types="vite/client" />
import { setCVarFromString } from '@q2/config';
import { bootToFirstFrame } from './devroom.js';
import { bootPlay } from './play.js';
import type { PlayBoot, RendererKind } from './play.js';
import { ingestPak, pakHasMaps } from './pak.js';
import type { WebPak } from './pak.js';

export { bootToFirstFrame };
export type { RendererKind };
export { bootPlay };
export type { PlayBoot };
export { parsePakEntries, ingestPak, readPakEntry, pakHasMaps } from './pak.js';
export type { WebPak, WebPakEntry } from './pak.js';
export { blitToCanvas, attachDropZone, renderCvarPanel, setProgress, startPlayLoop, formatFps, updateFpsOverlay, showFpsEnabled } from './dom.js';
export type { PlayLoop } from './dom.js';
export { drawPlayHud, resolveDisplay, pumpMuzzleLight } from './play.js';

export interface BootOptions {
  width?: number;
  height?: number;
  renderer?: RendererKind;
  /** pak bytes when the user dropped one (or loaded from IndexedDB) */
  pak?: WebPak | null;
  nowMs?: number;
}

export interface BootResult {
  host: PlayBoot['host'];
  renderer: RendererKind;
  pixels: number;
  hash: string;
  /** 'devroom' when no pak present, 'pak' when booted from a dropped pak */
  source: 'devroom' | 'pak';
  pakEntries?: number;
  boot: PlayBoot;
}

/**
 * Boot to the first rendered frame.
 * - No pak: procedural devroom (asset-free, CI-safe).
 * - Pak with maps/base1.bsp: real BSP collision, WAL textures, PCX palette,
 *   doors/triggers/movers, shootable monster placeholders.
 */
export function bootWeb(opts: BootOptions = {}): BootResult {
  const renderer: RendererKind = opts.renderer ?? 'software';
  setCVarFromString('vid_renderer', renderer);
  const boot = bootPlay({
    width: opts.width ?? 320,
    height: opts.height ?? 240,
    renderer,
    pak: opts.pak ?? null,
  });
  const first = bootToFirstFrame(boot.host, opts.nowMs ?? 0);
  const pakEntries = opts.pak?.entries.length;
  return { host: boot.host, renderer, pixels: first.pixels, hash: first.hash, source: boot.source, pakEntries, boot };
}

/**
 * Production-only: fetch the pak0.pak the preview server links next to the
 * bundle (the q2-pak-link vite plugin symlinks $Q2_PAK there on `start`).
 * Returns null when absent, unreadable, or not a map pak — asset-less
 * deploys silently keep the devroom boot. Never called from dev (`vite`
 * serves no bundled pak) or from Node tests.
 */
async function fetchBundledPak(): Promise<WebPak | null> {
  try {
    const res = await fetch('pak0.pak');
    if (!res.ok) return null;
    const pak = ingestPak(await res.arrayBuffer());
    return pakHasMaps(pak) ? pak : null;
  } catch {
    return null;
  }
}

// Browser auto-boot: only runs when a DOM is present. Keeps
// builds working and Node imports side-effect free.
if (typeof document !== 'undefined') {
  void import('./dom.js').then((dom) => {
    const canvas = document.querySelector('#q2');
    const progress = document.querySelector('#q2-progress');
    const cvars = document.querySelector('#q2-cvars');
    let current: { stop(): void } | null = null;
    const startWithPak = (pak: WebPak | null, name?: string): void => {
      current?.stop();
      const boot = bootPlay({ width: 320, height: 240, pak });
      current = dom.startPlayLoop(canvas, boot, { pak });
      dom.setProgress(
        progress,
        1,
        name ? `loaded ${name}: ${pak?.entries.length} entries` : `devroom ready — drop pak0.pak for base1`,
      );
    };
    // Production preview boots straight into base1 when the linked pak is
    // present, with a silent devroom fallback. Dev (`vite`, PROD=false)
    // keeps the byte-for-byte historical boot: devroom + manual drop.
    if (import.meta.env.PROD) {
      if (canvas) {
        dom.attachDropZone(document.body, (pak, name) => startWithPak(pak, name));
      }
      if (cvars) dom.renderCvarPanel(cvars);
      dom.setProgress(progress, 0, 'loading pak0.pak…');
      void fetchBundledPak().then((bundled) => startWithPak(bundled, bundled ? 'pak0.pak' : undefined));
      return;
    }
    startWithPak(null);
    if (canvas) {
      dom.attachDropZone(document.body, (pak, name) => startWithPak(pak, name));
    }
    if (cvars) dom.renderCvarPanel(cvars);
  });
}
