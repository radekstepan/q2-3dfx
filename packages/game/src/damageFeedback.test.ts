// damageFeedback arithmetic pins (game/p_view.c, cvar defaults g_save.c).
import { describe, expect, it } from 'vitest';
import {
  BOB_HEIGHT_MAX,
  DAMAGE_ALPHA_MAX,
  DAMAGE_ALPHA_MIN,
  DAMAGE_KICK_MAX,
  DAMAGE_TIME,
  DEATH_PITCH,
  DEATH_ROLL,
  accumulateDamageAlpha,
  addScreenBlend,
  bobClock,
  bobLean,
  damageKickAngles,
  decayDamageAlpha,
  decayDamageKick,
  gunBobAngles,
  gunSwayAngles,
  gunTurnLag,
  mixDamageBlend,
  svCalcRoll,
  velocityLean,
  viewBobHeight,
  wrapAngleDelta,
} from './damageFeedback.js';

describe('P_DamageFeedback blend arithmetic', () => {
  it('blood-only hit mixes pure red', () => {
    expect(mixDamageBlend(20, 0, 0)).toEqual([1, 0, 0]);
  });
  it('armor-only hit mixes pure white', () => {
    expect(mixDamageBlend(0, 30, 0)).toEqual([1, 1, 1]);
  });
  it('power-armor-only hit mixes pure green', () => {
    expect(mixDamageBlend(0, 0, 10)).toEqual([0, 1, 0]);
  });
  it('mixed absorption weights by share of the real count', () => {
    // 10 blood + 10 armor of 20: red 1, green 0.5, blue 0.5.
    expect(mixDamageBlend(10, 10, 0)).toEqual([1, 0.5, 0.5]);
  });
  it('tiny hits floor at count 10 then alpha floors at 0.2', () => {
    // 5 damage: count floors to 10 -> 0.10 -> clamped up to 0.2.
    expect(accumulateDamageAlpha(0, 5, 0, 0)).toBe(DAMAGE_ALPHA_MIN);
  });
  it('repeated hits accumulate and saturate at 0.6', () => {
    let a = 0;
    a = accumulateDamageAlpha(a, 20, 0, 0); // 0.2
    expect(a).toBeCloseTo(0.2, 9);
    a = accumulateDamageAlpha(a, 20, 0, 0); // 0.4
    expect(a).toBeCloseTo(0.4, 9);
    a = accumulateDamageAlpha(a, 100, 0, 0); // 1.4 -> clamp
    expect(a).toBe(DAMAGE_ALPHA_MAX);
  });
  it('decay drops 0.06 per 10Hz tick and stops at 0', () => {
    expect(decayDamageAlpha(0.2)).toBeCloseTo(0.14, 9);
    expect(decayDamageAlpha(0.03)).toBe(0);
    expect(decayDamageAlpha(0)).toBe(0);
  });
  it('no damage leaves the alpha untouched', () => {
    expect(accumulateDamageAlpha(0.3, 0, 0, 0)).toBe(0.3);
  });
});

describe('P_DamageFeedback directional kick', () => {
  const fwd: [number, number, number] = [1, 0, 0];
  const right: [number, number, number] = [0, -1, 0];
  it('frontal hit pitches, does not roll', () => {
    // knockback 20 at 100hp -> kick 20 (above count*0.5 floor 10, below 50).
    // attacker ahead: dir = +forward -> sidePitch = -1 -> pitch = -6.
    const k = damageKickAngles(20, 100, 20, [1, 0, 0], fwd, right);
    expect(k!.pitch).toBeCloseTo(-6, 9);
    expect(k!.roll).toBeCloseTo(0, 9);
  });
  it('hit from the right rolls the view', () => {
    // attacker at -Y (right side): side = dot(dir,right) = +1 -> roll +6.
    const k = damageKickAngles(20, 100, 20, [0, -1, 0], fwd, right);
    expect(k!.roll).toBeCloseTo(6, 9);
    expect(k!.pitch).toBeCloseTo(0, 9);
  });
  it('low health amplifies the kick, capped at 50 degrees', () => {
    // knockback 20 at 10hp -> 200 -> clamp 50; frontal -> pitch -15.
    const k = damageKickAngles(20, 10, 20, [1, 0, 0], fwd, right);
    expect(k!.pitch).toBeCloseTo(-15, 9);
    expect(DAMAGE_KICK_MAX).toBe(50);
  });
  it('weak hits respect the count*0.5 floor', () => {
    // knockback 1 at 100hp -> 1 < 10 -> floor 10; frontal -> pitch -3.
    const k = damageKickAngles(1, 100, 20, [1, 0, 0], fwd, right);
    expect(k!.pitch).toBeCloseTo(-3, 9);
  });
  it('zero knockback and death mean no kick at all', () => {
    expect(damageKickAngles(0, 100, 20, [1, 0, 0], fwd, right)).toBeNull();
    expect(damageKickAngles(20, 0, 20, [1, 0, 0], fwd, right)).toBeNull();
    expect(damageKickAngles(20, -5, 20, [1, 0, 0], fwd, right)).toBeNull();
  });
  it('unknown direction arms the window with zero angles', () => {
    expect(damageKickAngles(20, 100, 20, null, fwd, right)).toEqual({ pitch: 0, roll: 0 });
  });
  it('kick decays linearly over DAMAGE_TIME then goes dead', () => {
    const live = decayDamageKick(-6, 2, 10.0 + DAMAGE_TIME, 10.0);
    expect(live.pitch).toBeCloseTo(-6, 9);
    expect(live.roll).toBeCloseTo(2, 9);
    expect(live.live).toBe(true);
    const half = decayDamageKick(-6, 2, 10.5, 10.25);
    expect(half.pitch).toBeCloseTo(-3, 9);
    expect(half.live).toBe(true);
    expect(decayDamageKick(-6, 2, 10.5, 10.5).live).toBe(false);
    expect(decayDamageKick(-6, 2, 10.5, 11).pitch).toBe(0);
  });
});

describe('SV_CalcViewOffset camera lean', () => {
  const fwd: [number, number, number] = [1, 0, 0];
  const right: [number, number, number] = [0, -1, 0];
  it('strafe right at 200u/s rolls +1 degree (run_roll 0.005, unclamped)', () => {
    const lean = velocityLean([0, -200, 0], fwd, right);
    expect(lean.roll).toBeCloseTo(1, 9);
    expect(lean.pitch).toBeCloseTo(0, 9);
  });
  it('strafe left mirrors the sign', () => {
    expect(velocityLean([0, 200, 0], fwd, right).roll).toBeCloseTo(-1, 9);
  });
  it('sprint forward at 300u/s pitches +0.6 degrees', () => {
    expect(velocityLean([300, 0, 0], fwd, right).pitch).toBeCloseTo(0.6, 9);
  });
  it('bob lean scales with speed and flips roll on odd cycles', () => {
    const even = bobLean(200, 1, 0, false);
    expect(even.pitch).toBeCloseTo(0.4, 9);
    expect(even.roll).toBeCloseTo(0.4, 9);
    const odd = bobLean(200, 1, 1, false);
    expect(odd.roll).toBeCloseTo(-0.4, 9);
    expect(odd.pitch).toBeCloseTo(0.4, 9);
  });
  it('ducked bob leans 6x', () => {
    expect(bobLean(200, 1, 0, true).roll).toBeCloseTo(2.4, 9);
  });
});

describe('SV_CalcGunOffset viewmodel sway (p_view.c)', () => {
  it('bob clock restarts when still, steps by speed band on ground', () => {
    expect(bobClock(3.5, 0, true, false).bobtime).toBe(0);
    expect(bobClock(0, 300, true, false).bobtime).toBeCloseTo(0.25, 9);
    expect(bobClock(0, 150, true, false).bobtime).toBeCloseTo(0.125, 9);
    expect(bobClock(0, 50, true, false).bobtime).toBeCloseTo(0.0625, 9);
    // Airborne: no accumulation (bobbing only cycles on ground).
    expect(bobClock(1, 300, false, false).bobtime).toBe(1);
  });
  it('ducked multiplies the shown cycle by 4, accumulator stays raw', () => {
    const up = bobClock(0, 150, true, false);
    const duck = bobClock(0, 150, true, true);
    expect(duck.bobtime).toBe(up.bobtime);
    expect(duck.bobcycle).toBe(Math.trunc(up.bobtime * 4));
    expect(duck.bobfracsin).toBeCloseTo(Math.abs(Math.sin(up.bobtime * 4 * Math.PI)), 9);
  });
  it('view bob height scales with speed and clamps at 6', () => {
    expect(viewBobHeight(200, 1)).toBeCloseTo(1, 9);
    expect(viewBobHeight(0, 1)).toBe(0);
    expect(viewBobHeight(2000, 1)).toBe(BOB_HEIGHT_MAX);
  });
  it('gun bob sway is zero when still, flips yaw/roll on odd cycles', () => {
    expect(gunBobAngles(0, 1, 0)).toEqual([0, 0, 0]);
    expect(gunBobAngles(200, 1, 0)).toEqual([1, 2, 1]);
    expect(gunBobAngles(200, 1, 1)).toEqual([1, -2, -1]);
  });
  it('turn lag applies standing still, wraps and clamps at ±45', () => {
    // 60° yaw snap in place: yaw 0.2*-45 (clamped), roll 0.1*-45.
    expect(gunTurnLag([0, 0, 0], [0, 60, 0])).toEqual([0, -9, -4.5]);
    expect(gunTurnLag([0, 350, 0], [0, 10, 0])).toEqual([0, -4, -2]);
    expect(gunTurnLag([0, 0, 0], [0, 0, 0])).toEqual([0, 0, 0]);
  });
  it('full sway sums bob + lag (delta wraps)', () => {
    expect(gunSwayAngles(0, 0, 0, [0, 0, 0], [0, 0, 0])).toEqual([0, 0, 0]);
    expect(gunSwayAngles(200, 1, 0, [0, 0, 0], [0, 60, 0])).toEqual([1, -7, -3.5]);
  });
  it('angle wrap is ±180', () => {
    expect(wrapAngleDelta(350)).toBeCloseTo(-10, 9);
    expect(wrapAngleDelta(-350)).toBeCloseTo(10, 9);
  });
});

describe('SV_CalcRoll model roll', () => {
  it('scales side velocity against sv_rollspeed 200 / rollangle 2', () => {
    expect(svCalcRoll(100)).toBeCloseTo(1, 9);
    expect(svCalcRoll(-100)).toBeCloseTo(-1, 9);
    expect(svCalcRoll(200)).toBeCloseTo(2, 9);
    expect(svCalcRoll(400)).toBeCloseTo(2, 9); // clamped
    expect(svCalcRoll(0)).toBe(0);
  });
});

describe('SV_AddBlend compositing', () => {
  it('adds damage over a clear screen verbatim', () => {
    expect(addScreenBlend([0, 0, 0, 0], 1, 0, 0, 0.2)).toEqual([1, 0, 0, 0.2]);
  });
  it('zero alpha is a no-op', () => {
    expect(addScreenBlend([1, 0, 0, 0.2], 0, 0, 1, 0)).toEqual([1, 0, 0, 0.2]);
  });
  it('death pose constants match the deadflag branch', () => {
    expect(DEATH_PITCH).toBe(-15);
    expect(DEATH_ROLL).toBe(40);
  });
});
