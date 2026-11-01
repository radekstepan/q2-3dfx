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
      getExtension?: (name: string) => unknown;
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
    // Release the probe context immediately: every probe burns one of the
    // page's live WebGL contexts until GC, so repeated selection checks
    // (boot/switch/panel) would exhaust the budget and force a spurious
    // software fallback while the menu still shows the WebGL request.
    try {
      const ext =
        typeof gl.getExtension === 'function'
          ? (gl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)
          : null;
      if (ext !== null && typeof ext.loseContext === 'function') ext.loseContext();
    } catch {
      /* release best-effort: the probe result above still stands */
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
 * Renderer ids offered in the menu dropdown: every backend this device can
 * actually run. WebGL2 is listed only when the capability probe passes —
 * offering it on a WebGL-less browser is a dead choice that silently falls
 * back to software. The saved cvar value is NOT rewritten here (a persisted
 * webgl choice stays stored and takes effect again once the browser can do
 * WebGL); the panel row still shows the saved value with the fallback reason
 * when it can't be honored. Probes are free (released immediately), so this
 * is safe to call per render. Never throws.
 */
export function offeredRendererOptions(): ResolvedBackend[] {
  try {
    return detectGpuCapability().available
      ? ['software', 'webgl2-experimental']
      : ['software'];
  } catch {
    return ['software'];
  }
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
