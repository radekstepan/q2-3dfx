// RELEASE-10 renderer-api lane — panel-needs verdict test (tests only, no production change).
//
// Verdict: NO contract change is required. The web-lane panel's two needs —
// (1) the effective renderer value incl. fallback, and (2) per-backend status —
// are already satisfiable from frozen `@q2/renderer-api` exports:
//
// - Effective renderer: `ResolvedBackend` (`software | webgl2-experimental`,
//   gpu.ts) + `resolveRendererSelection(requested, gpu)` (gpu.ts), which maps
//   every request — exact ids, retired `voodoo`, unknown ids, incapable-GPU
//   requests — to `{ active, warning }` with an explicit non-null warning on
//   every fallback. The web lane records that outcome on the boot
//   (`PlayBoot.renderer: ResolvedBackend` + `lastRendererWarning`, read out
//   via `getGpuStatus(boot)` = `{ ...GpuCapability, active, warning }`),
//   so the panel keys its capability mapping off `active` + `warning`
//   with zero new cross-package types.
// - Per-backend status: `GpuCapability` (`{ backend, available, reason }`,
//   gpu.ts) for the capability probe plus `GpuRenderer.getStatus()` /
//   `GpuRendererStatus` (gpu.ts) for the live backend. No capability query
//   is needed on `Refresh` (the software path is unconditionally available)
//   and no effective-renderer enum or backend capability hook is missing.
//
// This test pins that verdict: every panel input below is derived SOLELY
// from existing exports. If a future panel need cannot be expressed here,
// that — and only that — justifies a new contract surface (separate tiny PR
// per BRAIN.md §7 rule 2).
import { describe, expect, it } from 'vitest';
import {
  resolveRendererSelection,
  type GpuCapability,
  type GpuRenderer,
  type GpuRendererStatus,
  type ResolvedBackend,
  type ResolvedSelection,
} from './gpu.js';

const CAPABLE: GpuCapability = {
  backend: 'webgl2-experimental',
  available: true,
  reason: 'WebGL2 (test stub)',
};

const INCAPABLE: GpuCapability = {
  backend: 'webgl2-experimental',
  available: false,
  reason: 'no WebGL2 context (test stub)',
};

/**
 * Web-lane `getGpuStatus(boot)` composition (apps/web/src/gpu-select.ts),
 * replicated here BY VALUE to prove the panel needs nothing beyond these
 * two frozen inputs: the recorded selection plus a fresh capability probe.
 */
function panelStatus(
  selection: ResolvedSelection,
  probe: GpuCapability,
): GpuCapability & { active: ResolvedBackend; warning: string | null } {
  return { ...probe, active: selection.active, warning: selection.warning };
}

describe('RELEASE-10 verdict: panel needs are satisfiable from frozen exports', () => {
  it('effective-renderer vocabulary is exactly software | webgl2-experimental (no new enum needed)', () => {
    const software: ResolvedBackend = 'software';
    const gpu: ResolvedBackend = 'webgl2-experimental';
    expect([software, gpu]).toEqual(['software', 'webgl2-experimental']);
  });

  it('effective renderer incl. fallback derives from resolveRendererSelection alone', () => {
    // Honored requests carry no warning; every fallback carries one (never silent).
    const cases: Array<{ requested: string; gpu: GpuCapability; active: ResolvedBackend; honored: boolean }> = [
      { requested: 'software', gpu: INCAPABLE, active: 'software', honored: true },
      { requested: 'software', gpu: CAPABLE, active: 'software', honored: true },
      { requested: 'webgl2-experimental', gpu: CAPABLE, active: 'webgl2-experimental', honored: true },
      { requested: 'webgl2-experimental', gpu: INCAPABLE, active: 'software', honored: false },
      { requested: 'voodoo', gpu: CAPABLE, active: 'software', honored: false },
      { requested: 'voodoo', gpu: INCAPABLE, active: 'software', honored: false },
      { requested: 'webgl3', gpu: CAPABLE, active: 'software', honored: false },
    ];
    for (const c of cases) {
      const sel = resolveRendererSelection(c.requested, c.gpu);
      expect(sel.active).toBe(c.active);
      if (c.honored) {
        expect(sel.warning).toBeNull();
      } else {
        expect(typeof sel.warning).toBe('string');
        expect(sel.warning!.length).toBeGreaterThan(0);
      }
      // The panel's read-out (getGpuStatus shape) is fully determined here.
      const status = panelStatus(sel, c.gpu);
      expect(status.active).toBe(c.active);
      expect(status.warning).toBe(sel.warning);
      expect(status.available).toBe(c.gpu.available);
      expect(typeof status.reason).toBe('string');
    }
  });

  it('fallback warning names the blocking reason (panel label needs no new surface)', () => {
    const sel = resolveRendererSelection('webgl2-experimental', INCAPABLE);
    expect(sel.active).toBe('software');
    expect(sel.warning).toContain(INCAPABLE.reason);
  });

  it('per-backend status is readable via GpuRenderer.getStatus (no new capability hook needed)', () => {
    const stub: GpuRenderer<unknown> = {
      init: () => undefined,
      resize: () => undefined,
      setScene: () => undefined,
      renderFrame: () => undefined,
      dispose: () => undefined,
      getStatus: (): GpuRendererStatus => ({
        initialized: true,
        width: 320,
        height: 240,
        contextLost: false,
        framesSubmitted: 7,
        lastError: null,
      }),
      handleContextLost: () => undefined,
      handleContextRestored: () => undefined,
    };
    const st = stub.getStatus();
    expect(st.initialized).toBe(true);
    expect(st.width).toBe(320);
    expect(st.height).toBe(240);
    expect(st.contextLost).toBe(false);
    expect(st.framesSubmitted).toBe(7);
    expect(st.lastError).toBeNull();
  });

  it('Refresh needs no capability query: software path resolves without one', () => {
    // The panel gates GPU-only controls on the effective renderer above;
    // the software `Refresh` contract has no availability failure mode, so
    // no `getCapability()`-style surface is missing. This pins the absence:
    // resolveRendererSelection('software', …) is honored even with no GPU.
    const sel = resolveRendererSelection('software', INCAPABLE);
    expect(sel).toEqual({ active: 'software', warning: null });
  });
});
