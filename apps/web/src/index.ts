// q2ts-web entry (M7.1+): real playable boot. Headless-safe: `bootWeb()`
// boots the procedural devroom (or base1 from pak bytes) to its first
// rendered frame through the real software renderer. In a browser the
// auto-boot below additionally wires canvas, drop zone, loop + HUD.
import { setCVarFromString } from '@q2/config';
import { bootToFirstFrame } from './devroom.js';
import { applyRendererCvar, bootPlay, getMapSource } from './play.js';
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
export { clearCachedPak, loadCachedPak, storeCachedPak } from './pak-cache.js';export { blitToCanvas, blitCopyRGBA, blitIsLittleEndian, attachDropZone, renderCvarPanel, setProgress, startPlayLoop, showFpsEnabled, showPosEnabled, cvarIsCheckbox, CHECKBOX_CVARS, cvarOptions, cvarControlKind, cvarOptionLabels, cvarDescription, CVAR_DESCRIPTIONS, skillLabel, skillValueForLabel, SKILL_LABELS, RESOLUTION_LABELS, MAP_SOURCE_LABELS, setMapSourceHasPak, getMapSourceHasPak, REBOOT_CVARS, cvarNeedsReboot, CVAR_OPTIONS, pushConsoleLog, clearConsoleLog, resetConsoleLog, getConsoleLines, renderConsoleLines, attachConsoleClear, setModeReadout, MAX_CONSOLE_LINES } from './dom.js';
export type { PlayLoop, ConsoleKind, ConsoleLine } from './dom.js';
export { drawPlayHud, resolveDisplay, resolveDisplayAsync, pumpMuzzleLight, pumpExplosionLights, pumpBoltLights, pumpTracers, registerPakModels, loadConcharsFont, concharsFontFromPCX, fpsHudAnchor, posHudAnchor, formatFpsText, fpsVisible, posVisible, formatPlayerPos, playerPosText, getBrightness, applyBrightness, getSkill, getMapSource, availableMapSources, getResolution, parseResolution, rebootPlay, applyRendererCvar, skillInhibits, parseSpawnflags, worldModelForPickup, skinForItemModel, SKILL_DEFAULT, SKILL_MIN, SKILL_MAX, RESOLUTION_OPTIONS, RESOLUTION_DEFAULT, MAP_SOURCE_DEFAULT, MAP_SOURCE_DEVROOM, MAP_SOURCE_PAK, MAP_SOURCE_OPTIONS, CONTROLS_HINT, SHIP_MODEL, SHIP_SKIN, BANNER_MODEL, BANNER_SKIN, FPS_GREEN, POS_GREY, BRIGHTNESS_DEFAULT, BRIGHTNESS_MIN, BRIGHTNESS_MAX, TRACER_TTL_FRAMES, BLASTER_TRACER_COLOR, HITSCAN_TRACER_COLOR, PELLET_TRACER_COLOR, ENEMY_TRACER_LENGTH } from './play.js';
export type { PakModelHandles, TracerBeam } from './play.js';
export {
  attachBrowserPool,
  buildAsyncView,
  createAsyncLoopState,
  frameAsync,
  stepAsyncSim,
} from './play.js';
export type { AsyncLoopState } from './play.js';
export { BrowserBandPool, browserPoolAvailable, defaultBrowserWorkers, BROWSER_POOL_TIMEOUT_MS, selectVoodooBandPath, voodooStateToScanoutOpts } from './render-workers.js';
export type { BrowserPoolOptions, VoodooBandPath, ScanoutBandOptions } from './render-workers.js';

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
    // Restore the menu cvars (renderer/skill/resolution/map/brightness)
    // before the first boot so a reload keeps the previous session's menu.
    dom.restorePersistedCVars();
    dom.attachConsoleClear();
    dom.pushConsoleLog('execing config.cfg', 'info');
    const canvas = document.querySelector('#q2');
    const progress = document.querySelector('#q2-progress');
    const cvars = document.querySelector('#q2-cvars');
    const topPak = document.querySelector('#q2-top-pak');
    let current: { stop(): void } | null = null;
    let currentBoot: PlayBoot | null = null;
    let lastPak: WebPak | null = null;
    let lastName: string | undefined;
    const startWithPak = (pak: WebPak | null, name?: string): void => {
      current?.stop();
      lastPak = pak;
      lastName = name;
      // Map-source dropdown: the pak appears in the list from now on, and
      // the selection latches here (drop/cache = pak, clear = devroom).
      // A reboot honors getMapSource(): 'pak' boots the cached game map,
      // 'devroom' boots the asset-free demomap even with a pak cached.
      dom.setMapSourceHasPak(pak !== null);
      renderCvars();
      const effective = getMapSource() === 'pak' ? pak : null;
      // bootPlay latches the menu skill + resolution cvars (same path as
      // fresh boot: SV_SetSkill before spawning, framebuffer at the menu
      // size), so the panel below needs no explicit size arguments.
      const boot = bootPlay({ pak: effective });
      currentBoot = boot;
      current = dom.startPlayLoop(canvas, boot, { pak: effective });
      const label = name ? `loaded ${name}: ${pak?.entries.length} entries` : `devroom ready — drop pak0.pak for base1`;
      dom.setProgress(progress, 1, label);
      const w = boot.host.fb.width;
      const h = boot.host.fb.height;
      const mode = `${w}×${h} · ${effective ? 'pak · base1' : 'devroom'}`;
      dom.setModeReadout(mode, 0);
      if (topPak) topPak.textContent = effective ? `pak0.pak · ${pak?.entries.length} lumps` : 'pak0.pak · not cached';
      dom.pushConsoleLog(name ? `loaded ${name}: ${pak?.entries.length} entries` : 'video subsystem ready · awaiting changes', 'ok');
    };
    // Skill/resolution/map-source changes reboot the level at once (id
    // latches them; the menu applies them immediately by re-calling the
    // boot path). vid_renderer hot-swaps in place instead: the resolve
    // path reads the cvar every frame, so only the latched choice needs
    // updating — Host/LocalDriver/server state (pos/hp/ammo/monsters)
    // survives the switch.
    const onCvar = (cvarName: string): void => {
      dom.savePersistedCVars();
      if (cvarName === 'vid_renderer') {
        if (currentBoot) applyRendererCvar(currentBoot);
        dom.pushConsoleLog(`vid_ref "${cvarName}" hot-swapped in place`, 'cmd');
        return;
      }
      if (!dom.cvarNeedsReboot(cvarName)) {
        dom.pushConsoleLog(`${cvarName} updated`, 'cmd');
        return;
      }
      dom.pushConsoleLog(`vid_restart · restarting video subsystem (${cvarName})`, 'warn');
      startWithPak(lastPak, lastName);
    };
    const renderCvars = (): void => {
      if (cvars) dom.renderCvarPanel(cvars, '', onCvar);
    };
    // Cached-first boot: a previous drop persists in IndexedDB, so one
    // drop survives reloads. Empty/corrupt cache → devroom, no error spam.
    const bootFromCache = async (): Promise<void> => {
      dom.setProgress(progress, 0.2, 'loading cached pak0.pak…');
      try {
        const cached = await loadCachedPak();
        if (cached) {
          // Persist the map selection for the cached game map (the
          // map_source default is already 'pak'; this keeps an explicit
          // earlier choice intact while guaranteeing the cached boot).
          if (getMapSource() !== 'devroom') setCVarFromString('map_source', 'pak');
          startWithPak(cached.pak, cached.name);
          return;
        }
      } catch {
        /* corrupt IDB → fall through to devroom */
      }
      // No pak cached: devroom only, so latch the menu there.
      setCVarFromString('map_source', 'devroom');
      startWithPak(null);
    };
    void bootFromCache();
    if (canvas) {
      dom.attachDropZone(document.body, (pak, name) => {
        // Persist the raw drop, then boot as today.
        void storeCachedPak(name, pak.data).catch(() => undefined);
        // The drop IS a map selection: the pak appears in the dropdown and
        // boots at once (fresh reboot, same as the boot path).
        setCVarFromString('map_source', 'pak');
        startWithPak(pak, name);
      });
    }
    renderCvars();
    // Static faceplate footer buttons (present in index.html): revert just
    // re-renders the panel, clear drops the cached pak and latches devroom.
    const clearBtn = document.querySelector('#q2-clear-pak');
    clearBtn?.addEventListener('click', () => {
      void clearCachedPak().then(() => {
        lastPak = null;
        // Clearing drops the pak from the dropdown and latches devroom.
        setCVarFromString('map_source', 'devroom');
        startWithPak(null);
        dom.setProgress(progress, 1, 'cached pak cleared — drop pak0.pak for base1');
        dom.pushConsoleLog('cached pak cleared — drop pak0.pak for base1', 'warn');
      });
    });
    document.querySelector('#q2-revert')?.addEventListener('click', () => {
      renderCvars();
      dom.pushConsoleLog('changes reverted to last applied configuration', 'warn');
    });
  });
}
