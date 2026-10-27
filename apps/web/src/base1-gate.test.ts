// BASE1 PLAY-VERIFIED GATE (BRAIN.md §15 Phase 4).
//
// This file is the permanent regression gate for base1 gameplay. Every test
// boots the REAL map through the REAL driver+server tick loop (bootPlay) and
// asserts RENDERED/SUBMITTED state — snapshot()/extraEntities()/renderView
// pixels/verts — never internal sim fields for the verdict. Setup may read
// internals to aim the bot; the pass/fail is what the renderer would submit.
//
// Contract (no gameplay card closes without this file green):
//   (a) both spawn barrels shot until they explode,
//   (b) a monster closes ~350u -> <=100u toward a live (strafing) player,
//   (c) a touched door renders open then re-closes when clear,
//   (d) the stair-secret drop stays in-bounds on the deck,
//   (e) point-blank blaster TTK on a soldier is <= 4 hits at skill 1,
//   (f) skill-change reboot re-filters the roster (3/5/3 infantry, 15/17/15
//       submitted — the dormant t55 pair is SVF_NOCLIENT until woken),
//   (g) doors + glass render CLOSED at spawn (the graft).
//   (h) shotgun pickup wakes the t55 TRIGGER_SPAWN pair (Touch_Item target),
//       which the snapshot then carries as it closes on the player.
//   (i) blind pursuit (M5.3 trail): the corridor runner rounds to its last
//       sighting with LOS broken the whole way (a beeliner stalls at the
//       corner wall instead — the validity asserts pin the blocked beeline).
//   (j) skill-scaled aggression: the same standoff fires less at skill 0
//       than at skill 3 (M_CheckAttack chance table, sight delay, refire).
//   (k) soldier duck: incoming blaster fire puts the rendered frame in the
//       duck range (soldier_dodge → duck move, hull shrink).
import { describe, expect, it, vi, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Entity } from '@q2/renderer-api';
import { MODEL_EXTRA_STRIDE, traceBox } from '@q2/bsp';
import { parseEntities } from '@q2/game';
import { SV_TraceFor, MASK_OPAQUE_C, MASK_PLAYERSOLID_C } from '@q2/server';
import { bootPlay, rebootPlay, pumpExplosionLights } from './play.js';

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

function mag3(o: [number, number, number]): number {
  return Math.hypot(o[0]!, o[1]!, o[2]!);
}

afterEach(() => {
  resetCVars();
});

describe.runIf(!!WEB_Q2_PAK)('base1 play-verified gate (Q2_PAK)', () => {
  it('(a) both spawn barrels shot until they explode', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // base1 lump inventory: the two start-room exploboxes rest on the floor.
    const spawnBarrels = driver.barrels.filter(
      (b) => !b.isFunc && Math.hypot(b.origin[0]! - 128, b.origin[1]! + 320) < 400,
    );
    expect(spawnBarrels.length).toBe(2);
    // Rendered stop condition: keep firing until the barrel is no longer
    // submitted (freed barrels leave extraEntities). A splash chain may free
    // the second barrel early — its loop then exits immediately, honestly.
    const barrelSubmitted = (tx: number, ty: number): boolean =>
      (driver.extraEntities() ?? []).some(
        (x) => x.model === boot.models!.barrel && Math.hypot(x.origin![0]! - tx, x.origin![1]! - ty) < 1,
      );
    for (const target of spawnBarrels) {
      const tx = target.origin[0]!;
      const ty = target.origin[1]!;
      // Stand 80u south with a level bead: the bolt flies straight +Y into
      // the 32x32x40 hull (eye 46, bolt line z~=38 — inside the hull band).
      driver.pm.origin = v3(tx, ty - 80, 40);
      driver.pm.velocity = v3();
      stepDriver(driver, neutralCmd(), 5); // settle onto the floor
      const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [tx, ty]);
      let ticks = 0;
      while (barrelSubmitted(tx, ty) && ticks++ < 120) driver.step(attackCmd([0, yaw, 0]), 0.1);
      expect(barrelSubmitted(tx, ty)).toBe(false);
      // The 0.2s fuse blows on server time: explosion + debris + sparks.
      stepDriver(driver, neutralCmd(), 5);
      expect(driver.events).toContain('explosion');
    }
    // RENDERED verdict: both fuses blew (one 'barrel' edge per freed barrel),
    // and the blast is submitted as explosion + debris MD2 extras with live
    // dlights. Neither freed barrel is submitted anymore.
    expect(driver.events.filter((e) => e === 'barrel').length).toBe(2);
    const extras = driver.extraEntities()!;
    for (const target of spawnBarrels) {
      const tx = target.origin[0]!;
      const ty = target.origin[1]!;
      const barrelX = extras.filter((x) => x.model === boot.models!.barrel);
      expect(barrelX.some((x) => Math.hypot(x.origin![0]! - tx, x.origin![1]! - ty) < 1)).toBe(false);
    }
    const boomModels = new Set([boot.models!.explode, boot.models!.blast]);
    expect(extras.some((x) => x.model !== undefined && boomModels.has(x.model))).toBe(true);
    const debrisModels = new Set([boot.models!.debris1, boot.models!.debris2, boot.models!.debris3]);
    expect(extras.filter((x) => x.model !== undefined && debrisModels.has(x.model)).length).toBe(28);
    expect(pumpExplosionLights(boot)).toBeGreaterThan(0);
  });

  it('(b) a monster closes ~350u -> <=100u toward a live player', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver, host } = boot;
    // Courtyard light soldier #341 (skin 0, dodgeable blaster bolts): from
    // the 350u overlook the eye trace is clear and the hull path is open, so
    // the ambush latches on the first tick and the chase is a straight run.
    const A = driver.server.monsters.find((m) => m.edict.num === 341)!;
    expect(A.edict.extra['skinnum']).toBe('0');
    const A0: [number, number] = [A.edict.origin[0]!, A.edict.origin[1]!];
    expect(Math.hypot(A0[0]! - -904, A0[1]! - 976)).toBeLessThan(2);
    // Live bot: teleport to the seated overlook, then strafe-dodge (facing
    // the monster) so foe bolts miss and the facing gate keeps it running.
    driver.pm.origin = v3(-904, 1326, -24);
    driver.pm.velocity = v3();
    driver.step(neutralCmd(), 0.1);
    const gap2 = (): number =>
      Math.hypot(A.edict.origin[0]! - driver.pm.origin[0]!, A.edict.origin[1]! - driver.pm.origin[1]!);
    const d0 = gap2();
    expect(d0).toBeGreaterThan(330); // ~350u overlook, explicit
    expect(d0).toBeLessThan(360);
    let strafe = 1;
    let t = 0;
    while (gap2() > 100 && t++ < 400 && driver.playerHealth > 0) {
      if (t % 40 === 0) strafe = -strafe as 1 | -1;
      const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [A.edict.origin[0]!, A.edict.origin[1]!]);
      driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 0, sidemove: 400 * strafe, upmove: 0, buttons: 0 }, 0.1);
    }
    const d1 = gap2();
    expect(d1).toBeLessThanOrEqual(100);
    // The monster itself covered the ground: rendered travel >= 50u.
    const travel = Math.hypot(A.edict.origin[0]! - A0[0]!, A.edict.origin[1]! - A0[1]!);
    expect(travel).toBeGreaterThan(50);
    // Live player throughout the sprint: still standing.
    expect(driver.playerHealth).toBeGreaterThan(0);
    // Return fire comes once planted, not mid-sprint: the C attack cadence
    // (M_CheckAttack chance + sight delay + attack_finished cooldown) paces
    // shots at ~1/s, so the ~15-tick closing sprint rarely trades shots.
    // Keep strafing in place for the stand-up fight and it shoots back.
    let strafe2 = 1;
    for (let k = 0; k < 120 && driver.playerHealth > 0; k++) {
      if (k % 40 === 0) strafe2 = -strafe2 as 1 | -1;
      const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [A.edict.origin[0]!, A.edict.origin[1]!]);
      driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 0, sidemove: 400 * strafe2, upmove: 0, buttons: 0 }, 0.1);
    }
    expect(driver.events).toContain('monshot');
    expect(driver.playerHealth).toBeGreaterThan(0);
    // Authoritative snapshot carries the closed-in origin, and the Host
    // submits it to renderView with the live MD2 frame.
    const snap = driver.snapshot(driver.server.time);
    const sent = snap.entities.find((e) => e.id === A.edict.num)!;
    expect(sent).toBeDefined();
    expect(Math.hypot(sent.origin[0]! - A.edict.origin[0]!, sent.origin[1]! - A.edict.origin[1]!)).toBeLessThan(1);
    for (let tt = 100; tt <= 600; tt += 100) host.frame(tt);
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
    expect(near[0]!.frame).toBe(driver.entityFrame(A.edict.num));
    const rd = Math.hypot(
      near[0]!.origin[0]! - host.playerOrigin[0]!,
      near[0]!.origin[1]! - host.playerOrigin[1]!,
    );
    expect(rd).toBeLessThan(120);
  });

  it('(c) a touched door renders open, then re-closes when clear', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // *31 plug (down-door, wait 0): no monster camps its volume, so the
    // cycle completes once the player leaves.
    const off0 = driver.doorRenderOffset('*31');
    expect(off0).not.toBeNull();
    expect(mag3(off0!)).toBeLessThan(0.01); // renders CLOSED at spawn
    // Walk into the *31 trigger field: the server Touch_DoorTrigger opens it.
    driver.pm.origin = v3(-1774, 1536, 104);
    driver.pm.velocity = v3();
    let open = 0;
    for (let i = 0; i < 120 && open < 100; i++) {
      driver.step(neutralCmd(), 0.1);
      open = mag3(driver.doorRenderOffset('*31')!);
    }
    expect(open).toBeGreaterThanOrEqual(100); // plug travels 156u; rendered
    // Leave the volume and wait out the hold + return leg: the rendered slab
    // rides back to the closed pose.
    driver.pm.origin = v3(128, -320, 32);
    driver.pm.velocity = v3();
    let shut = open;
    let n = 0;
    while (shut >= 0.5 && n++ < 400) {
      driver.step(neutralCmd(), 0.1);
      shut = mag3(driver.doorRenderOffset('*31')!);
    }
    expect(shut).toBeLessThan(0.5);
  });

  it('(d) dropping into the stair secret stays in-bounds on the deck', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Low-road clip deck by the t149 stairs: the C mask holds the deck.
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
    expect(p[2]!).toBeGreaterThan(115); // deck top, never the void
    expect(p[2]!).toBeLessThan(125);
    // The submitted player origin tracks the body: no hidden divergence.
    const snap = driver.snapshot(driver.server.time);
    const me = snap.entities.find((e) => e.id === 1)!;
    expect(me).toBeDefined();
    expect(Math.hypot(me.origin[0]! - p[0]!, me.origin[1]! - p[1]!, me.origin[2]! - p[2]!)).toBeLessThan(1);
  });

  it('(e) point-blank blaster TTK on a soldier is <= 4 hits at skill 1', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    expect(driver.server.skill).toBe(1);
    // Point-blank target must be awake: dormant TRIGGER_SPAWN bodies are
    // SOLID_NOT in C (unhittable until a use wakes them) — the t55 soldier
    // is skin 2 but dormant, so it no longer counts as a target.
    const target = driver.server.monsters.find((m) => m.edict.extra['skinnum'] === '2' && !(m.triggered && !m.woken))!;
    driver.pm.origin = v3(target.edict.origin[0]! + 48, target.edict.origin[1]!, target.edict.origin[2]! + 24);
    driver.pm.velocity = v3();
    const shotsBefore = driver.events.filter((e) => e === 'shot').length;
    const hitsBefore = driver.events.filter((e) => e === 'hit').length;
    // Aim at the live hull center every tick: incoming fire makes the
    // soldier duck (soldier_dodge → duck hull, top at the origin), so a
    // fixed level bead flies over the ducked body exactly like in C — a
    // player re-aims down at the body and the TTK still holds.
    let ticks = 0;
    while (!driver.events.includes('kill') && ticks++ < 60) {
      const e = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
      const ducked = target.state.move === 'duck';
      const c = [target.edict.origin[0]!, target.edict.origin[1]!, target.edict.origin[2]! + (ducked ? -12 : 4)];
      const dx = c[0]! - e[0]!;
      const dy = c[1]! - e[1]!;
      const dz = c[2]! - e[2]!;
      const l = Math.hypot(dx, dy) || 1;
      const aim: [number, number, number] = [(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0];
      driver.step(attackCmd(aim), 0.1);
    }
    expect(driver.events).toContain('kill');
    // 30hp / 10dmg per bolt = 3 point-blank hits; the gate allows one spare.
    const shots = driver.events.filter((e) => e === 'shot').length - shotsBefore;
    expect(shots).toBeLessThanOrEqual(4);
    const hits = driver.events.filter((e) => e === 'hit').length - hitsBefore;
    expect(hits + 1).toBeLessThanOrEqual(4); // non-lethal hits + the killer
    // The corpse persists in the authoritative snapshot on its death frame.
    const snap = driver.snapshot(driver.server.time);
    expect(snap.entities.some((e) => e.id === target.edict.num)).toBe(true);
    expect(driver.entityFrame(target.edict.num)).toBeGreaterThan(0);
  });

  it('(f) skill-change reboot re-filters the roster (3/5/3 infantry, 15/17/15)', { timeout: 180000 }, async () => {
    const infantry = (boot: { driver: { server: { entities: { classname: string }[] } } }): number =>
      boot.driver.server.entities.filter((e) => e.classname === 'monster_infantry').length;
    const snapMonsters = (boot: { driver: { snapshot(t: number): { entities: unknown[] }; server: { time: number } } }): number =>
      boot.driver.snapshot(boot.driver.server.time).entities.length - 1; // minus the player
    setCVar('skill', 0);
    const easy = await bootBase1();
    expect(easy.driver.server.skill).toBe(0);
    expect(infantry(easy)).toBe(3);
    // 15 submitted: the dormant t55 pair stays out (SVF_NOCLIENT) until the
    // shotgun pickup wakes it — the old 17 counted two unshootable statues.
    expect(snapMonsters(easy)).toBe(15);
    // "Change the dropdown": the menu sets the cvar and re-calls the boot
    // path (rebootPlay), so the new skill applies to this level immediately.
    setCVar('skill', 2);
    const hard = rebootPlay(easy);
    expect(hard.pak).not.toBeNull();
    expect(hard.driver.server.skill).toBe(2);
    expect(infantry(hard)).toBe(5);
    expect(snapMonsters(hard)).toBe(17);
    // And back down: the roster re-filters the other way too.
    setCVar('skill', 1);
    const med = rebootPlay(hard);
    expect(med.driver.server.skill).toBe(1);
    expect(infantry(med)).toBe(3);
    expect(snapMonsters(med)).toBe(15);
  });

  it('(g) doors + glass render CLOSED at spawn (the graft)', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    expect(driver.server.movers.length).toBeGreaterThan(0);
    // Every synced mover rests at its closed pose: zero rendered displacement.
    let synced = 0;
    for (const m of driver.server.movers) {
      const off = driver.doorRenderOffset(m.ent.model);
      if (off === null) continue;
      synced++;
      expect(mag3(off)).toBeLessThan(0.01);
    }
    expect(synced).toBeGreaterThan(0);
    // The graft covers every live submodel face (movers/trains/func_walls).
    expect(driver.graftedFaceCount()).toBe(232);
    // Q2 glass reads `alpha` on the func_wall (translucent when present);
    // base1 carries none, so the correct render is opaque, never invisible.
    const dicts = parseEntities(driver.map!.entities);
    const walls = dicts.filter((d) => d['classname'] === 'func_wall');
    expect(walls.map((w) => w['model']).sort()).toEqual(['*10', '*9']);
    for (const w of walls) expect(w['alpha']).toBeUndefined();
    const inLists = new Set<number>();
    for (const leaf of driver.mini.leafs) {
      for (const f of leaf.faceList ?? []) inLists.add(f);
    }
    for (const n of [9, 10]) {
      const first = driver.map!.modelsExtra[n * MODEL_EXTRA_STRIDE + 1]!;
      const num = driver.map!.modelsExtra[n * MODEL_EXTRA_STRIDE + 2]!;
      let live = 0;
      for (let f = first; f < first + num; f++) {
        if (!driver.mini.surfaces[f]?.n) continue;
        live++;
        expect(inLists.has(f)).toBe(true);
      }
      expect(live).toBeGreaterThan(0);
    }
  });

  it('(h) shotgun pickup wakes the t55 pair, which then closes in', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // RENDERED verdict setup: the pair starts dormant (SVF_NOCLIENT in C),
    // so the snapshot must NOT carry either of them yet.
    const pair = driver.server.monsters.filter((m) => m.edict.targetname === 't55');
    expect(pair.length).toBe(2);
    for (const m of pair) expect(m.triggered && !m.woken).toBe(true);
    let snap = driver.snapshot(driver.server.time);
    for (const m of pair) expect(snap.entities.some((e) => e.id === m.edict.num)).toBe(false);
    // The lump link: base1's shotgun fires t55 on pickup (Touch_Item).
    const gun = driver.server.entities.find((e) => e.classname === 'weapon_shotgun' && e.target === 't55')!;
    expect(gun).toBeDefined();
    // Walk the pickup: teleport onto the gun and settle a few ticks.
    driver.pm.origin = v3(gun.origin[0]!, gun.origin[1]!, gun.origin[2]!);
    driver.pm.velocity = v3();
    let n = 0;
    while (!driver.events.includes('pickup') && n++ < 30) driver.step(neutralCmd(), 0.1);
    expect(driver.events).toContain('pickup');
    // Both soldiers woke and the snapshot carries them again.
    for (const m of pair) expect(m.woken).toBe(true);
    snap = driver.snapshot(driver.server.time);
    for (const m of pair) expect(snap.entities.some((e) => e.id === m.edict.num)).toBe(true);
    // They close on the live player: rendered travel toward the body.
    const m0 = pair[0]!;
    const gap = (): number =>
      Math.hypot(m0.edict.origin[0]! - driver.pm.origin[0]!, m0.edict.origin[1]! - driver.pm.origin[1]!);
    const d0 = gap();
    let t = 0;
    while (gap() > Math.max(60, d0 - 100) && t++ < 300 && driver.playerHealth > 0) {
      driver.step(neutralCmd(), 0.1);
    }
    expect(gap()).toBeLessThan(d0);
  });

  it('(i) blind pursuit reaches the last sighting with LOS broken throughout', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Corridor runner (base1.test 2b geometry): the monster starts seated at
    // the low end of the stairs, the player holds the high end, then
    // teleports behind cover. The beeline to the hidden player stalls at the
    // corner wall (validity asserts below); the M5.3 trail pursuit first
    // rounds to the last sighting, then follows the trail toward the player.
    const seat = (x: number, y: number): [number, number, number] => {
      const mins = [-16, -16, -24] as [number, number, number];
      const maxs = [16, 16, 32] as [number, number, number];
      const d = traceBox(
        driver.map!, v3(x, y, 20), v3(x, y, -400),
        v3(mins[0], mins[1], mins[2]), v3(maxs[0], maxs[1], maxs[2]), MASK_PLAYERSOLID_C,
      );
      return [d.endpos[0]!, d.endpos[1]!, d.endpos[2]!];
    };
    const los = (from: [number, number, number], to: [number, number, number]): boolean => {
      const t = SV_TraceFor(driver.map!, MASK_OPAQUE_C)(
        v3(from[0], from[1], from[2]! + 25), v3(0, 0, 0), v3(0, 0, 0),
        v3(to[0], to[1], to[2]! + 22),
      );
      return t.fraction === 1 && !t.startsolid;
    };
    const runner = driver.server.monsters
      .filter((m) => !m.triggered && m.kind)
      .sort(
        (a, b) =>
          Math.hypot(a.edict.origin[0]! - 128, a.edict.origin[1]! + 320) -
          Math.hypot(b.edict.origin[0]! - 128, b.edict.origin[1]! + 320),
      )[0]!;
    const lowA = seat(440, -500);
    runner.edict.origin = v3(lowA[0], lowA[1], lowA[2]);
    runner.state.move = 'run';
    runner.state.frame = 0;
    const PB2 = seat(360, -430);
    driver.pm.origin = v3(PB2[0], PB2[1], PB2[2]);
    driver.pm.velocity = v3();
    for (let i = 0; i < 5; i++) driver.step(neutralCmd(), 0.1);
    expect(runner.seen).toBe(true);
    // Last sighting: the high-end spot the monster saw the player at.
    const L: [number, number, number] = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]!];
    const M: [number, number, number] = [runner.edict.origin[0]!, runner.edict.origin[1]!, runner.edict.origin[2]!];
    expect(los(M, L)).toBe(true);
    // Hidden spot off the M->L axis (a beeliner stalls at the corner wall
    // far from L instead of rounding to it — the validity pair below).
    const H = seat(246, -662);
    expect(los(M, H as [number, number, number])).toBe(false);
    const beeline = SV_TraceFor(driver.map!, MASK_PLAYERSOLID_C)(
      v3(M[0], M[1], M[2]), v3(-16, -16, -24), v3(16, 16, 32), v3(H[0], H[1], H[2]),
    );
    expect(beeline.fraction).toBeLessThan(1); // the corner blocks the beeline
    const stall: [number, number, number] = [
      M[0]! + (H[0]! - M[0]!) * beeline.fraction,
      M[1]! + (H[1]! - M[1]!) * beeline.fraction,
      M[2]!,
    ];
    expect(Math.hypot(stall[0]! - L[0]!, stall[1]! - L[1]!)).toBeGreaterThan(80);
    // Teleport the player behind cover; the monster pursues blind.
    runner.edict.origin = v3(lowA[0], lowA[1], lowA[2]);
    runner.state.move = 'run';
    runner.state.frame = 0;
    driver.pm.origin = v3(H[0], H[1], H[2]);
    driver.pm.velocity = v3();
    // RENDERED verdict: the submitted snapshot origin rounds to the last
    // sighting (min over the run), while LOS stays broken throughout.
    const submittedGap = (to: [number, number, number]): number => {
      const snap = driver.snapshot(driver.server.time);
      const sent = snap.entities.find((e) => e.id === runner.edict.num)!;
      expect(sent).toBeDefined();
      return Math.hypot(sent.origin[0]! - to[0]!, sent.origin[1]! - to[1]!);
    };
    let minD = submittedGap(L);
    let broken = 0;
    for (let t = 0; t < 150 && driver.playerHealth > 0; t++) {
      driver.step(neutralCmd(), 0.1);
      minD = Math.min(minD, submittedGap(L));
      const sent = driver.snapshot(driver.server.time).entities.find((e) => e.id === runner.edict.num)!;
      if (!los([sent.origin[0]!, sent.origin[1]!, sent.origin[2]!] as [number, number, number], [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]!] as [number, number, number])) broken++;
    }
    expect(driver.playerHealth).toBeGreaterThan(0); // never touched the player
    expect(broken).toBeGreaterThan(100); // blind the whole way
    expect(minD).toBeLessThanOrEqual(60); // rounded to the last sighting
  });

  it('(j) the same standoff fires less at skill 0 than at skill 3', { timeout: 180000 }, async () => {
    // M_CheckAttack chance table + sight delay + burst refire, all
    // skill-scaled: the courtyard overlook standoff latches on the first
    // tick at every skill (edict nums shift with the roster, so the soldier
    // is matched by lump x/y, exactly like the (b) A0 pin).
    const counts: number[] = [];
    for (const skill of [0, 3]) {
      setCVar('skill', skill);
      const boot = await bootBase1();
      const { driver } = boot;
      const A = driver.server.monsters.find(
        (m) => Math.abs(m.edict.origin[0]! + 904) < 5 && Math.abs(m.edict.origin[1]! - 976) < 5,
      )!;
      expect(A).toBeDefined();
      expect(A.edict.extra['skinnum']).toBe('0');
      driver.pm.origin = v3(-904, 1326, -24);
      driver.pm.velocity = v3();
      driver.step(neutralCmd(), 0.1);
      expect(A.seen).toBe(true);
      let strafe = 1;
      for (let t = 0; t < 150 && driver.playerHealth > 0; t++) {
        if (t % 40 === 0) strafe = -strafe as 1 | -1;
        const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [A.edict.origin[0]!, A.edict.origin[1]!]);
        driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 0, sidemove: 400 * strafe, upmove: 0, buttons: 0 }, 0.1);
      }
      counts.push(driver.events.filter((e) => e === 'monshot').length);
    }
    expect(counts[0]).toBeLessThan(counts[1]!);
  });

  it('(k) incoming blaster fire ducks the soldier (rendered duck frames)', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // First skin-2 soldier with a clear lane from 150u east (soldier_dodge
    // needs the shot line to connect and the shooter in front; #370 sits
    // behind a ledge, so it can never dodge — skip sight-blocked bodies).
    const sight = SV_TraceFor(driver.map!, MASK_OPAQUE_C);
    const clearLane = (m: { edict: { origin: [number, number, number] } }): boolean => {
      const P = v3(m.edict.origin[0]! + 150, m.edict.origin[1]!, m.edict.origin[2]! + 24);
      const t = sight(
        v3(m.edict.origin[0]!, m.edict.origin[1]!, m.edict.origin[2]! + 25), v3(0, 0, 0), v3(0, 0, 0),
        v3(P[0]!, P[1]!, P[2]! + 22),
      );
      return t.fraction === 1 && !t.startsolid;
    };
    const target = driver.server.monsters.find(
      (m) => m.edict.extra['skinnum'] === '2' && !(m.triggered && !m.woken) && clearLane(m as never),
    )!;
    expect(target).toBeDefined();
    driver.pm.origin = v3(target.edict.origin[0]! + 150, target.edict.origin[1]!, target.edict.origin[2]! + 24);
    driver.pm.velocity = v3();
    for (let i = 0; i < 8; i++) driver.step(neutralCmd(), 0.1);
    // Aim at the hull center so every bolt connects (each connecting shot
    // rolls the C dodge through the seeded stream).
    const aim = (): [number, number, number] => {
      const e = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
      const c = [target.edict.origin[0]!, target.edict.origin[1]!, target.edict.origin[2]! + 4];
      const dx = c[0]! - e[0]!;
      const dy = c[1]! - e[1]!;
      const dz = c[2]! - e[2]!;
      const l = Math.hypot(dx, dy) || 1;
      return [(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0];
    };
    // RENDERED verdict: the submitted MD2 frame enters the duck range
    // (soldier_move_duck first frame 45) after incoming fire.
    let duckSeen = false;
    for (let t = 0; t < 30 && !driver.events.includes('kill') && !driver.events.includes('gib') && driver.playerHealth > 0; t++) {
      driver.step({ msec: 100, angles: aim(), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 }, 0.1);
      const f = driver.entityFrame(target.edict.num);
      if (f >= 45 && f <= 49) {
        duckSeen = true;
        break;
      }
    }
    expect(duckSeen).toBe(true);
  });
});
