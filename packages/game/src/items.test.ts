// @q2/game/items — breather/enviro timed suits (g_items.c + p_view.c).
import { describe, expect, it } from 'vitest';
import {
  findItem,
  makePlayerState,
  pickupItem,
  suitSizzleDamage,
  SUIT_SECONDS,
} from './items.js';

describe('breather/enviro pickup (C Use_Breather/Use_Envirosuit)', () => {
  it('defs exist as powerups with the C quantity', () => {
    expect(findItem('item_breather')?.kind).toBe('powerup');
    expect(findItem('item_enviro')?.kind).toBe('powerup');
    expect(findItem('item_breather')?.amount).toBe(60);
    expect(findItem('item_enviro')?.amount).toBe(60);
  });

  it('pickup arms a 30s timer from now', () => {
    const ps = makePlayerState();
    expect(ps.breatherUntil).toBe(0);
    expect(ps.enviroUntil).toBe(0);
    const r = pickupItem(ps, 'item_breather', 100);
    expect(r.picked).toBe(true);
    expect(ps.breatherUntil).toBe(100 + SUIT_SECONDS);
    expect(SUIT_SECONDS).toBe(30);
    const e = pickupItem(ps, 'item_enviro', 100);
    expect(e.picked).toBe(true);
    expect(ps.enviroUntil).toBe(130);
  });

  it('re-pickup extends an active timer (C += 300 frames)', () => {
    const ps = makePlayerState();
    pickupItem(ps, 'item_breather', 100);
    pickupItem(ps, 'item_breather', 110);
    expect(ps.breatherUntil).toBe(130 + SUIT_SECONDS);
  });

  it('expired timer restarts from now (C = framenum + 300)', () => {
    const ps = makePlayerState();
    pickupItem(ps, 'item_enviro', 100);
    pickupItem(ps, 'item_enviro', 500);
    expect(ps.enviroUntil).toBe(500 + SUIT_SECONDS);
  });

  it('unknown powerups stay unhandled', () => {
    const ps = makePlayerState();
    expect(pickupItem(ps, 'item_quad', 0).picked).toBe(false);
  });
});

describe('envirosuit sizzle immunity (C P_WorldEffects sizzle block)', () => {
  it('lava 3x unsuited, 1x suited; slime 1x unsuited, immune suited', () => {
    expect(suitSizzleDamage(3, true, false, false)).toBe(9);
    expect(suitSizzleDamage(3, true, false, true)).toBe(3);
    expect(suitSizzleDamage(2, false, true, false)).toBe(2);
    expect(suitSizzleDamage(2, false, true, true)).toBe(0);
  });

  it('dry or clean water deals no sizzle', () => {
    expect(suitSizzleDamage(0, true, true, false)).toBe(0);
    expect(suitSizzleDamage(3, false, false, false)).toBe(0);
  });
});
