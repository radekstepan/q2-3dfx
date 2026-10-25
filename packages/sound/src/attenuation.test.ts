import { describe, expect, it } from 'vitest';
import {
  ATTN_IDLE,
  ATTN_NONE,
  ATTN_NORM,
  ATTN_STATIC,
  Mixer,
  SOUND_FULLVOLUME,
  attenuation,
  spatialize,
} from './index.js';

describe('Q2 positional sound attenuation curves', () => {
  it('full volume inside SOUND_FULLVOLUME for all classes', () => {
    for (const attn of [ATTN_NONE, ATTN_NORM, ATTN_IDLE, ATTN_STATIC]) {
      expect(attenuation(0, attn)).toBe(1);
      expect(attenuation(SOUND_FULLVOLUME, attn)).toBe(1);
    }
  });

  it('ATTN_NONE never attenuates', () => {
    expect(attenuation(100000, ATTN_NONE)).toBe(1);
  });

  it('linear falloff scaled by class: idle/static die faster', () => {
    const d = SOUND_FULLVOLUME + 500;
    const norm = attenuation(d, ATTN_NORM);
    const idle = attenuation(d, ATTN_IDLE);
    const stat = attenuation(d, ATTN_STATIC);
    expect(norm).toBeCloseTo(0.5, 9);
    expect(idle).toBeCloseTo(0, 9);
    expect(stat).toBe(0);
    expect(norm).toBeGreaterThan(idle);
  });

  it('clamps at zero far away', () => {
    expect(attenuation(1e9, ATTN_NORM)).toBe(0);
  });

  it('spatialize pans hard left/right and centers ahead', () => {
    const origin = [0, 0, 0];
    // Listener faces +X; right vector is -Y in Q2 coords... use explicit axes.
    const right: [number, number, number] = [0, 1, 0];
    const ahead = spatialize(origin, right, [100, 0, 0]);
    expect(ahead.left).toBeCloseTo(ahead.right, 9);
    const rightSide = spatialize(origin, right, [0, 100, 0]);
    expect(rightSide.right).toBeGreaterThan(rightSide.left);
    const leftSide = spatialize(origin, right, [0, -100, 0]);
    expect(leftSide.left).toBeGreaterThan(leftSide.right);
    expect(leftSide.left).toBeCloseTo(rightSide.right, 9);
  });

  it('mixer keeps local player full-volume, drops silent channels', () => {
    const m = new Mixer();
    m.setListener([0, 0, 0], [0, 1, 0]);
    m.startSound({
      origin: [5000, 0, 0],
      fixedOrigin: false,
      entnum: 1,
      attenuation: ATTN_NORM,
      masterVol: 1,
      loop: false,
      name: 'self/blaster.wav',
    });
    m.startSound({
      origin: [1e6, 0, 0],
      fixedOrigin: true,
      entnum: 0,
      attenuation: ATTN_NORM,
      masterVol: 1,
      loop: false,
      name: 'world/far.wav',
    });
    expect(m.channelCount).toBe(2);
    const mixed = m.mix();
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.left).toBe(1);
    expect(mixed[0]!.right).toBe(1);
  });
});
