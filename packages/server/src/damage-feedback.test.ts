// RELEASE-14 server lane: P_DamageFeedback totals recorded by SV_DamagePlayer.
//
// The server records applied damage + the latest attacker origin
// (`damage_from`); the driver drains per tick and runs the blend/kick
// arithmetic. World damage (drown/sizzle) records no direction, matching
// C's `vec3_origin`.
import { describe, expect, it } from 'vitest';
import { v3 } from '@q2/math';
import { SV_DamagePlayer, SV_DrainPlayerDamage, SV_Init } from './index.js';

describe('SV_DamagePlayer feedback totals', () => {
  it('records applied damage and drains exactly once', () => {
    const st = SV_Init();
    expect(SV_DrainPlayerDamage(st)).toBeNull();
    SV_DamagePlayer(st, 20);
    const d = SV_DrainPlayerDamage(st);
    expect(d!.amount).toBe(20);
    expect(d!.from).toBeNull();
    expect(SV_DrainPlayerDamage(st)).toBeNull();
  });
  it('accumulates repeated hits and keeps the latest direction', () => {
    const st = SV_Init();
    SV_DamagePlayer(st, 10, v3(1, 0, 0));
    SV_DamagePlayer(st, 15, v3(0, 5, 0));
    const d = SV_DrainPlayerDamage(st);
    expect(d!.amount).toBe(25);
    expect(Array.from(d!.from!)).toEqual([0, 5, 0]);
  });
  it('records nothing once dead (health gate)', () => {
    const st = SV_Init();
    SV_DamagePlayer(st, 1000);
    expect(st.playerHealth).toBe(0);
    expect(SV_DrainPlayerDamage(st)!.amount).toBeGreaterThan(0);
    expect(SV_DamagePlayer(st, 10)).toBe(0);
    expect(SV_DrainPlayerDamage(st)).toBeNull();
  });
  it('easy skill halves through the same recording path', () => {
    const st = SV_Init();
    st.skill = 0;
    SV_DamagePlayer(st, 21);
    expect(SV_DrainPlayerDamage(st)!.amount).toBe(11); // round(21*0.5)
  });
});
