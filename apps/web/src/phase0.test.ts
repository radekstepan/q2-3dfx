// Phase 0 gate (BRAIN.md §15): driver-level base1 bot through the REAL
// driver+server tick loop, asserting RENDERED/submitted state — not package
// unit state. The driver owns no sim: monsters, barrels, bolts, explosions
// and damage all live in `packages/server`; the driver renders server state
// and forwards input via SV_PlayerFire. Every test below boots base1
// through bootPlay (real lump, real tick loop) and asserts on
// snapshot()/extraEntities() outcomes.
//
// (a) shooting both spawn barrels until they explode,
// (b) a monster closes distance toward the player over ticks,
// (c) a touched door re-closes when clear,
// (d) dropping into the stair secret stays in-bounds,
// (e) point-blank blaster TTK on a soldier ≤ 4 hits at skill 1.
import { describe, expect, it, vi } from 'vitest';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Entity } from '@q2/renderer-api';
import { bootPlay, pumpExplosionLights } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

function attackCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 };
}

function stepDriver(driver: { step(cmd: UserCmdT, dt: number): void }, cmd: UserCmdT, n: number): void {
  for (let i = 0; i < n; i++) driver.step(cmd, 0.1);
}

async function bootBase1(width = 96, height = 72) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

function yawAt(from: [number, number], to: [number, number]): number {
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
}

describe.runIf(!!WEB_Q2_PAK)('Phase 0: single authoritative sim (Q2_PAK)', () => {
  it('(a) shooting both spawn barrels until they explode', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // base1 lump inventory: the two start-room exploboxes rest on the floor.
    const spawnBarrels = driver.barrels.filter(
      (b) => !b.isFunc && Math.hypot(b.origin[0]! - 128, b.origin[1]! + 320) < 400,
    );
    expect(spawnBarrels.length).toBe(2);
    for (const target of spawnBarrels) {
      const tx = target.origin[0]!;
      const ty = target.origin[1]!;
      // Stand 80u south with a level bead: the bolt flies straight +Y into
      // the 32×32×40 hull (eye 46, bolt line z≈38 — inside the hull band).
      driver.pm.origin = v3(tx, ty - 80, 40);
      driver.pm.velocity = v3();
      stepDriver(driver, neutralCmd(), 5); // settle onto the floor
      const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [tx, ty]);
      let ticks = 0;
      while (!target.edict.freed && ticks++ < 120) driver.step(attackCmd([0, yaw, 0]), 0.1);
      expect(target.edict.freed).toBe(true);
      expect(driver.events).toContain('barrel');
      // The 0.2s fuse blows on server time: explosion + debris + sparks.
      stepDriver(driver, neutralCmd(), 5);
      expect(driver.events).toContain('explosion');
      expect(driver.server.explosions.length + driver.server.debris.length).toBeGreaterThan(0);
      expect(driver.server.debris.length).toBeGreaterThan(0);
      // The render path drops the freed barrel and submits the blast: the
      // explosion dlight pump fires while the flash lives.
      const extras = driver.extraEntities()!;
      const barrelX = extras.filter((x) => x.model === boot.models!.barrel);
      expect(barrelX.some((x) => Math.hypot(x.origin![0]! - tx, x.origin![1]! - ty) < 1)).toBe(false);
      expect(pumpExplosionLights(boot)).toBeGreaterThan(0);
    }
    // Both fuses blew: 28 debris chunks (2×14) from the two exploboxes.
    expect(driver.server.debris.length).toBe(28);
  });

  it('(b) a monster closes distance toward the player over ticks', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver, host } = boot;
    // Start-room runner (light soldier east of spawn): ambush holds it in
    // stand until line of sight latches `seen` (id walkmonster_start_go +
    // visible()), exactly like the server runner test — the driver holds no
    // monster state, so any approach below is the server sim rendering.
    const spawn = v3(128, -320, 32);
    const sim = driver.server.monsters.filter((m) => !m.triggered && m.kind);
    const A = sim.sort(
      (a, b) =>
        Math.hypot(a.edict.origin[0]! - spawn[0]!, a.edict.origin[1]! - spawn[1]!) -
        Math.hypot(b.edict.origin[0]! - spawn[0]!, b.edict.origin[1]! - spawn[1]!),
    )[0]!;
    for (let i = 0; i < 10; i++) driver.step(neutralCmd(), 0.1);
    expect(A.seen).toBe(false);
    const ax = A.edict.origin[0]!;
    const ay = A.edict.origin[1]!;
    expect(A.edict.origin[0]).toBe(ax);
    expect(A.edict.origin[1]).toBe(ay);
    // Round the corner to the east corridor mouth: LOS opens, seen latches,
    // and the monster runs at the player (dropped from above, then settled).
    driver.pm.origin = v3(440, -500, 100);
    driver.pm.velocity = v3();
    let guard = 0;
    while (!A.seen && guard++ < 40) driver.step(neutralCmd(), 0.1);
    expect(A.seen).toBe(true);
    stepDriver(driver, neutralCmd(), 10); // settle the fall
    const distNow = (): number =>
      Math.hypot(
        A.edict.origin[0]! - driver.pm.origin[0]!,
        A.edict.origin[1]! - driver.pm.origin[1]!,
        A.edict.origin[2]! - driver.pm.origin[2]!,
      );
    const d0 = distNow();
    expect(d0).toBeGreaterThan(60);
    for (let i = 0; i < 60; i++) driver.step(neutralCmd(), 0.1);
    const d1 = distNow();
    expect(d1).toBeLessThan(d0 - 20);
    // Authoritative snapshot carries the closed-in origin, and the Host
    // submits it to renderView with the live MD2 frame.
    const snap = driver.snapshot(driver.server.time);
    const sent = snap.entities.find((e) => e.id === A.edict.num)!;
    expect(sent).toBeDefined();
    expect(Math.hypot(sent.origin[0]! - A.edict.origin[0]!, sent.origin[1]! - A.edict.origin[1]!)).toBeLessThan(1);
    for (let t = 100; t <= 600; t += 100) host.frame(t);
    let rendered: Entity[] = [];
    const orig = boot.refresh.renderView.bind(boot.refresh);
    vi.spyOn(boot.refresh, 'renderView').mockImplementation((view, world, entities) => {
      rendered = [...entities];
      return orig(view, world, entities);
    });
    host.frame(700);
    const near = rendered.filter(
      (e) => Math.hypot(e.origin[0]! - A.edict.origin[0]!, e.origin[1]! - A.edict.origin[1]!) < 8,
    );
    expect(near.length).toBeGreaterThan(0);
    const rd = Math.hypot(
      near[0]!.origin[0]! - host.playerOrigin[0]!,
      near[0]!.origin[1]! - host.playerOrigin[1]!,
    );
    expect(rd).toBeLessThan(d0 - 20);
  });

  it('(c) a touched door re-closes when clear', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // *31 plug (down-door, wait 0): no monster camps its volume, so the
    // cycle completes once the player leaves (two soldiers camp the *19
    // field and hold it open — authentic Touch_DoorTrigger refresh).
    const door = driver.server.movers.find((m) => m.ent.model === '*31')!;
    expect(door).toBeDefined();
    expect(door.state).toBe('bottom');
    // Walk into the *31 trigger field: the driver forwards the body to the
    // server Touch_DoorTrigger (no driver-side door sim remains).
    driver.pm.origin = v3(-1774, 1536, 104);
    driver.pm.velocity = v3();
    for (let i = 0; i < 10 && door.state === 'bottom'; i++) driver.step(neutralCmd(), 0.1);
    expect(door.state).not.toBe('bottom');
    // Leave the volume and wait out the hold + return leg: the server cycle
    // (door_hit_top → door_go_down → door_hit_bottom) latches at pos1.
    driver.pm.origin = v3(128, -320, 32);
    driver.pm.velocity = v3();
    let guard = 0;
    while (door.state !== 'bottom' && guard++ < 400) driver.step(neutralCmd(), 0.1);
    expect(door.state).toBe('bottom');
    for (let i = 0; i < 3; i++) {
      expect(door.ent.origin[i]!).toBeCloseTo(door.pos1[i]!, 3);
    }
  });

  it('(d) dropping into the stair secret stays in-bounds', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Low-road clip deck by the t149 stairs (BRAIN.md M5.2 BUG 1): the C
    // mask holds the deck (feet 96); mask-1 fell to -600, out of the world.
    driver.pm.origin = v3(-500, 150, 300);
    driver.pm.velocity = v3();
    for (let i = 0; i < 40; i++) driver.step(neutralCmd(), 0.1);
    const p = driver.pm.origin;
    const map = driver.map!;
    const mins = [...map.modelsMins.slice(0, 3)];
    const maxs = [...map.modelsMaxs.slice(0, 3)];
    for (let i = 0; i < 3; i++) {
      expect(p[i]!).toBeGreaterThanOrEqual(mins[i]! - 32);
      expect(p[i]!).toBeLessThanOrEqual(maxs[i]! + 32);
    }
    expect(driver.pm.onGround).toBe(true);
    expect(p[2]!).toBeGreaterThan(90); // deck top (feet 96), never the void
  });

  it('(e) point-blank blaster TTK on a soldier is ≤ 4 hits at skill 1', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    expect(driver.server.skill).toBe(1);
    const target = driver.server.monsters.find((m) => m.edict.extra['skinnum'] === '2')!;
    expect(target.state.health).toBe(30);
    driver.pm.origin = v3(target.edict.origin[0]! + 48, target.edict.origin[1]!, target.edict.origin[2]! + 24);
    driver.pm.velocity = v3();
    const yaw = yawAt(
      [driver.pm.origin[0]!, driver.pm.origin[1]!],
      [target.edict.origin[0]!, target.edict.origin[1]!],
    );
    const shotsBefore = driver.events.filter((e) => e === 'shot').length;
    let ticks = 0;
    while (!target.state.dead && ticks++ < 60) driver.step(attackCmd([0, yaw, 0]), 0.1);
    expect(target.state.dead).toBe(true);
    const shots = driver.events.filter((e) => e === 'shot').length - shotsBefore;
    // 30hp / 10dmg per bolt = 3 point-blank hits; the gate allows one spare.
    expect(shots).toBeLessThanOrEqual(4);
    expect(driver.events).toContain('kill');
    // The corpse persists in the authoritative snapshot on its death frame.
    const snap = driver.snapshot(driver.server.time);
    expect(snap.entities.some((e) => e.id === target.edict.num)).toBe(true);
    expect(driver.entityFrame(target.edict.num)).toBeGreaterThan(0);
  });
});
