// q2ts-web GPU canvas glue (GPU-PROOF-3).
//
// Browser glue owns canvas/context acquisition; the GPU backend owns GL
// resources, textures, programs and render targets. Headless-safe: every DOM
// touch is guarded, so vitest/Node (no DOM) gets null — the caller falls back
// via the PROOF-2 resolver WITH a warning, never silently.
//
// Stacking: the GL canvas is inserted immediately BEFORE the existing 2D/HUD
// canvas (`#q2`, the blit target) with z-index 0, and the HUD canvas is raised
// to z-index 1 (position relative keeps its layout spot). HUD presentation is
// therefore preserved: `drawPlayHud` keeps painting into the CPU display
// plane, which is blitted to the 2D overlay canvas on top of the GL canvas.
// When the GPU backend is live the overlay is a transparent-black buffer with
// opaque HUD pixels only (see `paintHudOverlay` in play.ts), so the GL scene
// shows through everywhere except the HUD.

/** Element id of the WebGL canvas (reused across boots/hot-swaps by id). */
export const GPU_CANVAS_ID = 'q2-gl';

/** Element id of the existing 2D/HUD canvas (blit target, stays on top). */
export const HUD_CANVAS_ID = 'q2';

/** Acquired GL drawing surface: DOM-typed in a browser, stub-shaped in tests. */
export interface GpuCanvas {
  /** HTMLCanvasElement in a browser (structural stub in tests). */
  canvas: unknown;
  /** WebGL2RenderingContext in a browser (stub in tests). */
  gl: unknown;
}

/** Context attributes for the game GL canvas (fixed for the proof). */
export const GPU_CONTEXT_ATTRS = {
  antialias: false,
  alpha: false,
  depth: true,
  stencil: false,
  preserveDrawingBuffer: false,
} as const;

/** Minimal structural canvas contract (real element or test stub). */
interface CanvasLike {
  width: number;
  height: number;
  style?: Record<string, string> | undefined;
  getContext?: ((kind: string, attrs?: Record<string, boolean>) => unknown) | undefined;
  setAttribute?: ((name: string, value: string) => void) | undefined;
  parentNode?: unknown;
}

/** Minimal structural document contract (real document or test stub). */
interface DocLike {
  createElement?: ((tag: string) => unknown) | undefined;
  getElementById?: ((id: string) => unknown) | undefined;
  querySelector?: ((sel: string) => unknown) | undefined;
  body?: unknown;
}

/** Resolve the document: explicit arg wins, else the global (may be absent). */
function resolveDoc(doc: unknown): DocLike | null {
  try {
    if (doc !== undefined && doc !== null) return doc as DocLike;
    const g = globalThis as { document?: unknown };
    if (g.document !== undefined && g.document !== null) return g.document as DocLike;
    if (typeof document !== 'undefined') return document as unknown as DocLike;
    return null;
  } catch {
    return null;
  }
}

/** Minimal structural contract for a removable node (real element or stub). */
interface RemovableLike {
  parentNode?: unknown;
  remove?: () => void;
  style?: Record<string, string> | undefined;
}

/** True when the value looks like a DocLike (has a DOM lookup/create fn). */
function isDocLike(v: unknown): v is DocLike {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['getElementById'] === 'function' ||
    typeof r['querySelector'] === 'function' ||
    typeof r['createElement'] === 'function'
  );
}

/** True when the value looks like a CanvasLike (backing size/style/context). */
function isCanvasLike(v: unknown): v is CanvasLike {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['width'] === 'number' ||
    typeof r['height'] === 'number' ||
    (typeof r['style'] === 'object' && r['style'] !== null) ||
    typeof r['getContext'] === 'function'
  );
}

/** Find the GL canvas (`#q2-gl`) by id, or null (headless/stub DOM). */
function findGpuCanvas(d: DocLike): CanvasLike | null {
  try {
    if (typeof d.getElementById === 'function') {
      const el = d.getElementById(GPU_CANVAS_ID) as CanvasLike | null;
      if (el) return el;
    }
    if (typeof d.querySelector === 'function') {
      const el = d.querySelector(`#${GPU_CANVAS_ID}`) as CanvasLike | null;
      if (el) return el;
    }
  } catch {
    /* lookup best-effort on stubs */
  }
  return null;
}

/** Displayed CSS size for a canvas: inline style when set, else backing*2. */
function displayedSize(hud: CanvasLike): { width: string; height: string } {
  let width = '';
  let height = '';
  try {
    width = hud.style?.['width'] ?? '';
    height = hud.style?.['height'] ?? '';
  } catch {
    width = '';
    height = '';
  }
  if (!width && typeof hud.width === 'number' && hud.width > 0) {
    width = `${hud.width * 2}px`;
  }
  if (!height && typeof hud.height === 'number' && hud.height > 0) {
    height = `${hud.height * 2}px`;
  }
  return { width, height };
}

/** Core geometry sync: GL canvas overlays the HUD canvas pixel-for-pixel. */
function syncCanvasPair(gl: CanvasLike, hud: CanvasLike): void {
  if (!gl.style) {
    (gl as { style?: Record<string, string> }).style = {};
  }
  const st = gl.style as Record<string, string>;
  const { width, height } = displayedSize(hud);
  st['position'] = 'absolute';
  st['left'] = '0';
  st['top'] = '0';
  if (width) st['width'] = width;
  if (height) st['height'] = height;
  // Mirror the HUD capping so max-width/max-height viewports shrink both
  // boxes identically (style px alone would leave the GL canvas overflowing
  // the bezel while #q2 shrinks via its max-width:100% rule).
  st['maxWidth'] = '100%';
  st['maxHeight'] = '100%';
  st['objectFit'] = 'contain';
  st['imageRendering'] = 'pixelated';
  st['zIndex'] = '0';
  const hs = hud.style;
  if (hs) {
    if (!hs['position']) hs['position'] = 'relative';
    hs['zIndex'] = '1';
  }
}
/** Find the existing 2D/HUD canvas (`#q2`), or null (headless/stub DOM). */
function findHudCanvas(d: DocLike): CanvasLike | null {
  try {
    if (typeof d.getElementById === 'function') {
      const el = d.getElementById(HUD_CANVAS_ID) as CanvasLike | null;
      if (el) return el;
    }
    if (typeof d.querySelector === 'function') {
      const el = d.querySelector(`#${HUD_CANVAS_ID}`) as CanvasLike | null;
      if (el) return el;
    }
  } catch {
    /* lookup best-effort on stubs */
  }
  return null;
}

/**
 * Insert the GL canvas immediately BEFORE the HUD canvas in the same parent
 * (DOM order: GL below, HUD on top), falling back to body append. Best-effort
 * on stubs: an unattached canvas is still returned when its context works.
 */
function placeUnder(d: DocLike, canvas: CanvasLike, hud: CanvasLike | null): void {
  try {
    const parent = (hud as { parentNode?: unknown } | null)?.parentNode as
      | { insertBefore?: (n: unknown, ref: unknown) => void }
      | null
      | undefined;
    if (parent && typeof parent.insertBefore === 'function' && hud) {
      parent.insertBefore(canvas, hud);
      return;
    }
    const body = d.body as { appendChild?: (n: unknown) => void } | null | undefined;
    if (body && typeof body.appendChild === 'function') body.appendChild(canvas);
  } catch {
    /* unattached canvas still usable headless with a stub context */
  }
}

/**
 * Acquire (create or reuse by id) the GL canvas stacked UNDER the existing
 * 2D/HUD canvas and return it with a WebGL2 context, or null when unavailable
 * (no DOM, no canvas factory, or no webgl2 context). Null is the ONLY failure
 * signal — the caller falls back via the PROOF-2 resolver WITH a warning.
 * Never throws.
 */
export function acquireGpuCanvas(doc?: unknown, width = 0, height = 0): GpuCanvas | null {
  try {
    const d = resolveDoc(doc);
    if (!d || typeof d.createElement !== 'function') return null;
    // Reuse by id when the DOM supports lookup (boot/hot-swap stability).
    let canvas: CanvasLike | null = null;
    try {
      if (typeof d.getElementById === 'function') {
        const found = d.getElementById(GPU_CANVAS_ID) as CanvasLike | null;
        if (found && typeof found.getContext === 'function') canvas = found;
      }
    } catch {
      canvas = null;
    }
    const hud = findHudCanvas(d);
    if (!canvas) {
      const el = d.createElement('canvas') as CanvasLike | null;
      if (!el || typeof el.getContext !== 'function') return null;
      try {
        if (typeof el.setAttribute === 'function') el.setAttribute('id', GPU_CANVAS_ID);
        else (el as { id?: string }).id = GPU_CANVAS_ID;
      } catch {
        /* id best-effort on stubs */
      }
      canvas = el;
      placeUnder(d, canvas, hud);
    }
    // Same framebuffer size; GL below the 2D/HUD canvas. Absolute with
    // left/top 0 inside #q2-bezel (position:relative) + CSS size copied
    // from the HUD displayed size (style.width/height, fallback
    // backing*2) so the GL scene aligns pixel-for-pixel under the HUD
    // overlay; the HUD canvas goes relative (no offsets, layout
    // unchanged) with a higher z-index.
    try {
      if (width > 0) canvas.width = width;
      if (height > 0) canvas.height = height;
      if (hud) syncCanvasPair(canvas, hud);
      else {
        if (!canvas.style) {
          (canvas as { style?: Record<string, string> }).style = {};
        }
        const st = canvas.style as Record<string, string>;
        st['position'] = 'absolute';
        st['left'] = '0';
        st['top'] = '0';
        st['maxWidth'] = '100%';
        st['maxHeight'] = '100%';
        st['objectFit'] = 'contain';
        st['imageRendering'] = 'pixelated';
        st['zIndex'] = '0';
      }
    } catch {
      /* styling best-effort on stubs */
    }
    let gl: unknown = null;
    try {
      gl = canvas.getContext?.('webgl2', { ...GPU_CONTEXT_ATTRS }) ?? null;
    } catch {
      gl = null;
    }
    if (!gl) return null;
    return { canvas, gl };
  } catch {
    return null;
  }
}

/**
 * Copy the HUD displayed size (inline style.width/height, fallback to
 * backing*2) onto the GL canvas CSS (position absolute, left 0 top 0,
 * matching width/height, zIndex 0) and keep the HUD stacked above
 * (relative, zIndex 1). Headless-safe: returns false when the DOM or
 * either canvas is unavailable. Never throws.
 *
 * Accepts either a document or a canvas as the first arg (plus an optional
 * explicit HUD canvas): `syncGpuCanvasToHud(doc)`,
 * `syncGpuCanvasToHud(doc, hud)`, `syncGpuCanvasToHud(hudCanvas)`.
 */
export function syncGpuCanvasToHud(docOrCanvas?: unknown, hudArg?: unknown): boolean {
  try {
    let doc: DocLike | null = null;
    if (docOrCanvas !== undefined && docOrCanvas !== null && isDocLike(docOrCanvas)) {
      doc = docOrCanvas;
    } else if (docOrCanvas !== undefined && docOrCanvas !== null && isCanvasLike(docOrCanvas)) {
      doc = resolveDoc(undefined);
    } else {
      doc = resolveDoc(docOrCanvas);
    }
    let hud: CanvasLike | null = null;
    if (hudArg !== undefined && hudArg !== null && isCanvasLike(hudArg)) {
      hud = hudArg;
    } else if (docOrCanvas !== undefined && docOrCanvas !== null && isCanvasLike(docOrCanvas) && !isDocLike(docOrCanvas)) {
      hud = docOrCanvas;
    }
    if (!doc) return false;
    if (!hud) hud = findHudCanvas(doc);
    if (!hud) return false;
    const gl = findGpuCanvas(doc);
    if (!gl) return false;
    syncCanvasPair(gl, hud);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a HUD canvas from a doc, a canvas, or the global document. */
function resolveHudCanvas(target: unknown): CanvasLike | null {
  try {
    if (target !== undefined && target !== null && isCanvasLike(target) && !isDocLike(target)) {
      return target;
    }
    const d = isDocLike(target) ? target : resolveDoc(undefined);
    if (!d) return null;
    return findHudCanvas(d);
  } catch {
    return null;
  }
}

/**
 * Toggle the HUD canvas CSS background between `transparent` (GPU mode: the
 * GL scene shows through the transparent overlay ImageData — the `#q2`
 * stylesheet `background:#000` would otherwise paint black over it) and
 * `''` (CPU mode: stylesheet black restored). Headless-safe: returns false
 * when no HUD canvas/style is available. Never throws.
 *
 * The first arg may be the HUD canvas itself, its owner document, or
 * undefined (global document lookup).
 */
export function setHudTransparent(target: unknown, on: boolean): boolean {
  try {
    const hud = resolveHudCanvas(target);
    if (!hud) return false;
    if (!hud.style) {
      (hud as { style?: Record<string, string> }).style = {};
    }
    (hud.style as Record<string, string>)['background'] = on ? 'transparent' : '';
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove (or, when removal is unsupported, hide via `display:none`) the GL
 * canvas for CPU fallback, and restore the HUD canvas stacking overrides
 * (`position`/`zIndex` back to `''` when they carry the GPU values).
 * Headless-safe: returns false when no GL canvas is found. Never throws.
 */
export function removeGpuCanvas(doc?: unknown): boolean {
  try {
    const d = isDocLike(doc) ? doc : resolveDoc(doc);
    if (!d) return false;
    const gl = findGpuCanvas(d);
    if (!gl) return false;
    try {
      const node = gl as RemovableLike & {
        parentNode?: { removeChild?: (n: unknown) => void } | null;
      };
      if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
        node.parentNode.removeChild(gl);
      } else if (typeof node.remove === 'function') {
        node.remove();
      } else {
        if (!gl.style) {
          (gl as { style?: Record<string, string> }).style = {};
        }
        (gl.style as Record<string, string>)['display'] = 'none';
      }
    } catch {
      try {
        if (!gl.style) {
          (gl as { style?: Record<string, string> }).style = {};
        }
        (gl.style as Record<string, string>)['display'] = 'none';
      } catch {
        /* hide best-effort */
      }
    }
    try {
      const hud = findHudCanvas(d);
      const hs = hud?.style;
      if (hs) {
        if (hs['zIndex'] === '1') hs['zIndex'] = '';
        if (hs['position'] === 'relative') hs['position'] = '';
      }
    } catch {
      /* stacking restore best-effort */
    }
    return true;
  } catch {
    return false;
  }
}

/** Alias for `removeGpuCanvas` (CPU-fallback hide path). */
export function hideGpuCanvas(doc?: unknown): boolean {
  return removeGpuCanvas(doc);
}
