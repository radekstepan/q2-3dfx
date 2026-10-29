// ab spec parsing pins (PERF-NEXT-6 Lane C, bench lane).
//
// Pure/hermetic: no pak, no workers, no wall-clock. Pins that leg specs
// parse fully ("scene,res,entities,mode,workers"), clamp workers to 0..8,
// and fall back per-field (never a void leg from one bad field).
import { describe, expect, it } from 'vitest';
import { parseABLegSpec } from './ab.js';

describe('parseABLegSpec', () => {
  it('parses a full leg spec', () => {
    expect(parseABLegSpec('spawn-north,640x480,combat,rgb,7', 'x')).toEqual({
      scene: 'spawn-north', width: 640, height: 480,
      entities: 'combat', mode: 'rgb', workers: 7,
    });
  });
  it('parses a serial software leg', () => {
    expect(parseABLegSpec('trench-east,320x240,fixed,software,0', 'x')).toEqual({
      scene: 'trench-east', width: 320, height: 240,
      entities: 'fixed', mode: 'software', workers: 0,
    });
  });
  it('clamps workers to 0..8 and falls back per field', () => {
    expect(parseABLegSpec('bogus,64x64,bogus,bogus,99', 'x')).toEqual({
      scene: 'spawn-north', width: 64, height: 64,
      entities: 'combat', mode: 'rgb', workers: 8,
    });
    expect(parseABLegSpec('spawn-north,640x480,combat,rgb,-1', 'x').workers).toBe(0);
  });
  it('uses the fallback spec when env is absent', () => {
    expect(parseABLegSpec(undefined, 'spawn-north,640x480,combat,rgb,3')).toEqual({
      scene: 'spawn-north', width: 640, height: 480,
      entities: 'combat', mode: 'rgb', workers: 3,
    });
  });
});
