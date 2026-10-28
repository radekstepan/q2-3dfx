// Track A: resolveDisplayAsync pooled scanout is byte-identical to serial.
import { describe, expect, it } from 'vitest';
import { resetCVars, setCVar, setCVarFromString } from '@q2/config';
import { bootPlay, resolveDisplay, resolveDisplayAsync } from './play.js';
import { BandWorkerPool } from '@q2/sw-renderer';

function sandbox(): void {
  resetCVars();
  setCVarFromString('vid_renderer', 'voodoo');
  setCVar('vd_gamma', 1.3);
  setCVar('vd_dither', 1);
  setCVar('vd_16bit', 1);
  setCVar('vd_postfilter', 1);
  setCVarFromString('vd_dithermode', '4x4');
  setCVarFromString('vd_reconmode', '2x2sub+2x2box');
  setCVarFromString('vd_rgbmaxdelta', '8,8,8');
  setCVar('sw_workers', 0);
}

function paintGradient(boot: ReturnType<typeof bootPlay>): void {
  const live = boot.refresh.getFramebuffer().color;
  const w = boot.host.fb.width, h = boot.host.fb.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      live[i] = (0xff000000 | (((x * 3) & 255) << 16) | (((y * 5) & 255) << 8) | ((x + y) & 255)) >>> 0;
    }
  }
}

describe('resolveDisplayAsync pooled scanout (Track A)', () => {
  it('serial async matches sync serial without a pool', async () => {
    sandbox();
    const boot = bootPlay({ width: 64, height: 48 });
    try {
      paintGradient(boot);
      const a = Array.from(resolveDisplay(boot));
      paintGradient(boot);
      const b = Array.from(await resolveDisplayAsync(boot));
      expect(b).toEqual(a);
      expect(boot.lastVoodooPath).toBe('serial');
    } finally {
      resetCVars();
    }
  });

  it('pooled async matches sync serial, path is worker', async () => {
    const dist = new URL('../../../packages/sw-renderer/dist/index.mjs', import.meta.url).pathname;
    sandbox();
    const boot = bootPlay({ width: 64, height: 48 });
    const pool = BandWorkerPool.create(3, 64, 48, { indexJsPath: dist });
    if (!pool) throw new Error('pool create failed');
    try {
      setCVar('sw_workers', 4);
      boot.refresh.syncWorkersFromCvar();
      boot.refresh.attachWorkerPool(pool as unknown as never);
      (boot as unknown as Record<string, unknown>).browserPool = pool;
      // Adopt shared scanout buffers like attachBrowserPool does.
      const sp = (pool as unknown as { scanoutPlanes: { scan565: Uint16Array; scanDisplay: Uint32Array } }).scanoutPlanes;
      boot.fb565 = sp.scan565;
      boot.display = sp.scanDisplay;
      paintGradient(boot);
      const serial = Array.from(resolveDisplay(boot));
      expect(boot.lastVoodooPath).toBe('serial');
      paintGradient(boot);
      const pooled = Array.from(await resolveDisplayAsync(boot));
      expect(pooled).toEqual(serial);
      expect(boot.lastVoodooPath).toBe('worker');
      // HUD-before-scanout preserved: strict mode composes HUD into the
      // target, so a HUD frame differs from the scene-only frame.
      paintGradient(boot);
      const withHud = Array.from(await resolveDisplayAsync(boot, { fps: 60, frame: 1 }));
      expect(withHud).not.toEqual(serial);
    } finally {
      await pool.dispose();
      resetCVars();
    }
  });
});
