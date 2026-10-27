// Demo1-era fallback fixture: asset-free, CI-safe (no Q2_PAK).
import { describe, expect, it } from 'vitest';
import { NullRefresh, createFramebuffer, devroomWorld } from '@q2/renderer-api';
import { DEMO_FALLBACK_MAP, demoFallbackViews, demoFallbackWorld } from './demo-fallback.js';
import { renderGolden } from './index.js';

describe('demo1-era fallback (asset-free)', () => {
  it('is the procedural devroom (never a retail asset)', () => {
    expect(DEMO_FALLBACK_MAP).toBe('maps/devroom');
    expect(demoFallbackWorld()).toEqual(devroomWorld());
  });

  it('every fallback camera renders deterministically headlessly', () => {
    const views = demoFallbackViews();
    expect(views).toHaveLength(3);
    const hashes = new Set<string>();
    for (const { name, view } of views) {
      const once = (): string => {
        const r = new NullRefresh();
        r.init(createFramebuffer(64, 48, true));
        return renderGolden(r, view, devroomWorld(), [], name).result.hash;
      };
      const h = once();
      expect(once()).toBe(h); // deterministic: same hash twice
      expect(h).toMatch(/^[0-9a-f]{8}$/);
      hashes.add(h);
    }
    expect(hashes.size).toBe(views.length); // cameras actually differ
  });
});
