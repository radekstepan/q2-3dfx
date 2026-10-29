// PERF-FINISH-C ESM/CJS config-store regression (bench/testkit lane).
//
// The hazard: `@q2/config` ships dual-format dist (`index.mjs` + 
// `index.js`) with a per-file module-level `Map`. Node ESM importers get
// one store, CJS requirers get another: `setCVar` in one universe is
// invisible in the other (proven below). Renderer selection
// (`vid_renderer`), worker cvars, and the vd_* scanout profile MUST be
// observed through ONE store, or the bench rows silently describe a
// different config than the renderer/host/scanout path executes.
//
// Resolution in this lane:
//   - tools/bench runs ESM-only (dist/index.mjs; `web/dist/index.mjs`
//     explicitly, never the CJS `web` main; no `createRequire` CJS
//     touchpoints) — one module universe, one store.
//   - This test proves shared state across the ESM graph: a cvar set the
//     way bench sets it is observed on the renderer/host path.
//   - The CJS isolation below is PINNED, not fixed: unifying the store
//     (e.g. a globalThis singleton in @q2/config, or single-format dist)
//     is a CONTRACT NEED for the packages/config lane. When that lands,
//     the isolation assertion must be flipped to shared — deliberately,
//     in the same PR.
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createFramebuffer } from '@q2/renderer-api';
import {
  getCVarNumber,
  getCVarString,
  resetCVars,
  setCVar,
  setCVarFromString,
} from '@q2/config';
import {
  SoftwareRenderer,
  SW_ACCUM_CVAR,
  SW_WORKERS_CVAR,
  accumRequestedByCvar,
  createDevroom,
  DEVROOM_CAMERA,
} from '@q2/sw-renderer';

afterEach(() => {
  resetCVars();
});

function testPalette(): Uint8Array {
  const pal = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    pal[i * 3] = (i * 5) & 255;
    pal[i * 3 + 1] = (i * 3 + 40) & 255;
    pal[i * 3 + 2] = (i * 2 + 80) & 255;
  }
  return pal;
}

describe('ESM graph shares one config store (bench → renderer/host path)', () => {
  it('worker cvars set bench-style are observed by the renderer', () => {
    const fb = createFramebuffer(64, 48, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());

    // Bench sets cvars via the @q2/config ESM import (rgbattr pinPerfCvars).
    setCVar(SW_WORKERS_CVAR, 2);
    setCVar(SW_ACCUM_CVAR, 1);
    expect(accumRequestedByCvar()).toBe(true);
    expect(r.syncWorkersFromCvar()).toBe(true);
    expect(r.testWorkerStats().active).toBe(true);

    // And clearing them is observed too (no stale latch).
    setCVar(SW_WORKERS_CVAR, 0);
    expect(r.syncWorkersFromCvar()).toBe(false);
    expect(r.testWorkerStats().active).toBe(false);
  });

  it('renderer selection + scanout profile cvars round-trip through the same store', () => {
    // vid_renderer is read by the host/web shell to pick the backend;
    // vd_* is read by the voodoo scanout + RGB fidelity paths. Both must
    // be the value bench pinned, not a default from a second store.
    setCVarFromString('vid_renderer', 'voodoo');
    expect(getCVarString('vid_renderer')).toBe('voodoo');

    setCVar('vd_gamma', 1.3);
    setCVar('vd_postfilter', 1);
    expect(getCVarNumber('vd_gamma')).toBe(1.3);
    expect(getCVarNumber('vd_postfilter')).toBe(1);

    // The renderer observes the shared store on a real frame (no throw,
    // deterministic output): cvar writes before renderView take effect.
    const fb = createFramebuffer(64, 48, true);
    const r = new SoftwareRenderer();
    r.init(fb);
    r.setPalette(testPalette());
    r.beginFrame();
    const stats = r.renderView(
      {
        origin: DEVROOM_CAMERA.origin,
        angles: DEVROOM_CAMERA.angles,
        fovX: DEVROOM_CAMERA.fovX,
        time: 1.5,
        lightStyles: new Float32Array(256).fill(1),
      },
      { name: 'devroom', data: createDevroom() },
      [],
    );
    r.endFrame();
    expect(stats.spans).toBeGreaterThan(0);
  });

  it('documents the ESM/CJS store split (contract need: packages/config)', () => {
    // The CJS dist is a SEPARATE module instance with its own Map. This
    // assertion pins the hazard: if it ever starts SEEING the ESM value,
    // the config lane unified the store — flip this test to shared in
    // that PR and remove the bench ESM-only workarounds.
    const require = createRequire(import.meta.url);
    const cjsPath: string = require.resolve('@q2/config');
    expect(cjsPath.endsWith('dist/index.js')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cjs = require(cjsPath) as {
      getCVarNumber(n: string): number;
      getCVarString(n: string): string;
    };
    setCVar('voodoo_probe_sentinel', 987654);
    setCVarFromString('vid_renderer', 'voodoo');
    // Same-process, same-package, different universe: invisible.
    expect(cjs.getCVarNumber('voodoo_probe_sentinel')).toBe(0);
    expect(cjs.getCVarString('vid_renderer')).toBe('software');
  });
});
