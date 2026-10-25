// q2ts-web entry (M7.1+): real playable boot. Headless-safe: `bootWeb()`
// boots the procedural devroom (or base1 from pak bytes) to its first
// rendered frame through the real software renderer. In a browser the
// auto-boot below additionally wires canvas, drop zone, loop + HUD.
import { setCVarFromString } from '@q2/config';
import { bootToFirstFrame } from './devroom.js';
import { bootPlay } from './play.js';
import type { PlayBoot, RendererKind } from './play.js';
import { pakHasMaps } from './pak.js';
import type { WebPak } from './pak.js';
import { clearCachedPak, loadCachedPak, storeCachedPak } from './pak-cache.js';

export { bootToFirstFrame };
export type { RendererKind };
export { bootPlay };
export type { PlayBoot };
export { parsePakEntries, ingestPak, readPakEntry, pakHasMaps } from './pak.js';
export type { WebPak, WebPakEntry } from './pak.js';
export { clearCachedPak, loadCachedPak, storeCachedPak } from './pak-cache.js';
export { blitToCanvas, attachDropZone, renderCvarPanel, setProgress, startPlayLoop, formatFps, updateFpsOverlay, showFpsEnabled, cvarOptions, cvarControlKind, CVAR_OPTIONS } from './dom.js';
export type { PlayLoop } from './dom.js';
export { drawPlayHud, resolveDisplay, pumpMuzzleLight, pumpTracers, registerPakModels, loadConcharsFont, concharsFontFromPCX, fpsHudAnchor, getBrightness, applyBrightness, FPS_GREEN, BRIGHTNESS_DEFAULT, BRIGHTNESS_MIN, BRIGHTNESS_MAX, TRACER_TTL_FRAMES, BLASTER_TRACER_COLOR, PELLET_TRACER_COLOR } from './play.js';
export type { PakModelHandles, TracerBeam } from './play.js';

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
    // Cached-first boot: a previous drop persists in IndexedDB, so one
    // drop survives reloads. Empty/corrupt cache → devroom, no error spam.
    const bootFromCache = async (): Promise<void> => {
      dom.setProgress(progress, 0.2, 'loading cached pak0.pak…');
      try {
        const cached = await loadCachedPak();
        if (cached) {
          startWithPak(cached.pak, cached.name);
          return;
        }
      } catch {
        /* corrupt IDB → fall through to devroom */
      }
      startWithPak(null);
    };
    void bootFromCache();
    if (canvas) {
      dom.attachDropZone(document.body, (pak, name) => {
        // Persist the raw drop, then boot as today.
        void storeCachedPak(name, pak.data).catch(() => undefined);
        startWithPak(pak, name);
      });
    }
    if (cvars) dom.renderCvarPanel(cvars);
    // Minimal "clear cached pak" affordance next to the cvar panel.
    const ui = document.querySelector('#q2-ui');
    if (ui && !document.querySelector('#q2-clear-pak')) {
      const btn = document.createElement('button');
      btn.id = 'q2-clear-pak';
      btn.textContent = 'clear cached pak';
      btn.addEventListener('click', () => {
        void clearCachedPak().then(() => {
          dom.setProgress(progress, 1, 'cached pak cleared — drop pak0.pak for base1');
        });
      });
      ui.appendChild(btn);
    }
  });
}
