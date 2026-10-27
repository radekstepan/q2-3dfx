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
//   (l) the blown *20 func wall walks open (dead-on blaster damages the
//       brush itself → fuse → clip removed), crouching on the debris never
//       wedges (in-bounds throughout, stands back up, moves out; debris is
//       visual-only).
//   (m) shotgun-secret crawlspace barrels (+ the *30 slab) die to blaster
//       fire (rendered barrels gone, clips open).
//   (n) all 9 misc_exploboxes rest on the hull-trace floor (server origin
//       and rendered mesh bottom within epsilon — the (a) pin for every
//       barrel, not just the spawn pair; func_explosives render as brush
//       geometry, never as barrel proxies, so the roster is 9, not 11).
//   (o) the spawn-room "third barrel" is brush glass: lump holds 2
//       misc_explobox + 1 func_explosive (*20, TRANS33 window); it renders
//       via the mover graft at the closed pose (never a barrel MD2), and
//       still dies to direct fire (clip removed, faces ungrafted).
//   (p) dead soldiers render: the lump holds 12 misc_deadsoldier and every
//       one submits the deadbod dude MD2 at its lump origin + C pose frame
//       (spawnflags bits, first match wins), persisting (never freed).
import { describe, expect, it, vi, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { BUTTON_DUCK } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { Entity } from '@q2/renderer-api';
import { MODEL_EXTRA_STRIDE, traceBox, FACE_STRIDE } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { EXPLOBOX_MAXS, EXPLOBOX_MINS, PMF_DUCKED, SOLID_BBOX, deadsoldierFrameForSpawnflags, parseEntities, parseFloat } from '@q2/game';
import { SV_ClipTrace, SV_SetPlayerHealth, SV_TraceFor, MASK_OPAQUE_C, MASK_PLAYERSOLID_C } from '@q2/server';
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

/** World-bounds check shared by the traversal verdicts (same box as (d)). */
function expectInWorld(origin: Vec3, map: BspMap): void {
  const mins = [...map.modelsMins.slice(0, 3)];
  const maxs = [...map.modelsMaxs.slice(0, 3)];
  for (let i = 0; i < 3; i++) {
    expect(origin[i]!).toBeGreaterThanOrEqual(mins[i]! - 32);
    expect(origin[i]!).toBeLessThanOrEqual(maxs[i]! + 32);
  }
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
    // RENDERED verdict: the fuses blew ('barrel' edges — the *20 chain can
    // land on the same tick as a lethal bolt hit, coalescing two frees
    // into one edge, so >= 2), and the blast is submitted as explosion +
    // debris MD2 extras with live dlights. Neither freed barrel is
    // submitted anymore.
    expect(driver.events.filter((e) => e === 'barrel').length).toBeGreaterThanOrEqual(2);
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
    // 28 from the spawn pair (2 big + 4 corner + 8 small each) plus 24 from
    // the *20 wall the first blast chains into — the C opener: the splash
    // reaches the brush bbox center (self-hit rule), 150 - 0.5*160 = 70 pts
    // vs 10 hp. Mass-800 recipe = 8 big + 16 small.
    expect(driver.server.barrels.find((b) => b.isFunc && b.edict.model === '*20')!.edict.freed).toBe(true);
    expect(driver.server.brushClips.has(driver.server.barrels.find((b) => b.isFunc && b.edict.model === '*20')!.edict.num)).toBe(false);
    expect(extras.filter((x) => x.model !== undefined && debrisModels.has(x.model)).length).toBe(52);
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
    // The graft covers every live submodel face (movers/trains/func_walls +
    // the *20 glass window + the *30 slab): 232 + 17 + 83 = 332.
    expect(driver.graftedFaceCount()).toBe(332);
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

  it('(l) the blown *20 wall walks open; crouch on debris never wedges', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    // The first blown-up door: the *20 func_explosive wall across the start
    // corridor (x -72..128, y 136..144, z 16..112).
    const b20 = driver.server.barrels.find((b) => b.isFunc && b.edict.model === '*20')!;
    expect(b20).toBeDefined();
    expect(driver.server.brushClips.has(b20.edict.num)).toBe(true);
    // Stand south of the wall and shoot it dead-on. The SOLID_BSP touch
    // damages the brush itself (barrel_delay fuse) — without the
    // clip-attribution fix the clip ties the damage bbox, the wall wins,
    // and the func is immune forever.
    driver.pm.origin = v3(28, 60, 30);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    expect(driver.pm.onGround).toBe(true);
    // Settle from above: a real fall lands at the +1/32 contact rest. An
    // exact-plane teleport parks the hull bottom exactly on the plane,
    // which the C position test also reports as solid (d1 == 0 counts as
    // inside) — that would wedge the stand-up check artificially.
    let ticks = 0;
    while (!b20.edict.freed && ticks++ < 40) driver.step(attackCmd([0, 90, 0]), 0.1);
    expect(b20.edict.freed).toBe(true);
    stepDriver(driver, neutralCmd(), 5);
    // RENDERED verdict: the fuse blew (explosion + debris submitted), the
    // dead brush is fully non-solid (clip gone), and no barrel renders at
    // the wall anymore.
    expect(driver.server.brushClips.has(b20.edict.num)).toBe(false);
    expect(driver.events).toContain('barrel');
    expect(driver.events).toContain('explosion');
    expect(driver.server.debris.length).toBeGreaterThan(0);
    const extras = driver.extraEntities()!;
    expect(
      extras.filter((x) => x.model === boot.models!.barrel && Math.hypot(x.origin![0]! - 28, x.origin![1]! - 140) < 1),
    ).toHaveLength(0);
    // Debris is visual-only: player-hull sweeps pass straight through
    // resting chunks (chunks never enter any clip trace, so they can never
    // wedge a hull — the *20 wall scatters them ±200 in x, C-identical wide
    // jitter, so proximity-to-path proves nothing; penetration does).
    let wt = 0;
    while (driver.server.debris.length > 0 && driver.server.debris.every((d) => !d.rest) && wt++ < 30) {
      driver.step(neutralCmd(), 0.1);
    }
    const trace = SV_ClipTrace(driver.server, SV_TraceFor(map));
    const rested = driver.server.debris.filter((d) => d.rest);
    expect(rested.length).toBeGreaterThan(0);
    const byDist = [...rested].sort(
      (a, b) => Math.hypot(a.origin[0]! - 28, a.origin[1]! - 140) - Math.hypot(b.origin[0]! - 28, b.origin[1]! - 140),
    );
    let clear = 0;
    for (const d of byDist.slice(0, 6)) {
      const t = trace(
        v3(d.origin[0], d.origin[1]! - 24, d.origin[2]! + 24),
        v3(-16, -16, -24),
        v3(16, 16, 32),
        v3(d.origin[0], d.origin[1]! + 24, d.origin[2]! + 24),
      );
      if (t.fraction === 1) clear++;
    }
    expect(clear).toBeGreaterThan(0);
    // Crouch on the debris field: hull shrinks, position stays in-bounds.
    for (let i = 0; i < 10; i++) {
      driver.step({ msec: 100, angles: [0, 90, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_DUCK }, 0.1);
    }
    expect(driver.pm.pmFlags & PMF_DUCKED).toBe(PMF_DUCKED);
    expect(driver.pm.maxs[2]).toBe(4);
    expect(driver.pm.viewheight).toBe(12);
    expectInWorld(driver.pm.origin, map);
    // Release: headroom is free (corridor ceiling 112), so the hull grows
    // back instead of wedging ducked.
    stepDriver(driver, neutralCmd([0, 90, 0]), 10);
    expect(driver.pm.pmFlags & PMF_DUCKED).toBe(0);
    expect(driver.pm.maxs[2]).toBe(32);
    expectInWorld(driver.pm.origin, map);
    // Walk the blown doorway at patrol pace (10u/tick stays on the upper
    // floor instead of sprinting off the trench edge past it): up the
    // 16-step, through the wall gap, stop on the far side.
    let n = 0;
    while (driver.pm.origin[1]! <= 144 && n++ < 60) {
      driver.step({ msec: 100, angles: [0, 90, 0], forwardmove: 100, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    }
    expect(driver.pm.origin[1]!).toBeGreaterThan(140);
    expect(driver.pm.origin[1]!).toBeLessThan(200);
    // Stepped up onto the upper floor (not still blocked on the low side).
    expect(driver.pm.origin[2]!).toBeGreaterThan(30);
    expect(driver.pm.origin[2]!).toBeLessThan(50);
    let settle = 0;
    while (!driver.pm.onGround && settle++ < 10) stepDriver(driver, neutralCmd([0, 90, 0]), 1);
    expect(driver.pm.onGround).toBe(true);
    expectInWorld(driver.pm.origin, map);
    // And the player can still move out afterward — never stuck. Head back
    // south the way they came (open floor, down the step).
    const bx = driver.pm.origin[0]!;
    const by = driver.pm.origin[1]!;
    stepDriver(driver, { msec: 100, angles: [0, 270, 0], forwardmove: 100, sidemove: 0, upmove: 0, buttons: 0 }, 8);
    expect(Math.hypot(driver.pm.origin[0]! - bx, driver.pm.origin[1]! - by)).toBeGreaterThan(5);
    expect(driver.pm.onGround).toBe(true);
    expectInWorld(driver.pm.origin, map);
  });

  it('(m) shotgun-secret crawlspace barrels die to blaster fire', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    // The two exploboxes by the shotgun secret, plus the *30 slab between
    // them (112x120x19 brush rendered as grafted geometry, never a barrel
    // proxy). All three take direct blaster fire through the clip-attributed
    // touch.
    const at = (x: number, y: number): NonNullable<ReturnType<typeof driver.server.barrels.find>> =>
      driver.server.barrels.find((b) => !b.isFunc && Math.abs(b.origin[0]! - x) < 2 && Math.abs(b.origin[1]! - y) < 2)!;
    const b1 = at(950, -198);
    const b2 = at(1060, -140);
    const b30 = driver.server.barrels.find((b) => b.isFunc && b.edict.model === '*30')!;
    expect(b1).toBeDefined();
    expect(b2).toBeDefined();
    expect(b30).toBeDefined();
    // West stand with a clear lane to the first barrel; a level bead flies
    // at z≈-178, inside the -192..-152 hull band.
    driver.pm.origin = v3(900, -198, -168);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    expect(driver.pm.onGround).toBe(true);
    const yaw1 = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [950, -198]);
    let ticks = 0;
    while (!b1.edict.freed && ticks++ < 60) driver.step(attackCmd([0, yaw1, 0]), 0.1);
    expect(b1.edict.freed).toBe(true);
    // The 150-dmg blast at ~50u would mince the bot (attacker-half ~62):
    // top the pool back up so the demo continues (setup only; every
    // verdict below is rendered/submitted state).
    SV_SetPlayerHealth(driver.server, 100);
    stepDriver(driver, neutralCmd(), 5);
    // Second barrel from the north stand (a chain may free it early — the
    // loop then exits immediately, honestly).
    driver.pm.origin = v3(1060, -70, -168);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    const yaw2 = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [1060, -140]);
    ticks = 0;
    while (!b2.edict.freed && ticks++ < 60) driver.step(attackCmd([0, yaw2, 0]), 0.1);
    expect(b2.edict.freed).toBe(true);
    SV_SetPlayerHealth(driver.server, 100);
    stepDriver(driver, neutralCmd(), 5);
    // The *30 slab itself, aimed at its bbox center from the west stand.
    driver.pm.origin = v3(900, -184, -168);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    const aimSlab = (): [number, number, number] => {
      const e = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
      const c = [b30.origin[0]!, b30.origin[1]!, b30.origin[2]!];
      const dx = c[0]! - e[0]!;
      const dy = c[1]! - e[1]!;
      const dz = c[2]! - e[2]!;
      const l = Math.hypot(dx, dy) || 1;
      return [(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0];
    };
    ticks = 0;
    while (!b30.edict.freed && ticks++ < 60) driver.step(attackCmd(aimSlab()), 0.1);
    expect(b30.edict.freed).toBe(true);
    stepDriver(driver, neutralCmd(), 5);
    // RENDERED verdicts: the dead brush fully opened (clip gone), the blasts
    // submitted, and none of the three renders as a barrel anymore.
    expect(driver.server.brushClips.has(b30.edict.num)).toBe(false);
    expect(driver.events.filter((e) => e === 'barrel').length).toBeGreaterThanOrEqual(3);
    expect(driver.events).toContain('explosion');
    expect(driver.server.debris.length).toBeGreaterThan(0);
    const extras = driver.extraEntities()!;
    for (const [tx, ty] of [[950, -198], [1060, -140]] as const) {
      expect(
        extras.filter((x) => x.model === boot.models!.barrel && Math.hypot(x.origin![0]! - tx, x.origin![1]! - ty) < 1),
      ).toHaveLength(0);
    }
    expect(driver.pm.onGround).toBe(true);
    expectInWorld(driver.pm.origin, map);
  });

  it('(n) all 9 exploboxes rest on the hull-trace floor (server + rendered)', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    // The sim truth: the clip-wrapped C-mask trace the driver moves with.
    const trace = SV_ClipTrace(driver.server, SV_TraceFor(map));
    const boxes = driver.server.barrels.filter((b) => !b.isFunc);
    expect(boxes).toHaveLength(9);
    // Rendered roster mirrors the live roster 1:1 (no doubles): 9 explobox
    // meshes at their hull bottoms. func_explosive walls render as grafted
    // brush geometry (DoorSync), NEVER as barrel proxies — the spawn room
    // shows 2 barrel MD2s, not 3.
    const rendered = driver.extraEntities()!.filter((x) => x.model === boot.models!.barrel);
    expect(rendered).toHaveLength(9);
    for (const b of boxes) {
      // Server hull rests on the floor: a 256-down hull drop ends at the
      // origin (C M_droptofloor contact rides the 1/32 epsilon, never a
      // hover — 0.05 tolerance).
      const drop = trace(
        v3(b.origin[0], b.origin[1], b.origin[2]! + 1),
        EXPLOBOX_MINS,
        EXPLOBOX_MAXS,
        v3(b.origin[0], b.origin[1], b.origin[2]! - 256),
      );
      expect(drop.endpos[2]!).toBeCloseTo(b.origin[2]!, 1);
      // The rendered mesh bottom (MD2 pivot = box bottom = origin) sits on
      // that same floor.
      const got = rendered.find(
        (x) => Math.hypot(x.origin![0]! - b.origin[0]!, x.origin![1]! - b.origin[1]!) < 1,
      );
      expect(got).toBeDefined();
      expect(got!.origin![2]!).toBeCloseTo(b.origin[2]!, 1);
      expect(got!.origin![2]!).toBeCloseTo(drop.endpos[2]!, 1);
    }
  });

  it('(o) the spawn "third barrel" is brush glass: lump 2 explobox + *20, renders closed, dies to fire', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    // Lump evidence: the start room holds exactly 2 misc_explobox near
    // spawn plus the func_explosive *20 wall (the "third" is a window, not
    // a barrel). *20 carries no spawnflags (always solid, C SP_ default).
    const dicts = parseEntities(map.entities);
    const nearSpawn = dicts.filter((d) => {
      if (d['classname'] !== 'misc_explobox' || !d['origin']) return false;
      const o = d['origin']!.split(' ').map(Number);
      return Math.hypot(o[0]! - 128, o[1]! + 320) < 400;
    });
    expect(nearSpawn).toHaveLength(2);
    const w20dict = dicts.find((d) => d['classname'] === 'func_explosive' && d['model'] === '*20')!;
    expect(w20dict).toBeDefined();
    expect(w20dict['spawnflags']).toBeUndefined();
    expect(w20dict['target']).toBe('t78');
    const spawnBoxes = driver.server.barrels.filter(
      (b) => !b.isFunc && Math.hypot(b.origin[0]! - 128, b.origin[1]! + 320) < 400,
    );
    expect(spawnBoxes).toHaveLength(2);
    // Glass evidence: every *20 face is the TRANS33 window texture
    // (e1u1/wndow0_3, SURF_TRANS33 0x10 — qfiles.h) across the corridor.
    const first = map.modelsExtra[20 * MODEL_EXTRA_STRIDE + 1]!;
    const num = map.modelsExtra[20 * MODEL_EXTRA_STRIDE + 2]!;
    expect(num).toBe(17);
    for (let f = first; f < first + num; f++) {
      const ti = map.faces[f * FACE_STRIDE + 4]!;
      expect(map.texinfoFlags[ti]! & 16).toBe(16);
      expect(map.texinfoNames[ti]).toContain('wndow');
    }
    // Server: one isFunc barrel record for the brush, clip standing.
    const w20 = driver.server.barrels.find((b) => b.isFunc && b.edict.model === '*20')!;
    expect(w20).toBeDefined();
    expect(driver.server.brushClips.has(w20.edict.num)).toBe(true);
    // Rendered CLOSED at spawn via the DoorSync (zero displacement) with
    // all 17 live faces grafted into the leaf lists ...
    const off20 = driver.doorRenderOffset('*20');
    expect(off20).not.toBeNull();
    expect(mag3(off20!)).toBeLessThan(0.01);
    const inLists = new Set<number>();
    for (const leaf of driver.mini.leafs) {
      for (const f of leaf.faceList ?? []) inLists.add(f);
    }
    for (let f = first; f < first + num; f++) {
      if (!driver.mini.surfaces[f]?.n) continue;
      expect(inLists.has(f)).toBe(true);
    }
    // ... and NEVER as a barrel MD2: no barrel proxy anywhere near the
    // window bbox (x -72..128, y 136..144).
    const extras = driver.extraEntities()!;
    expect(
      extras.filter(
        (x) =>
          x.model === boot.models!.barrel &&
          x.origin![0]! > -80 && x.origin![0]! < 136 && x.origin![1]! > 128 && x.origin![1]! < 152,
      ),
    ).toHaveLength(0);
    // Still killable: dead-on blaster from the south stand latches the
    // barrel_delay fuse on the brush itself (commit e2227bb kept).
    driver.pm.origin = v3(28, 60, 30);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    let ticks = 0;
    while (!w20.edict.freed && ticks++ < 40) driver.step(attackCmd([0, 90, 0]), 0.1);
    expect(w20.edict.freed).toBe(true);
    stepDriver(driver, neutralCmd(), 5);
    // RENDERED verdict: the fuse blew (explosion + debris submitted), the
    // brush clip opened, the graft stripped all 17 faces (the *30 control
    // stays grafted), and no barrel MD2 renders at the wall.
    expect(driver.server.brushClips.has(w20.edict.num)).toBe(false);
    expect(driver.events).toContain('barrel');
    expect(driver.events).toContain('explosion');
    const inListsAfter = new Set<number>();
    for (const leaf of driver.mini.leafs) {
      for (const f of leaf.faceList ?? []) inListsAfter.add(f);
    }
    for (let f = first; f < first + num; f++) expect(inListsAfter.has(f)).toBe(false);
    const s30 = map.modelsExtra[30 * MODEL_EXTRA_STRIDE + 1]!;
    const n30 = map.modelsExtra[30 * MODEL_EXTRA_STRIDE + 2]!;
    expect(driver.mini.surfaces[s30]?.n).toBeGreaterThan(0);
    expect(inListsAfter.has(s30!)).toBe(true);
    expect(n30).toBe(83);
    const extrasAfter = driver.extraEntities()!;
    expect(
      extrasAfter.filter(
        (x) =>
          x.model === boot.models!.barrel &&
          x.origin![0]! > -80 && x.origin![0]! < 136 && x.origin![1]! > 128 && x.origin![1]! < 152,
      ),
    ).toHaveLength(0);
    expectInWorld(driver.pm.origin, map);
  });

  it('(p) all 12 dead soldiers render at their lump origins in the C pose', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Lump evidence: base1 fields 12 misc_deadsoldier (g_misc.c
    // SP_misc_deadsoldier — corpse in a fixed pose, non-triggered).
    const dicts = parseEntities(driver.map!.entities);
    const corpses = dicts.filter((d) => d['classname'] === 'misc_deadsoldier');
    expect(corpses).toHaveLength(12);
    // Server: every one spawns (SP-only sim keeps them all — C removes
    // them only in deathmatch) as a permanent SOLID_BBOX edict.
    const spawned = driver.server.entities.filter((e) => !e.freed && e.classname === 'misc_deadsoldier');
    expect(spawned).toHaveLength(12);
    for (const e of spawned) {
      expect(e.solid).toBe(SOLID_BBOX);
      expect([...e.mins]).toEqual([-16, -16, 0]);
      expect([...e.maxs]).toEqual([16, 16, 16]);
    }
    // Rendered: the deadbod dude MD2 + skin are registered, and every
    // corpse submits at its lump origin + lump yaw in the C pose frame
    // (spawnflags bits, first match wins — deadsoldierFrameForSpawnflags).
    expect(boot.models!.corpse).toBeGreaterThanOrEqual(0);
    expect(boot.models!.corpseSkin).toBeGreaterThanOrEqual(0);
    const extras = driver.extraEntities()!;
    const rendered = extras.filter((x) => x.model === boot.models!.corpse);
    expect(rendered).toHaveLength(12);
    for (const d of corpses) {
      const o = d['origin']!.split(' ').map(Number);
      const got = rendered.find((x) => Math.hypot(x.origin![0]! - o[0]!, x.origin![1]! - o[1]!) < 1);
      expect(got).toBeDefined();
      expect(got!.origin![2]).toBe(o[2]);
      expect(got!.skin).toBe(boot.models!.corpseSkin);
      const wantFrame = deadsoldierFrameForSpawnflags(parseInt(d['spawnflags'] ?? '0', 10));
      expect(got!.frame).toBe(wantFrame);
      const wantYaw = parseFloat(d['angle'] ?? '0', 0);
      expect(got!.angles![1]).toBe(wantYaw);
    }
    // The door-debris corpse by the start lines (40,272,-64, frame 1)
    // renders with the rest of the roster.
    const doorCorpse = rendered.find((x) => Math.hypot(x.origin![0]! - 40, x.origin![1]! - 272) < 1)!;
    expect(doorCorpse).toBeDefined();
    expect(doorCorpse.frame).toBe(1);
    // Corpses persist: they ride extraEntities (never freed, never in the
    // snapshot corpse path) after ticks advance.
    stepDriver(driver, neutralCmd(), 10);
    expect(driver.extraEntities()!.filter((x) => x.model === boot.models!.corpse)).toHaveLength(12);
  });
});
