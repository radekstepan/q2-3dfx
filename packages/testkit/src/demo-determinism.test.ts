// DEMO1 determinism: scripted tick sequence over the fixed devroom
// cameras — hashed outputs (pixels + origin + time), identical reruns,
// hashes pinned (no blobs committed). Asset-free: never touches Q2_PAK;
// real demo1.dm2 playback stays gated in base1-render.test.ts.
import { describe, expect, it } from 'vitest';
import {
  DEMO_TICK_HZ,
  DEMO_TICKS_PER_CAMERA,
  demoTickManifest,
  demoTickStyle0,
  runDemoTicks,
  type DemoTickFrame,
} from './demo-determinism.js';
import { DEMO_FALLBACK_MAP, demoFallbackViews } from './demo-fallback.js';

/** Pinned 2026-10-27: 3 cameras x 6 ticks @10Hz, 160x120 SoftwareRenderer. */
const PINNED: Array<Pick<DemoTickFrame, 'camera' | 'tick' | 'colorHash' | 'indexHash'>> = [
  { camera: 'demo-spawn', tick: 0, colorHash: '8a204e64', indexHash: 'ff5a09b8' },
  { camera: 'demo-spawn', tick: 1, colorHash: 'fa26a073', indexHash: 'fc3ba4c3' },
  { camera: 'demo-spawn', tick: 2, colorHash: '8a204e64', indexHash: 'ff5a09b8' },
  { camera: 'demo-spawn', tick: 3, colorHash: 'fa26a073', indexHash: 'fc3ba4c3' },
  { camera: 'demo-spawn', tick: 4, colorHash: '8a204e64', indexHash: 'ff5a09b8' },
  { camera: 'demo-spawn', tick: 5, colorHash: 'fa26a073', indexHash: 'fc3ba4c3' },
  { camera: 'demo-pillar', tick: 0, colorHash: '4eae8420', indexHash: 'ec512fd4' },
  { camera: 'demo-pillar', tick: 1, colorHash: 'a4196369', indexHash: 'b7195fb1' },
  { camera: 'demo-pillar', tick: 2, colorHash: 'b3a6f698', indexHash: '31e9aafc' },
  { camera: 'demo-pillar', tick: 3, colorHash: '5811da29', indexHash: 'ef20dec1' },
  { camera: 'demo-pillar', tick: 4, colorHash: '65f66570', indexHash: 'dd72f434' },
  { camera: 'demo-pillar', tick: 5, colorHash: 'd12c9b35', indexHash: '47e50ced' },
  { camera: 'demo-wide', tick: 0, colorHash: '118efcd4', indexHash: '01de9a40' },
  { camera: 'demo-wide', tick: 1, colorHash: '24043902', indexHash: '3af15026' },
  { camera: 'demo-wide', tick: 2, colorHash: '65f63ff4', indexHash: 'e7c06d00' },
  { camera: 'demo-wide', tick: 3, colorHash: '0acdaaa6', indexHash: 'aef7fda2' },
  { camera: 'demo-wide', tick: 4, colorHash: '53ca2678', indexHash: '883306bc' },
  { camera: 'demo-wide', tick: 5, colorHash: '64a0a0aa', indexHash: '1fb0737e' },
];

describe('demo determinism: scripted tick sequence', () => {
  it('covers every fixed camera at the 10 Hz server tick', () => {
    expect(DEMO_TICK_HZ).toBe(10);
    const views = demoFallbackViews();
    const frames = runDemoTicks();
    expect(frames).toHaveLength(views.length * DEMO_TICKS_PER_CAMERA);
    for (const [ci, { name, view }] of views.entries()) {
      const run = frames.slice(ci * DEMO_TICKS_PER_CAMERA, (ci + 1) * DEMO_TICKS_PER_CAMERA);
      expect(run.map((f) => f.camera)).toEqual(Array(DEMO_TICKS_PER_CAMERA).fill(name));
      expect(run.map((f) => f.tick)).toEqual([0, 1, 2, 3, 4, 5]);
      for (const [tick, f] of run.entries()) {
        expect(f.time).toBe(view.time + tick / DEMO_TICK_HZ);
        if (tick > 0) expect(f.time - run[tick - 1]!.time).toBeCloseTo(1 / DEMO_TICK_HZ, 10);
        expect(f.origin).toEqual(Array.from(view.origin));
        expect(f.angles).toEqual(Array.from(view.angles));
        expect(f.style0).toBe(demoTickStyle0(tick));
        expect(f.style1).toBe(1.0);
        expect(f.colorHash).toMatch(/^[0-9a-f]{8}$/);
        expect(f.indexHash).toMatch(/^[0-9a-f]{8}$/);
      }
    }
  });

  it('reruns are identical (fresh renderer each run)', () => {
    expect(runDemoTicks()).toEqual(runDemoTicks());
  });

  it('pins every frame hash (pixels + origin + time)', () => {
    const frames = runDemoTicks();
    expect(frames.map(({ camera, tick, colorHash, indexHash }) => ({
      camera, tick, colorHash, indexHash,
    }))).toEqual(PINNED);
  });

  it('sim-time advancement moves the frame where water is visible', () => {
    // Same style slot (ticks 0 and 2 both style0=1.0), different time:
    // pillar/wide see the scrolling turbulent banner, spawn stares at a
    // static wall. Isolates time from the style flicker.
    const frames = runDemoTicks();
    const byCam = (name: string): DemoTickFrame[] => frames.filter((f) => f.camera === name);
    expect(byCam('demo-pillar')[0]!.colorHash).not.toBe(byCam('demo-pillar')[2]!.colorHash);
    expect(byCam('demo-wide')[0]!.colorHash).not.toBe(byCam('demo-wide')[2]!.colorHash);
    expect(byCam('demo-spawn')[0]!.colorHash).toBe(byCam('demo-spawn')[2]!.colorHash);
  });

  it('style-0 flicker relights every camera', () => {
    // Ticks 0 and 1 share a camera and near-identical time but different
    // style scales — every camera must move (style-scale → cache relight).
    const frames = runDemoTicks();
    for (const name of ['demo-spawn', 'demo-pillar', 'demo-wide']) {
      const run = frames.filter((f) => f.camera === name);
      expect(run[0]!.style0).toBe(1.0);
      expect(run[1]!.style0).toBe(0.75);
      expect(run[0]!.colorHash, name).not.toBe(run[1]!.colorHash);
    }
  });

  it('manifest envelope is JSON-safe and asset-free', () => {
    const manifest = demoTickManifest(runDemoTicks());
    expect(manifest.map).toBe(DEMO_FALLBACK_MAP);
    expect(manifest.map).toBe('maps/devroom');
    expect(manifest.resolution).toEqual({ width: 160, height: 120 });
    expect(manifest.hz).toBe(10);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });
});
