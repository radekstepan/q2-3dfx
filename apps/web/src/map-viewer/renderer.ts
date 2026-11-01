// apps/web/src/map-viewer/renderer.ts — software map-view renderer.
//
// Owns a SoftwareRenderer + framebuffer + converted MiniWorld and blits to a
// 2D canvas. Render-on-demand: the owner (main.ts) drives its own rAF loop and
// calls render() per frame. Textured + lit when the caller supplies asset
// resolvers (texelFor); otherwise bspToMiniWorld's checker/unlit fallback
// keeps the map inspectable.
//
// STATIC VIEWER LIMITATIONS (do not imply simulation):
// - Only world model 0 is traversed. Brush submodels (*1..*N: doors,
//   platforms, rotating brushes) are NOT drawn and nothing moves — entity
//   markers/navigation live in panel.ts, not here.
// - No dynamic lighting, no particles from gameplay; lightStyles are 1.
// - No Host/Server/player/spawn logic: the camera pose comes from camera.ts.
import { SoftwareRenderer, bspToMiniWorld, createDevroom, isValidSkySize } from '@q2/sw-renderer';
import type { BspTexelSource, MiniWorld } from '@q2/sw-renderer';
import type { BspMap } from '@q2/bsp';
import { createFramebuffer } from '@q2/renderer-api';
import type { FrameStats, WorldModel } from '@q2/renderer-api';

/** Mip-0 texel lookup by WAL name (e.g. `e1u1/metal2_1`); null = checker fallback. */
export type ViewerTexelFor = (walName: string) => BspTexelSource | null;

/** Game default (`r_brightness` in play.ts); the engine buffer is authored for this lift. */
export const VIEWER_BRIGHTNESS_DEFAULT = 2.0;
export const VIEWER_BRIGHTNESS_MIN = 0.5;
export const VIEWER_BRIGHTNESS_MAX = 3.0;

/**
 * Display-only brightness lift on a 0xAABBGGRR buffer, in place (alpha
 * preserved, channels rounded + clamped). Port of `applyBrightness` in
 * apps/web/src/play.ts — duplicated so the viewer stays independent of the
 * game boot path. `brightness === 1` is a no-op so the 1.0 path stays
 * byte-identical.
 */
export function applyViewerBrightness(dst: Uint32Array, brightness: number): void {
  if (brightness === 1) return;
  for (let i = 0; i < dst.length; i++) {
    const px = dst[i]!;
    let r = (px & 255) * brightness;
    let g = ((px >> 8) & 255) * brightness;
    let b = ((px >> 16) & 255) * brightness;
    r = r > 255 ? 255 : Math.round(r);
    g = g > 255 ? 255 : Math.round(g);
    b = b > 255 ? 255 : Math.round(b);
    dst[i] = (px & 0xff000000) | (b << 16) | (g << 8) | r;
  }
}

export interface ViewerView {
  origin: ArrayLike<number>;
  angles: ArrayLike<number>;
  fovX?: number;
}

export interface ViewerRendererOptions {
  width?: number;
  height?: number;
  /** Horizontal field of view, degrees. Default 90. */
  fov?: number;
}

export type ViewerMode = 'textured-lit' | 'fallback-checker' | 'empty';

export interface ViewerStatus {
  width: number;
  height: number;
  mapName: string | null;
  /** Surfaces in the converted world (face i <-> surface i, NODRAW kept degenerate). */
  surfaces: number;
  /** Brush submodels present in the BSP (only model 0 is drawn). */
  submodels: number;
  hasMap: boolean;
  /** Bumped on every successful setMap (stale async callers can compare). */
  generation: number;
  lastError: string | null;
  mode: ViewerMode;
  /** Current display brightness lift (default matches the game's r_brightness). */
  brightness: number;
  /** Whether the palette came from a PAK colormap or the procedural fallback. */
  palette: 'pak' | 'procedural';
  /** Whether a textured skybox is installed or the flat-fill fallback shows. */
  sky: 'textured' | 'flat-fallback';
}

export interface ViewerRenderer {
  setMap(bsp: BspMap, texelFor?: ViewerTexelFor | null): void;
  /**
   * Install the real palette from `pics/colormap.pcx` (768-byte RGB) plus
   * optional raw PCX pixels for C-exact blend tables. Null palette keeps the
   * current one (procedural until a PAK provides otherwise). Always
   * invalidates surface caches — shade blocks are baked per palette.
   */
  setColormap(palette: Uint8Array | null, pixels?: Uint8Array | null): void;
  /**
   * Install the packed skybox strip (see setSkyTexture packing contract).
   * Null clears it back to the engine's flat-fill fallback. Never throws.
   */
  setSkyTexture(tex: { texels: Uint8Array; width: number; height: number } | null): void;
  /** Display-only brightness lift (default 2.0, matching the game). */
  setBrightness(v: number): void;
  render(view: ViewerView, timeMs: number): FrameStats;
  resize(w: number, h: number): void;
  dispose(): void;
  getStatus(): ViewerStatus;
}

const ZERO_STATS: FrameStats = { spans: 0, pixels: 0, overdraw: 0, ms: 0 };
const EMPTY_ENTITIES: never[] = [];
const MIN_DIM = 1;
const MAX_DIM = 4096;

function clampDim(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : fallback;
  if (!Number.isFinite(n)) return fallback;
  if (n < MIN_DIM) return MIN_DIM;
  if (n > MAX_DIM) return MAX_DIM;
  return n;
}

interface Canvas2DLike {
  width: number;
  height: number;
  getContext(kind: string): unknown;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  parentNode?: unknown;
  clientWidth?: unknown;
  clientHeight?: unknown;
}

export function createViewerRenderer(
  canvas: HTMLCanvasElement,
  opts: ViewerRendererOptions = {},
): ViewerRenderer {
  const el = canvas as unknown as Canvas2DLike;
  const fovDefault = opts.fov ?? 90;

  let width = clampDim(opts.width ?? el.width, 320);
  let height = clampDim(opts.height ?? el.height, 240);

  const refresh = new SoftwareRenderer();
  refresh.init(createFramebuffer(width, height, true));

  const lightStyles = new Float32Array(256).fill(1);
  const scratchOrigin = new Float32Array(3);
  const scratchAngles = new Float32Array(3);

  let world: WorldModel | null = null;
  let mini: MiniWorld | null = null;
  let mapName: string | null = null;
  let submodels = 0;
  let assetsBound = false;
  let generation = 0;
  let lastError: string | null = null;
  let disposed = false;
  let brightness = VIEWER_BRIGHTNESS_DEFAULT;
  let paletteSource: 'pak' | 'procedural' = 'procedural';
  let skyTextured = false;

  // No-map placeholder: shared cached devroom (createDevroom memoises; the
  // renderer never mutates the world) so the canvas shows *something*
  // asset-free before the first setMap.
  let devWorld: WorldModel | null = null;

  // --- 2D blit plumbing (guarded: headless stubs may omit anything) ---
  let ctx: CanvasRenderingContext2D | null = null;
  let img: ImageData | null = null;
  let overlay: { remove(): void } | null = null;

  function showOverlay(message: string): void {
    lastError = message;
    if (overlay) return;
    try {
      const g = globalThis as { document?: Document };
      const doc = g.document;
      const parent = el.parentNode as
        | { insertBefore?: (n: unknown, ref: unknown) => void }
        | null
        | undefined;
      if (!doc || !parent || typeof parent.insertBefore !== 'function') return;
      const div = doc.createElement('div');
      div.setAttribute('data-viewer-overlay', 'context');
      div.textContent = message;
      div.style.cssText =
        'position:absolute;inset:auto 8px 8px 8px;padding:8px 12px;' +
        'background:rgba(20,8,8,.92);color:#ffd7d7;font:12px/1.5 monospace;' +
        'border:1px solid #a33;border-radius:4px;z-index:10;pointer-events:auto;';
      parent.insertBefore(div, null);
      overlay = { remove: (): void => div.remove() };
    } catch {
      overlay = null;
    }
  }

  function resolveCtx(): CanvasRenderingContext2D | null {
    if (ctx) return ctx;
    try {
      const c = el.getContext('2d') as CanvasRenderingContext2D | null;
      if (!c) {
        showOverlay(
          'Map viewer: 2D canvas context unavailable. Use a browser with canvas support ' +
            'or check that no other tab exhausted GPU resources, then reload.',
        );
        return null;
      }
      ctx = c;
      return ctx;
    } catch (e) {
      showOverlay(
        `Map viewer: failed to acquire 2D context (${String(e)}). Reload the page; ` +
          'if it persists, try a different browser.',
      );
      return null;
    }
  }

  function paintPlaceholder(): void {
    const c = resolveCtx();
    if (!c) return;
    try {
      c.fillStyle = '#0b0b10';
      c.fillRect(0, 0, width, height);
    } catch {
      /* stub canvas without fill ops: nothing to present */
    }
  }

  function blit(): void {
    const c = resolveCtx();
    if (!c) return;
    try {
      const fb = refresh.getFramebuffer();
      if (!img || img.width !== width || img.height !== height) {
        img = c.createImageData(width, height);
      }
      const dst = new Uint32Array(img.data.buffer);
      dst.set(fb.color.subarray(0, width * height));
      // Display-only lift (mirrors the game's r_brightness post-resolve
      // step): the engine buffer is untouched, only the presented copy.
      if (brightness !== 1) applyViewerBrightness(dst.subarray(0, width * height), brightness);
      c.putImageData(img, 0, 0);
    } catch (e) {
      // A stub 2D context (or a mid-resize race) must never break the loop;
      // record once and keep rendering into the framebuffer.
      if (!lastError) lastError = `Map viewer: canvas blit failed (${String(e)}).`;
    }
  }

  // --- context loss: actionable message, owned overlay (not main.ts) ---
  const onContextLost = (e: unknown): void => {
    try {
      (e as { preventDefault?: () => void }).preventDefault?.();
    } catch {
      /* ignore */
    }
    showOverlay(
      'Map viewer: rendering context lost (driver crash, GPU reset, or resource ' +
        'pressure). Wait a moment and reload the page; your map file stays selected ' +
        'in the file picker. If it recurs, lower the canvas size or update GPU drivers.',
    );
  };
  const onContextRestored = (): void => {
    try {
      overlay?.remove();
    } catch {
      /* ignore */
    }
    overlay = null;
    lastError = null;
    img = null;
  };
  try {
    el.addEventListener('contextlost', onContextLost);
    el.addEventListener('contextrestored', onContextRestored);
  } catch {
    /* stub canvas without events */
  }

  // --- viewport resize via ResizeObserver (guarded for headless) ---
  let ro: { disconnect(): void } | null = null;
  try {
    const RO = (globalThis as { ResizeObserver?: new (cb: () => void) => { observe(t: unknown): void; disconnect(): void } })
      .ResizeObserver;
    if (RO) {
      const ob = new RO(() => {
        if (disposed) return;
        const cw = clampDim(
          typeof el.clientWidth === 'number' ? el.clientWidth : width,
          width,
        );
        const ch = clampDim(
          typeof el.clientHeight === 'number' ? el.clientHeight : height,
          height,
        );
        if (cw !== width || ch !== height) resize(cw, ch);
      });
      ob.observe(el as unknown);
      ro = ob;
    }
  } catch {
    ro = null;
  }

  function resize(w: number, h: number): void {
    if (disposed) return;
    const nw = clampDim(w, width);
    const nh = clampDim(h, height);
    if (nw === width && nh === height) return;
    width = nw;
    height = nh;
    refresh.init(createFramebuffer(width, height, true));
    img = null;
    try {
      (el as { width: number; height: number }).width = width;
      (el as { width: number; height: number }).height = height;
    } catch {
      /* stub canvas: ignore */
    }
  }

  function setMap(bsp: BspMap, texelFor?: ViewerTexelFor | null): void {
    if (disposed) return;
    let next: MiniWorld;
    try {
      next = bspToMiniWorld(bsp, texelFor ? { texelFor } : {});
    } catch (e) {
      // Recoverable: keep the previous world so the viewer stays usable.
      lastError = `Map viewer: failed to convert BSP (${String(e)}). Previous map kept.`;
      return;
    }
    // Invalidate BEFORE adopting: the cache keys on surface identity and the
    // old world's entries must never serve the new world's ids.
    refresh.invalidateCaches();
    mini = next;
    world = { name: 'maps/viewer', data: next };
    try {
      const extra = (bsp as { modelsExtra?: ArrayLike<number> }).modelsExtra;
      submodels = extra ? Math.floor(extra.length / 3) : 0;
    } catch {
      submodels = 0;
    }
    mapName = 'maps/viewer';
    assetsBound = !!texelFor;
    lastError = null;
    generation += 1;
    // Release the previous MiniWorld's backing stores: dropping our refs lets
    // GC reclaim the old surfaces/textures/lightmaps (refresh holds no world
    // refs past endFrame; the surface cache was just invalidated).
  }

  function render(view: ViewerView, timeMs: number): FrameStats {
    if (disposed) return ZERO_STATS;
    let active = world;
    if (!active) {
      if (!devWorld) devWorld = { name: 'maps/devroom', data: createDevroom() };
      active = devWorld;
    }
    scratchOrigin[0] = view.origin[0] ?? 0;
    scratchOrigin[1] = view.origin[1] ?? 0;
    scratchOrigin[2] = view.origin[2] ?? 0;
    scratchAngles[0] = view.angles[0] ?? 0;
    scratchAngles[1] = view.angles[1] ?? 0;
    scratchAngles[2] = view.angles[2] ?? 0;
    const t = Number.isFinite(timeMs) ? timeMs / 1000 : 0;
    try {
      refresh.beginFrame();
      const stats = refresh.renderView(
        {
          origin: scratchOrigin,
          angles: scratchAngles,
          fovX: view.fovX ?? fovDefault,
          time: t,
          lightStyles,
        },
        active,
        EMPTY_ENTITIES,
      );
      refresh.endFrame();
      blit();
      return stats;
    } catch (e) {
      lastError = `Map viewer: render failed (${String(e)}). Try resizing or reloading the map.`;
      paintPlaceholder();
      return ZERO_STATS;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      ro?.disconnect();
    } catch {
      /* ignore */
    }
    ro = null;
    try {
      el.removeEventListener('contextlost', onContextLost);
      el.removeEventListener('contextrestored', onContextRestored);
    } catch {
      /* ignore */
    }
    try {
      overlay?.remove();
    } catch {
      /* ignore */
    }
    overlay = null;
    refresh.invalidateCaches();
    world = null;
    mini = null;
    devWorld = null;
    img = null;
    ctx = null;
    generation += 1;
  }

  function setColormap(palette: Uint8Array | null, pixels?: Uint8Array | null): void {
    if (disposed || !palette || palette.length < 768) return;
    try {
      refresh.setPalette(palette.slice(0, 768));
      if (pixels && pixels.length > 0) {
        try {
          refresh.setAlphamapFromColormapPcx(pixels);
        } catch {
          /* blend tables keep the procedural fallback */
        }
      }
      // Shade blocks are baked per palette — drop any built under the old one.
      refresh.invalidateCaches();
      paletteSource = 'pak';
    } catch (e) {
      lastError = `Map viewer: failed to install palette (${String(e)}). Procedural fallback kept.`;
    }
  }

  function setBrightness(v: number): void {
    if (!Number.isFinite(v)) return;
    brightness = Math.min(VIEWER_BRIGHTNESS_MAX, Math.max(VIEWER_BRIGHTNESS_MIN, v));
  }

  function setSkyTexture(tex: { texels: Uint8Array; width: number; height: number } | null): void {
    if (disposed) return;
    try {
      refresh.setSkyTexture(tex);
      // The renderer clears null/invalid strips to its flat-fill fallback;
      // mirror that rule here so the status stays honest.
      skyTextured =
        !!tex && isValidSkySize(tex.width, tex.height) && tex.texels.length === tex.width * tex.height;
    } catch (e) {
      skyTextured = false;
      lastError = `Map viewer: failed to install sky (${String(e)}). Flat fallback kept.`;
    }
  }

  function getStatus(): ViewerStatus {
    const mode: ViewerMode = !mini ? 'empty' : assetsBound ? 'textured-lit' : 'fallback-checker';
    return {
      width,
      height,
      mapName,
      surfaces: mini ? mini.surfaces.length : 0,
      submodels,
      hasMap: mini !== null,
      generation,
      lastError,
      mode,
      brightness,
      palette: paletteSource,
      sky: skyTextured ? 'textured' : 'flat-fallback',
    };
  }

  // Present the canvas backing store size immediately so the first paint has
  // no 300x150 default flash (stub-safe).
  try {
    el.width = width;
    el.height = height;
  } catch {
    /* stub canvas: ignore */
  }

  return { setMap, setColormap, setSkyTexture, setBrightness, render, resize, dispose, getStatus };
}
