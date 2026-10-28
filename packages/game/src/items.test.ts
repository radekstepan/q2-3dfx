// @q2/game/items — breather/enviro timed suits (g_items.c + p_view.c).
import { describe, expect, it } from 'vitest';
import {
  findItem,
  makePlayerState,
  pickupItem,
  respawnDelayFor,
  suitSizzleDamage,
  QUAD_SECONDS,
  INVULN_SECONDS,
  SILENCER_SHOTS,
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
    expect(pickupItem(ps, 'item_jetpack', 0).picked).toBe(false);
  });
});

describe('base1 pickup gaps: silencer + grenades + arsenal (g_items.c itemlist)', () => {
  it('silencer def exists and pickup banks +30 shots, stacking', () => {
    expect(findItem('item_silencer')?.kind).toBe('powerup');
    const ps = makePlayerState();
    expect(ps.silencerShots).toBe(0);
    const r = pickupItem(ps, 'item_silencer', 0);
    expect(r.picked).toBe(true);
    expect(r.applied).toBe(SILENCER_SHOTS);
    expect(SILENCER_SHOTS).toBe(30);
    expect(ps.silencerShots).toBe(30);
    pickupItem(ps, 'item_silencer', 10);
    expect(ps.silencerShots).toBe(60);
  });

  it('ammo_grenades grants 5 up to the 50 cap', () => {
    expect(findItem('ammo_grenades')?.kind).toBe('ammo');
    expect(findItem('ammo_grenades')?.amount).toBe(5);
    const ps = makePlayerState();
    const r = pickupItem(ps, 'ammo_grenades', 0);
    expect(r.picked).toBe(true);
    expect(ps.ammo['grenades']).toBe(5);
    ps.ammo['grenades'] = 48;
    pickupItem(ps, 'ammo_grenades', 0);
    expect(ps.ammo['grenades']).toBe(50);
    expect(pickupItem(ps, 'ammo_grenades', 0).picked).toBe(false);
  });

  it('quad/invulnerability arm 30s timers, extending when active', () => {
    expect(findItem('item_quad')?.kind).toBe('powerup');
    expect(findItem('item_invulnerability')?.kind).toBe('powerup');
    expect(QUAD_SECONDS).toBe(30);
    expect(INVULN_SECONDS).toBe(30);
    const ps = makePlayerState();
    expect(pickupItem(ps, 'item_quad', 100).picked).toBe(true);
    expect(ps.quadUntil).toBe(130);
    expect(pickupItem(ps, 'item_quad', 110).picked).toBe(true);
    expect(ps.quadUntil).toBe(160);
    expect(pickupItem(ps, 'item_invulnerability', 100).picked).toBe(true);
    expect(ps.invulnUntil).toBe(130);
  });

  it('adrenaline raises max by 1 and heals full; ancient head +2 without heal', () => {
    const ps = makePlayerState();
    ps.health = 40;
    expect(pickupItem(ps, 'item_adrenaline', 0).picked).toBe(true);
    expect(ps.maxHealth).toBe(101);
    expect(ps.health).toBe(101);
    const q = makePlayerState();
    q.health = 40;
    expect(pickupItem(q, 'item_ancient_head', 0).picked).toBe(true);
    expect(q.maxHealth).toBe(102);
    expect(q.health).toBe(40);
  });

  it('keys carry by classname', () => {
    expect(findItem('key_blue_key')?.kind).toBe('key');
    expect(findItem('key_power_cube')?.kind).toBe('key');
    const ps = makePlayerState();
    expect(pickupItem(ps, 'key_blue_key', 0).picked).toBe(true);
    expect(ps.keys).toEqual(['key_blue_key']);
  });

  it('full weapon table resolves with C ammo gifts', () => {
    for (const c of [
      'weapon_supershotgun',
      'weapon_chaingun',
      'weapon_grenadelauncher',
      'weapon_rocketlauncher',
      'weapon_hyperblaster',
      'weapon_railgun',
      'weapon_bfg',
    ]) {
      expect(findItem(c)?.kind).toBe('weapon');
    }
    // C Pickup_Weapon: Add_Ammo(other, ammo, ammo->quantity).
    const ps = makePlayerState();
    pickupItem(ps, 'weapon_shotgun', 0);
    expect(ps.ammo['shells']).toBe(10);
    pickupItem(ps, 'weapon_machinegun', 0);
    expect(ps.ammo['bullets']).toBe(50);
    pickupItem(ps, 'weapon_chaingun', 0);
    expect(ps.ammo['bullets']).toBe(100);
    pickupItem(ps, 'weapon_bfg', 0);
    expect(ps.ammo['cells']).toBe(50);
    pickupItem(ps, 'weapon_grenadelauncher', 0);
    expect(ps.ammo['grenades']).toBe(5);
    // Gifts clamp to the ammo max carry (rockets/slugs/grenades cap 50).
    ps.ammo['rockets'] = 48;
    pickupItem(ps, 'weapon_rocketlauncher', 0);
    expect(ps.ammo['rockets']).toBe(50);
  });

  it('powerup respawn delays are the C quantities (invuln 300, rest 60)', () => {
    expect(respawnDelayFor('item_invulnerability')).toBe(300);
    expect(respawnDelayFor('item_quad')).toBe(60);
    expect(respawnDelayFor('item_silencer')).toBe(60);
    expect(respawnDelayFor('item_breather')).toBe(60);
    expect(respawnDelayFor('item_adrenaline')).toBe(60);
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
