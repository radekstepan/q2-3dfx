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
    // Same framebuffer size; GL below the 2D/HUD canvas. Absolute WITHOUT
    // left/top keeps the static position (right where `#q2` starts, since it
    // is inserted immediately before it); the HUD canvas goes relative (no
    // offsets, layout unchanged) with a higher z-index.
    try {
      if (width > 0) canvas.width = width;
      if (height > 0) canvas.height = height;
      if (!canvas.style) {
        (canvas as { style?: Record<string, string> }).style = {};
      }
      const st = canvas.style as Record<string, string>;
      st['position'] = 'absolute';
      st['zIndex'] = '0';
      const hs = hud?.style;
      if (hs) {
        if (!hs['position']) hs['position'] = 'relative';
        hs['zIndex'] = '1';
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
