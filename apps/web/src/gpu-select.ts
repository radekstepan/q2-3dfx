// q2ts-web GPU selection/plumbing (GPU-PROOF-2, selection only).
//
// This lane owns the DOM probe + selection wiring. Browser glue owns
// canvas/context acquisition; the GPU backend owns GL resources. Only this
// module (plus @q2/webgl-renderer) may touch browser graphics types —
// everything else in apps/web and all CPU packages stays DOM-free.
//
// PROOF-2 draws nothing: selecting 'webgl2-experimental' records the
// selection on the boot, but pixels still come from the CPU SoftwareRenderer
// + CPU resolve path until PROOF-3 lands GPU drawing.
import { getCVarString } from '@q2/config';
import { resolveRendererSelection } from '@q2/renderer-api';
import type { GpuCapability, ResolvedBackend } from '@q2/renderer-api';

/** Experimental GPU backend id (mirrors GpuBackendId in @q2/renderer-api). */
export const GPU_BACKEND_ID = 'webgl2-experimental' as const;

/**
 * DOM probe for WebGL2 capability. Headless-safe: under vitest/Node there is
 * no DOM canvas, so this returns unavailable (with a reason) and never
 * throws. Guarded try/catch throughout — a hostile or partial DOM still
 * yields unavailable, never an exception.
 */
export function detectGpuCapability(): GpuCapability {
  try {
    const g = globalThis as unknown as {
      document?: { createElement?: (tag: string) => unknown };
    };
    const doc = typeof document !== 'undefined' ? document : g.document;
    if (!doc || typeof doc.createElement !== 'function') {
      return { backend: GPU_BACKEND_ID, available: false, reason: 'no WebGL2 context' };
    }
    const canvas = doc.createElement('canvas') as {
      getContext?: (kind: string) => unknown;
    };
    if (!canvas || typeof canvas.getContext !== 'function') {
      return { backend: GPU_BACKEND_ID, available: false, reason: 'no WebGL2 context' };
    }
    const gl = canvas.getContext('webgl2') as {
      getParameter?: (p: number) => unknown;
      VERSION?: number;
    } | null;
    if (!gl) {
      return { backend: GPU_BACKEND_ID, available: false, reason: 'no WebGL2 context' };
    }
    let version = 'webgl2';
    try {
      if (typeof gl.getParameter === 'function' && typeof gl.VERSION === 'number') {
        version = String(gl.getParameter(gl.VERSION));
      }
    } catch {
      version = 'webgl2';
    }
    return { backend: GPU_BACKEND_ID, available: true, reason: version };
  } catch {
    return { backend: GPU_BACKEND_ID, available: false, reason: 'no WebGL2 context' };
  }
}

/**
 * Selection resolver shared by `bootPlay` and `applyRendererCvar`: exact
 * `software`/`webgl2-experimental` strings map directly (GPU only
 * when capable, via `resolveRendererSelection`); the retired `voodoo` id
 * migrates one-time to `software` WITH an explicit warning (never
 * auto-promoted); anything else — including a GPU request without
 * capability — resolves to `software` WITH an explicit warning (never a
 * silent CPU fallback). Defaults to the live
 * `vid_renderer` cvar; callers may pass an explicit request (e.g. the
 * `bootPlay` opts.renderer override) which goes through the same
 * capability check.
 */
export function resolveBootRenderer(requested?: string): {
  kind: ResolvedBackend;
  warning: string | null;
} {
  const raw = requested ?? getCVarString('vid_renderer');
  const sel = resolveRendererSelection(raw, detectGpuCapability());
  return { kind: sel.active, warning: sel.warning };
}

/**
 * GPU observability for tests/debug (and future benchmark gating).
 * `active` echoes the boot's recorded selection, `warning` its recorded
 * fallback warning (null when honored).
 *
 * Benchmark rule: a GPU-labeled leg with `active != 'webgl2-experimental'`
 * is VOID — it measured the CPU fallback, not the GPU backend. Gate
 * benchmark legs on this status, never on the requested cvar alone.
 */
export function getGpuStatus(boot: {
  renderer: ResolvedBackend;
  lastRendererWarning: string | null;
}): GpuCapability & { active: ResolvedBackend; warning: string | null } {
  const gpu = detectGpuCapability();
  return { ...gpu, active: boot.renderer, warning: boot.lastRendererWarning };
}
