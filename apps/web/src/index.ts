// q2ts-web entry (M7.1+): real playable boot. Headless-safe: `bootWeb()`
// boots the procedural devroom (or base1 from pak bytes) to its first
// rendered frame through the real software renderer. In a browser the
// auto-boot below additionally wires canvas, drop zone, loop + HUD.
import { setCVarFromString } from '@q2/config';
import { bootToFirstFrame } from './devroom.js';
import {
  applyRendererCvar,
  attachBrowserPool,
  bootPlay,
  createAsyncLoopState,
  getMapSource,
  measureFrameStages,
} from './play.js';
import type { AsyncLoopState, PlayBoot, RendererKind, StageReport } from './play.js';
import { blitToCanvas } from './dom.js';
import { pakHasMaps } from './pak.js';
import type { WebPak } from './pak.js';
import { clearCachedPak, loadCachedPak, storeCachedPak } from './pak-cache.js';
import { parseSoakParams, runSoakBoot } from './soak.js';

export { bootToFirstFrame };
export type { RendererKind };
export { bootPlay };
export type { PlayBoot };
export { parsePakEntries, ingestPak, readPakEntry, pakHasMaps } from './pak.js';
export type { WebPak, WebPakEntry } from './pak.js';
export { clearCachedPak, loadCachedPak, storeCachedPak } from './pak-cache.js';export { blitToCanvas, blitCopyRGBA, blitIsLittleEndian, attachDropZone, renderCvarPanel, setProgress, startPlayLoop, showFpsEnabled, showPosEnabled, cvarIsCheckbox, CHECKBOX_CVARS, cvarOptions, cvarControlKind, cvarOptionLabels, cvarDescription, CVAR_DESCRIPTIONS, skillLabel, skillValueForLabel, SKILL_LABELS, RESOLUTION_LABELS, MAP_SOURCE_LABELS, VID_RENDERER_LABELS, setMapSourceHasPak, getMapSourceHasPak, REBOOT_CVARS, cvarNeedsReboot, CVAR_OPTIONS, pushConsoleLog, clearConsoleLog, resetConsoleLog, getConsoleLines, renderConsoleLines, attachConsoleClear, setModeReadout, MAX_CONSOLE_LINES } from './dom.js';
export type { PlayLoop, ConsoleKind, ConsoleLine } from './dom.js';
export { drawPlayHud, resolveDisplay, resolveDisplayAsync, pumpMuzzleLight, pumpExplosionLights, pumpBoltLights, pumpTracers, registerPakModels, replayPakAssetsToGpu, loadConcharsFont, concharsFontFromPCX, fpsHudAnchor, posHudAnchor, formatFpsText, fpsVisible, posVisible, formatPlayerPos, playerPosText, getBrightness, applyBrightness, getSkill, getMapSource, availableMapSources, getResolution, parseResolution, rebootPlay, applyRendererCvar, skillInhibits, parseSpawnflags, worldModelForPickup, skinForItemModel, SKILL_DEFAULT, SKILL_MIN, SKILL_MAX, RESOLUTION_OPTIONS, RESOLUTION_DEFAULT, MAP_SOURCE_DEFAULT, MAP_SOURCE_DEVROOM, MAP_SOURCE_PAK, MAP_SOURCE_OPTIONS, CONTROLS_HINT, SHIP_MODEL, SHIP_SKIN, BANNER_MODEL, BANNER_SKIN, FPS_GREEN, POS_GREY, BRIGHTNESS_DEFAULT, BRIGHTNESS_MIN, BRIGHTNESS_MAX, detectGpuCapability, getGpuStatus, resolveBootRenderer, TRACER_TTL_FRAMES, BLASTER_TRACER_COLOR, HITSCAN_TRACER_COLOR, PELLET_TRACER_COLOR, ENEMY_TRACER_LENGTH } from './play.js';
export type { PakModelHandles, RetainedModelAsset, RetainedPakAssets, RetainedSkinAsset, TracerBeam } from './play.js';
export {
  attachBrowserPool,
  buildAsyncView,
  createAsyncLoopState,
  frameAsync,
  frameGpuPlay,
  measureFrameStages,
  paintHudOverlay,
  stepAsyncSim,
} from './play.js';
export type { AsyncLoopState, GpuBootState, HudState, StageReport } from './play.js';
export { acquireGpuCanvas, GPU_CANVAS_ID, HUD_CANVAS_ID, GPU_CONTEXT_ATTRS } from './gpu-canvas.js';
export type { GpuCanvas } from './gpu-canvas.js';
export type { GpuCapability } from './play.js';
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

/**
 * Install the instrumented browser-measurement hook (`window.__q2bench`).
 * Headless-safe (no-op without `window`). See the call site for the
 * instrumented-only contract: the production tick never touches this.
 */
export function installBenchHook(
  canvas: HTMLCanvasElement | null,
  getBoot: () => PlayBoot | null,
  stopLoop: () => void,
): void {
  try {
    const w = typeof window !== 'undefined' ? window : undefined;
    if (!w) return;
    let benchSt: AsyncLoopState | null = null;
    let benchNow = 0;
    const hook = {
      /** Boot geometry + renderer + source (null before the first boot). */
      info(): Record<string, unknown> {
        const boot = getBoot();
        if (!boot) return { booted: false };
        return {
          booted: true,
          w: boot.host.fb.width, h: boot.host.fb.height,
          renderer: boot.renderer, source: boot.source,
        };
      },
      /** Stop the live rAF loop (idempotent). Required before measure(). */
      stopLoop(): void {
        try {
          stopLoop();
        } finally {
          benchSt = null;
        }
      },
      /**
       * Fresh pool for harness-driven frames (call after stopLoop):
       * disposes the loop's pool and attaches a new one sized from
       * `sw_workers` (bands = cvar; omit `workers` for the cvar default).
       * An explicit count ALSO writes the cvar first, so renderer bands
       * and pool bands always match (a mismatched pool would still cover
       * the frame, but tallies/geometry stay comparable only when
       * matched). Never throws (false = sync fallback, identical pixels).
       */
      reattach(workers?: number): { pooled: boolean; bands: number } {
        const boot = getBoot();
        if (!boot) return { pooled: false, bands: 1 };
        try {
          if (workers !== undefined) {
            const n = Math.max(1, Math.min(7, Math.floor(workers)));
            if (Number.isFinite(n)) setCVarFromString('sw_workers', String(n + 1));
          }
          const old = boot.browserPool as unknown as { dispose?: () => Promise<void> } | null;
          if (old && typeof old.dispose === 'function') {
            void old.dispose().catch(() => undefined);
          }
        } catch { /* a dead pool must not block measurement */ }
        benchSt = createAsyncLoopState();
        benchNow = performance.now();
        const pool = attachBrowserPool(boot, workers);
        if (!pool) return { pooled: false, bands: 1 };
        return { pooled: true, bands: pool.bandCount };
      },
      /**
       * Detach the worker pool for harness-driven frames (call after
       * stopLoop): disposes the loop's pool and restores the renderer's
       * owned planes, so subsequent measure() runs cover the true
       * single-threaded leg — same band geometry, zero worker fan-out,
       * bit-identical pixels. Never throws ({ pooled: false } when there
       * is nothing to detach). Pair with reattach(n) for the 0/1/3/7
       * worker-count sweep (PERF-NEXT-6 Box 2): reattach() clamps to
       * >= 1 worker, so detach() is the only pool-less leg; it keeps the
       * current sw_workers so the serial leg runs the SAME band geometry
       * as the pooled legs (the control isolates worker parallelism from
       * banding — bands is reported back so the table stays honest).
       */
      detach(): { pooled: boolean; bands: number } {
        const boot = getBoot();
        if (!boot) return { pooled: false, bands: 1 };
        try {
          const old = boot.browserPool as unknown as { dispose?: () => Promise<void> } | null;
          if (old && typeof old.dispose === 'function') {
            void old.dispose().catch(() => undefined);
          }
        } catch { /* a dead pool must not block measurement */ }
        try {
          boot.browserPool = null;
          boot.refresh.attachWorkerPool(null);
        } catch { /* renderer without the hook stays as-is */ }
        benchSt = createAsyncLoopState();
        benchNow = performance.now();
        try {
          const ws = boot.refresh.testWorkerStats();
          return { pooled: ws.pooled === true, bands: ws.bands | 0 };
        } catch {
          return { pooled: false, bands: 1 };
        }
      },
      /**
       * Drive scenario input directly (angles in degrees, buttons bitmask,
       * forward = hold +forward). Safe on a live loop too (same fields the
       * input layer writes); measurement uses it after stopLoop().
       */
      setInput(o: { yaw?: number; pitch?: number; buttons?: number; forward?: boolean }): void {
        const boot = getBoot();
        if (!boot) return;
        try {
          if (typeof o.yaw === 'number') boot.host.input.angles[1] = o.yaw;
          if (typeof o.pitch === 'number') boot.host.input.angles[0] = o.pitch;
          if (typeof o.buttons === 'number') boot.host.input.buttons = o.buttons;
          if (o.forward !== undefined) {
            if (o.forward) boot.host.input.keys.add('forward');
            else boot.host.input.keys.delete('forward');
          }
        } catch { /* input shape mismatch: ignore */ }
      },
      /**
       * Run `frames` instrumented frames (requires stopLoop + reattach
       * first) and return per-frame stage reports. `yawStep` advances the
       * camera per frame (moving-camera scenario), `buttons` holds fire
       * (combat scenario, viewmodel + muzzle + tracers), `diag` arms the
       * pool per-band timing around the run, `blit` times presenting each
       * frame to the live canvas. Allocates (diag path only).
       */
      async measure(
        frames: number,
        o: { yawStep?: number; buttons?: number; forward?: boolean; diag?: boolean; blit?: boolean } = {},
      ): Promise<StageReport[]> {
        const boot = getBoot();
        if (!boot || !benchSt) throw new Error('__q2bench.measure: call stopLoop() + reattach() first');
        const n = Math.max(1, Math.min(600, Math.floor(frames)));
        const pool = boot.browserPool as unknown as {
          enableDiag?: () => void; disableDiag?: () => void;
        } | null;
        const armed = o.diag === true && pool !== null && typeof pool?.enableDiag === 'function';
        try {
          if (armed && pool !== null) pool.enableDiag?.();
          if (o.buttons !== undefined) boot.host.input.buttons = o.buttons;
          if (o.forward !== undefined) {
            if (o.forward) boot.host.input.keys.add('forward');
            else boot.host.input.keys.delete('forward');
          }
          const out: StageReport[] = [];
          for (let f = 0; f < n; f++) {
            if (typeof o.yawStep === 'number') boot.host.input.angles[1] += o.yawStep;
            benchNow += 1000 / 60;
            const blit = o.blit === true && canvas
              ? (target: Uint32Array): void => {
                blitToCanvas(canvas, {
                  width: boot.host.fb.width, height: boot.host.fb.height,
                  color: target,
                  index: boot.host.fb.index, depth: boot.host.fb.depth,
                });
              }
              : undefined;
            out.push(await measureFrameStages(boot, benchSt, benchNow, { fps: 0, frame: f }, blit));
          }
          return out;
        } finally {
          try {
            if (armed && pool !== null && typeof pool.disableDiag === 'function') pool.disableDiag();
          } catch { /* disarm best-effort */ }
        }
      },
      /**
       * Live stats snapshot (the `__q2stats` record copy) + JS heap when
       * exposed (Chromium `performance.memory`) + canvas box.
       */
      stats(): Record<string, unknown> {
        const g = globalThis as unknown as { __q2stats?: Record<string, unknown> };
        let memory = -1;
        try {
          const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
          if (mem) memory = mem.usedJSHeapSize;
        } catch { /* non-Chromium: -1 stands */ }
        return {
          ...(g.__q2stats ?? {}),
          memory,
          canvasW: canvas?.width ?? -1,
          canvasH: canvas?.height ?? -1,
        };
      },
    };
    (w as unknown as { __q2bench?: unknown }).__q2bench = hook;
  } catch {
    /* a failed hook install must never break the boot */
  }
}

// Browser auto-boot: only runs when a DOM is present. Keeps
// builds working and Node imports side-effect free.
if (typeof document !== 'undefined') {
  void import('./dom.js').then((dom) => {
    // GPU-PROOF-5 soak mode (measurement only): `?q2soak=1&q2pak=<url>&q2renderer=<id>`
    // boots base1 at 640x480 through the production loop for headless CDP
    // measurement. The normal interactive boot below is untouched.
    try {
      const soakParams = parseSoakParams(typeof location !== 'undefined' ? location.search : '');
      if (soakParams) {
        void runSoakBoot(soakParams);
        return;
      }
    } catch {
      /* malformed soak query: fall through to the normal boot */
    }
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
    // PERF-FINISH-B instrumented stage capture (`window.__q2bench`).
    //
    // Instrumented-only: installing this hook costs the production loop
    // nothing (one property store at boot, never read by the tick). The
    // harness (CDP stage capture) stops the live loop, re-attaches a fresh
    // pool, drives input scenarios, and runs `measureFrameStages` frames —
    // the SAME engine/workers/canvas as production, but explicitly
    // instrumented. Acceptance FPS always comes from the uninstrumented
    // loop (`__q2stats.frame` deltas), never from these numbers.
    installBenchHook(
      canvas as HTMLCanvasElement | null,
      () => currentBoot,
      () => { current?.stop(); current = null; },
    );
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
