// Demo1-era fallback boot (asset-free, CI-safe): no pak -> procedural
// devroom, which doubles as the demo1 stand-in (see devroom.ts).
import { describe, expect, it } from 'vitest';
import { DEMO_FALLBACK_MAP, bootToFirstFrame, createDevroomHost, demoFallbackCameras } from './devroom.js';
import { bootWeb } from './index.js';

describe('demo1-era fallback boot (asset-free)', () => {
  it('fallback map is the procedural devroom, never a retail asset', () => {
    expect(DEMO_FALLBACK_MAP).toBe('maps/devroom');
  });

  it('no-pak boot lands on the fallback map', () => {
    const boot = bootWeb({ width: 64, height: 48 });
    expect(boot.source).toBe('devroom');
    expect(boot.boot.host).toBeDefined();
  });

  it('fallback cameras are three distinct fixed views', () => {
    const cameras = demoFallbackCameras();
    expect(cameras.map((c) => c.name)).toEqual(['demo-spawn', 'demo-pillar', 'demo-wide']);
    const origins = new Set(cameras.map((c) => c.origin.join(',')));
    expect(origins.size).toBe(3);
    for (const cam of cameras) expect(cam.fovX).toBe(90);
  });

  it('fallback boot reaches a first frame deterministically', () => {
    const mk = (): string => bootToFirstFrame(createDevroomHost(64, 48).host).hash;
    const h = mk();
    expect(mk()).toBe(h);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });
});
