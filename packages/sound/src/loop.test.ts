// R9F-9 — looped speaker channels in the headless Mixer.
//
// Loop records (server st.sounds entries with loop:true) map to
// loop:true Mixer channels: they start/stop with the record, their origin
// tracks the record position across ticks, and they share the single 0.05
// master scale point with one-shots (never double-scaled, never disturbed).
import { describe, expect, it, beforeEach } from 'vitest';
import { ATTN_NORM, Mixer } from './index.js';
import { resetCVars, setCVar } from '@q2/config';

beforeEach(() => {
  resetCVars();
});

function startLoop(m: Mixer, name: string, origin: [number, number, number]): number {
  return m.startSound({
    origin,
    fixedOrigin: true,
    entnum: 0,
    attenuation: ATTN_NORM,
    masterVol: 1,
    loop: true,
    name,
  });
}

describe('Mixer loop channels (R9F-9)', () => {
  it('loop channels start and mix with position/pan like one-shots', () => {
    const m = new Mixer();
    m.setListener([0, 0, 0], [0, 1, 0]);
    const id = startLoop(m, 'world/amb1.wav', [0, 0, 0]);
    expect(id).toBeGreaterThan(0);
    expect(m.channelCount).toBe(1);
    const mixed = m.mix();
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.loop).toBe(true);
    expect(mixed[0]!.name).toBe('world/amb1.wav');
    // Full volume at the listener: the single 0.05 scale point, split
    // across both ears at pan 0 (left + right = 0.05).
    expect(mixed[0]!.left).toBeCloseTo(0.025, 9);
    expect(mixed[0]!.right).toBeCloseTo(0.025, 9);
  });

  it('origin updates apply on the next mix (position sync across ticks)', () => {
    const m = new Mixer();
    m.setListener([0, 0, 0], [0, 1, 0]);
    const id = startLoop(m, 'world/amb1.wav', [500, 0, 0]);
    const near = m.mix().find((c) => c.id === id)!;
    expect(near).toBeDefined();
    expect(near.left).toBeGreaterThan(0);
    // Tick 2: the record position moved out of earshot — the same channel
    // goes silent (dropped from mix, exactly like a silent one-shot) but
    // is NOT removed.
    m.updateSoundOrigin(id, [5000, 0, 0]);
    expect(m.mix().some((c) => c.id === id)).toBe(false);
    expect(m.channelCount).toBe(1);
    // Tick 3: back in range — same id, same gains as tick 1, no restart.
    m.updateSoundOrigin(id, [500, 0, 0]);
    const back = m.mix().find((c) => c.id === id)!;
    expect(back).toBeDefined();
    expect(back.left).toBeCloseTo(near.left, 9);
    expect(back.right).toBeCloseTo(near.right, 9);
    expect(back.dist).toBeCloseTo(near.dist, 9);
  });

  it('stopSound removes the loop channel (toggle-off); unknown ids are safe', () => {
    const m = new Mixer();
    m.setListener([0, 0, 0], [0, 1, 0]);
    const id = startLoop(m, 'world/amb1.wav', [100, 0, 0]);
    expect(m.mix().some((c) => c.id === id)).toBe(true);
    m.stopSound(id);
    expect(m.mix().some((c) => c.id === id)).toBe(false);
    expect(m.channelCount).toBe(0);
    expect(() => m.updateSoundOrigin(id, [0, 0, 0])).not.toThrow();
    expect(() => m.updateSoundOrigin(99999, [0, 0, 0])).not.toThrow();
  });

  it('one-shot mixing is unaffected by loop churn', () => {
    const m = new Mixer();
    m.setListener([0, 0, 0], [0, 1, 0]);
    const one = m.startSound({
      origin: [500, 0, 0],
      fixedOrigin: true,
      entnum: 0,
      attenuation: ATTN_NORM,
      masterVol: 1,
      loop: false,
      name: 'weapons/shot.wav',
    });
    const pin = (id: number): number => m.mix().find((c) => c.id === id)!.left;
    const before = pin(one);
    // Loop starts, moves, and stops around the one-shot: its gains never move.
    const lid = startLoop(m, 'world/amb1.wav', [500, 0, 0]);
    expect(pin(one)).toBeCloseTo(before, 9);
    m.updateSoundOrigin(lid, [900, 0, 0]);
    expect(pin(one)).toBeCloseTo(before, 9);
    m.stopSound(lid);
    expect(pin(one)).toBeCloseTo(before, 9);
    expect(m.mix().some((c) => c.loop)).toBe(false);
  });

  it('loop gains obey the single 0.05 master scale point', () => {
    const m = new Mixer();
    m.setListener([0, 0, 0], [0, 1, 0]);
    setCVar('s_volume', 1);
    m.syncMasterVolFromConfig();
    startLoop(m, 'world/amb1.wav', [0, 0, 0]);
    const full = m.mix()[0]!;
    expect(full.left).toBeLessThanOrEqual(0.0500001);
    expect(full.left + full.right).toBeCloseTo(0.05, 9);
    setCVar('s_volume', 0.5);
    m.syncMasterVolFromConfig();
    const half = m.mix()[0]!;
    expect(half.left + half.right).toBeCloseTo(0.025, 9);
    expect(m.effectiveOutputGain).toBeCloseTo(0.025, 9);
  });
});
