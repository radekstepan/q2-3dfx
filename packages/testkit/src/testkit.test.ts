import { describe, expect, it } from 'vitest';
import { NullRefresh, createFramebuffer, devroomView, devroomWorld } from '@q2/renderer-api';
import {
  compareGolden,
  formatLedgerRow,
  hashFrame,
  renderGolden,
  runBench,
  syntheticFill,
} from './index.js';

describe('golden-frame harness', () => {
  it('fixed camera renders deterministically (same hash twice)', () => {
    const mk = (): string => {
      const r = new NullRefresh();
      const fb = createFramebuffer(64, 48, true);
      r.init(fb);
      const { result } = renderGolden(r, devroomView(0), devroomWorld(), [], 'devroom');
      return result.hash;
    };
    expect(mk()).toBe(mk());
  });

  it('camera moves change the frame', () => {
    const render = (x: number): string => {
      const r = new NullRefresh();
      const fb = createFramebuffer(64, 48, true);
      r.init(fb);
      const view = devroomView(0);
      view.origin = new Float32Array([x, 0, 48]) as typeof view.origin;
      return renderGolden(r, view, devroomWorld(), [], 'devroom').result.hash;
    };
    expect(render(0)).not.toBe(render(64));
  });

  it('compareGolden passes identical frames, flags different ones', () => {
    const a = new Uint32Array([1, 2, 3]);
    const b = new Uint32Array([1, 2, 3]);
    const c = new Uint32Array([1, 2, 4]);
    expect(compareGolden(a, b).pass).toBe(true);
    expect(compareGolden(a, c).pass).toBe(false);
    expect(compareGolden(a, c).diff).toBe(1);
  });

  it('voodoo tolerance forgives 1-LSB dither', () => {
    const a = new Uint32Array([0xff010101]);
    const b = new Uint32Array([0xff020202]);
    expect(compareGolden(a, b, 'software').pass).toBe(false);
    expect(compareGolden(a, b, 'voodoo').pass).toBe(true);
  });
});

describe('bench runner', () => {
  it('measures Mpixel/s and formats a ledger row', () => {
    const fb = createFramebuffer(64, 48, true);
    const sample = runBench('fill', fb.color.length, 10, () => syntheticFill(fb.color, 1));
    expect(sample.mpixelsPerSec).toBeGreaterThan(0);
    expect(sample.msPerFrame).toBeGreaterThan(0);
    const row = formatLedgerRow(sample, 'abc123', 'software', 'unit test');
    expect(row).toContain('abc123');
    expect(row).toContain('software');
    expect(hashFrame(fb.color)).toMatch(/^[0-9a-f]{8}$/);
  });
});
