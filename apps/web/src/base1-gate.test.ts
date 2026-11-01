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
//   (q) a dying soldier fires its last-ditch shot (death1 frames 21/24):
//       the foe bolt renders in flight out of the corpse's muzzle, aimed
//       back at the player, plus the muzzle-flash drain.
//   (r) exit-door-open leaves the lift parked: camping the hall opens and
//       parks the *32/*33 sliders while the targetname'd *31 plug (C: no
//       touch trigger) stays at pos1 and the *12 func_train never starts —
//       the sim origin stays (0,0,0) and the rendered offset stays 0 while
//       the entry doors cycle around the walker (no t91/t4 cascade).
//   (s) walk-out from the debris spot (-384.4,33.8,-16): the body settles
//       from above onto the func_wall *9 slab top and walks N/S/E standing,
//       N crouched, and W to the world rock face at x=-412 (the stop is the
//       C world trace blocking, not glue); a soldier chasing through the
//       spot reaches the player. No jump anywhere.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { BUTTON_DUCK, BUTTON_USE } from '@q2/input';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { Entity } from '@q2/renderer-api';
import { MODEL_EXTRA_STRIDE, traceBox, FACE_STRIDE } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import { EXPLOBOX_MAXS, EXPLOBOX_MINS, PMF_DUCKED, SOLID_BBOX, deadsoldierFrameForSpawnflags, parseEntities, parseFloat } from '@q2/game';
import { SV_ClipTrace, SV_SetPlayerHealth, SV_TraceFor, SV_UseMover, MASK_OPAQUE_C, MASK_PLAYERSOLID_C } from '@q2/server';
import { bootPlay, rebootPlay, pumpExplosionLights, drawPlayHud, FINISH_BLUE, formatLevelTime } from './play.js';

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
    // Face the beat cop at the player: #341 walks the t16/t15 patrol and
    // starts facing south — C FindTarget needs facing at near range, so an
    // un-turned staging would wait for the beat to turn (RELEASE-13). The
    // chase/run/return-fire verdicts below are the same either way.
    A.state.yaw = 90;
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
    // *32 entry slider (touchable: no targetname/health, so C SP_func_door
    // spawns its rest-bounds trigger — the targetname'd *31 plug owns none
    // and can no longer cover this leg). No monster camps its volume, so the
    // cycle completes once the player leaves.
    const off0 = driver.doorRenderOffset('*32');
    expect(off0).not.toBeNull();
    expect(mag3(off0!)).toBeLessThan(0.01); // renders CLOSED at spawn
    // Walk into the *32 rest volume: the server Touch_DoorTrigger opens it.
    driver.pm.origin = v3(-1684, 1488, 120);
    driver.pm.velocity = v3();
    let open = 0;
    for (let i = 0; i < 120 && open < 30; i++) {
      driver.step(neutralCmd(), 0.1);
      open = mag3(driver.doorRenderOffset('*32')!);
    }
    expect(open).toBeGreaterThanOrEqual(30); // slider travels 64u; rendered
    // Leave the volume and wait out the hold + return leg: the rendered slab
    // rides back to the closed pose.
    driver.pm.origin = v3(128, -320, 32);
    driver.pm.velocity = v3();
    let shut = open;
    let n = 0;
    while (shut >= 0.5 && n++ < 400) {
      driver.step(neutralCmd(), 0.1);
      shut = mag3(driver.doorRenderOffset('*32')!);
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
    // Stage the player inside the runner's facing cone: the seated body is
    // the start-room ambusher (mapper yaw 315, southeast), and C FindTarget
    // needs facing at near range — a stage behind its back correctly stays
    // silent (RELEASE-13 gating), which would wedge the pursuit below. The
    // probed spot (+60,-40: dist ~73 NEAR, yaw -34 dead in the cone) keeps
    // eye-to-eye LOS from the stairs.
    const PB2 = seat(lowA[0] + 60, lowA[1] - 40);
    driver.pm.origin = v3(PB2[0], PB2[1], PB2[2]);
    driver.pm.velocity = v3();
    // Pre-chase geometry for the validity pair below (the runner closes
    // during the acquire ticks, so post-move origins would skew it).
    const M: [number, number, number] = [lowA[0], lowA[1], lowA[2]];
    const L: [number, number, number] = [PB2[0], PB2[1], PB2[2]];
    expect(los(M, L)).toBe(true);
    for (let i = 0; i < 5; i++) driver.step(neutralCmd(), 0.1);
    expect(runner.seen).toBe(true);
    // Hidden spot off the M->L axis (a beeliner stalls at the corner wall
    // far from L instead of rounding to it — the validity pair below).
    const H = seat(350, -700);
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
      // Same facing staging as (b): #341 starts its beat facing away, and C
      // sight needs facing — without this the latch waits for the patrol
      // turn instead of the first tick.
      A.state.yaw = 90;
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
    // C PM_CheckDuck: the ducked eye sits 2 below the origin (feet+22).
    expect(driver.pm.viewheight).toBe(-2);
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

  it('(q) a dying soldier fires its last-ditch shot: foe bolt + muzzle render', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // Courtyard light soldier #341 (skin 0 -> blaster -> a real foe bolt on
    // death, m_soldier.c soldier_move_death1 frames 21/24). The ambush
    // latches once the player overlooks the courtyard (gate (b) proves the
    // lane), so the body is hittable and stays in the open.
    const A = driver.server.monsters.find((m) => m.edict.num === 341)!;
    expect(A.edict.extra['skinnum']).toBe('0');
    driver.pm.origin = v3(-904, 1326, -24);
    driver.pm.velocity = v3();
    // Kill it with aimed blaster fire (20hp light = 2 hits), strafing the
    // return fire the way (b) does. The tick the corpse lands is K.
    let killedAt = -1;
    let strafe = 1;
    for (let t = 0; t < 200 && killedAt < 0 && driver.playerHealth > 0; t++) {
      if (t % 40 === 0) strafe = -strafe as 1 | -1;
      const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [A.edict.origin[0]!, A.edict.origin[1]!]);
      driver.step(attackCmd([0, yaw, 0]), 0.1);
      if (A.state.dead) killedAt = t;
    }
    expect(killedAt).toBeGreaterThanOrEqual(0);
    expect(driver.playerHealth).toBeGreaterThan(0);
    // Soldier death is a rand()%5 roll (C soldier_die): only death1 is
    // armed (frames 21/24). Other rolls render their own unarmed C falls —
    // the watch below branches on the rolled move instead of assuming
    // death1, and the deterministic death1 render pin lives in (q2).
    const deathMove = A.state.move;
    expect(['death1', 'death2', 'death4', 'death5', 'death6'].includes(deathMove)).toBe(true);
    const corpse: [number, number] = [A.edict.origin[0]!, A.edict.origin[1]!];
    const monshotsBefore = driver.events.filter((e) => e === 'monshot').length;
    // Watch the death move: a bearing-passing foe bolt counts only when the
    // corpse's own frame is on an armed frame (21/24) — cross-traffic from
    // the alerted courtyard fails the frame correlation, which is what made
    // the old wall-clock window (boltSeenAt >= 16) flake.
    let boltSeenAt = -1;
    let monshotTick = -1;
    let s2 = 1;
    for (let k = 1; k <= 45 && driver.playerHealth > 0; k++) {
      if (k % 40 === 0) s2 = -s2 as 1 | -1;
      const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [corpse[0], corpse[1]]);
      driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 0, sidemove: 400 * s2, upmove: 0, buttons: 0 }, 0.1);
      const armed = A.state.move === 'death1' && A.state.frame >= 20 && A.state.frame <= 26;
      const wantYaw = yawAt(corpse, [driver.pm.origin[0]!, driver.pm.origin[1]!]);
      for (const x of driver.extraEntities() ?? []) {
        if (x.model !== boot.models!.bolt) continue;
        // Out of the corpse's muzzle, flying at us: near the corpse→player
        // lane (a 600u/s bolt covers ~60u/tick, so the spawn tick reads
        // close and later ticks read downrange) and on the corpse→player
        // bearing. Live fire from elsewhere fails the bearing pin; the
        // spawn-tick position fails the lane pin for cross-traffic.
        if (Math.hypot(x.origin![0]! - corpse[0]!, x.origin![1]! - corpse[1]!) > 400) continue;
        let dy = Math.abs(x.angles![1]! - wantYaw) % 360;
        if (dy > 180) dy = 360 - dy;
        if (dy < 20 && boltSeenAt < 0 && armed) boltSeenAt = k;
      }
      if (driver.events.filter((e) => e === 'monshot').length > monshotsBefore && monshotTick < 0 && armed) monshotTick = k;
    }
    if (deathMove === 'death1') {
      // The C armed frames (21/24, ~2.1s/2.4s after death) submit a foe
      // bolt in flight out of the corpse's muzzle, aimed back at the
      // player — plus the muzzle flash drain (monshot sound same tick).
      expect(boltSeenAt).toBeGreaterThanOrEqual(16);
      expect(boltSeenAt).toBeLessThanOrEqual(36);
      expect(monshotTick).toBeGreaterThanOrEqual(16);
      expect(monshotTick).toBeLessThanOrEqual(36);
    } else {
      // Unarmed C falls never fire: the corpse settles on its last frame
      // and persists hittable in the snapshot (no frame-correlated bolt).
      expect(boltSeenAt).toBe(-1);
      expect(A.state.deadDone).toBe(true);
      expect(driver.entityFrame(A.edict.num)).toBeGreaterThan(0);
    }
  });

  it('(q2) seeded death1 last-ditch shot renders: foe bolt + muzzle (Q2_PAK)', { timeout: 180000 }, async () => {
    // Deterministic death1 render pin for (q): a synthetic courtyard
    // soldier minced through the PRODUCTION damage path with controlled RNG
    // (soldier_die rand()%5 roll 0 → armed death1), then stepped through the
    // real driver loop — damage→server→snapshot→renderer with no wall clock.
    const boot = await bootBase1();
    const { driver } = boot;
    const { SV_SpawnMonster, SV_DamageMonster } = await import('@q2/server');
    // #341's own overlook cell: proven open with a working bolt lane (gate
    // (b) trades shots here). Corridor/corner synthetics plant the muzzle
    // inside rock and the bolt dies on its first step (monshot with no
    // render — debugged, not assumed). Skin 0 (light → blaster): death1's
    // last-ditch fires real foe bolts; a skin-2 body shotguns instead (C
    // soldier_fire skin gun — verified by a 2hp pellet hit mid-debug).
    const m = SV_SpawnMonster(driver.server, 'monster_soldier_light', v3(-904, 976, -24));
    m.state.yaw = 90; // face the staged player
    driver.pm.origin = v3(-904, 1326, -24);
    driver.pm.velocity = v3();
    expect(SV_DamageMonster(driver.server, m, 25, () => 0.05)).toBe('dead');
    expect(m.state.move).toBe('death1');
    const corpse: [number, number] = [m.edict.origin[0]!, m.edict.origin[1]!];
    const monshotsBefore = driver.events.filter((e) => e === 'monshot').length;
    let boltSeenAt = -1;
    let monshotTick = -1;
    for (let k = 1; k <= 40 && driver.playerHealth > 0; k++) {
      SV_SetPlayerHealth(driver.server, 100);
      const yaw = yawAt([driver.pm.origin[0]!, driver.pm.origin[1]!], [corpse[0], corpse[1]]);
      driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 0, sidemove: 400, upmove: 0, buttons: 0 }, 0.1);
      const armed = m.state.frame >= 20 && m.state.frame <= 26;
      const wantYaw = yawAt([m.edict.origin[0]!, m.edict.origin[1]!], [driver.pm.origin[0]!, driver.pm.origin[1]!]);
      for (const x of driver.extraEntities() ?? []) {
        if (x.model !== boot.models!.bolt) continue;
        if (Math.hypot(x.origin![0]! - corpse[0]!, x.origin![1]! - corpse[1]!) > 400) continue;
        let dy = Math.abs(x.angles![1]! - wantYaw) % 360;
        if (dy > 180) dy = 360 - dy;
        if (dy < 20 && boltSeenAt < 0 && armed) boltSeenAt = k;
      }
      if (driver.events.filter((e) => e === 'monshot').length > monshotsBefore && monshotTick < 0 && armed) monshotTick = k;
    }
    // Armed frames 21/24 render the foe bolt + muzzle inside the window.
    expect(boltSeenAt).toBeGreaterThanOrEqual(19);
    expect(boltSeenAt).toBeLessThanOrEqual(30);
    expect(monshotTick).toBeGreaterThanOrEqual(19);
    expect(monshotTick).toBeLessThanOrEqual(30);
    // The fall settles on its last frame and stays submitted.
    expect(m.state.deadDone).toBe(true);
    expect(driver.entityFrame(m.edict.num)).toBeGreaterThan(0);
  });

  it('(r) exit-door-open leaves the lift parked (mesh + sim)', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // The end-of-level lift: the *12 func_train waits for the *13 button
    // (t91) and parks at its first corner (origin == brush rest).
    const train = driver.server.trains.find((t) => !t.ship)!;
    expect(train.ent.model).toBe('*12');
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    expect(train.started).toBe(false);
    expect(driver.doorRenderOffset('*12')).toEqual([0, 0, 0]);
    // Watch every tick for a relay cascade (the server unit pin fired
    // targetnames headlessly; here the full driver loop runs — triggers,
    // pickups, monster door touches, fuses — exactly like the game).
    const fired = new Set<string>();
    // Phase 1: camp the hall the way the game does — the body overlaps the
    // *32/*33 rest volumes so the sliders open and park, while the
    // targetname'd *31 plug (C SP_func_door: no touch trigger) sits out the
    // whole camp and the named lift never starts.
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    let sliderTravel = 0;
    let plugTravel = 0;
    for (let i = 0; i < 120; i++) {
      driver.step(neutralCmd(), 0.1);
      for (const t of driver.server.firedThisTick) fired.add(t);
      sliderTravel = Math.max(
        sliderTravel,
        mag3(driver.doorRenderOffset('*32')!),
        mag3(driver.doorRenderOffset('*33')!),
      );
      plugTravel = Math.max(plugTravel, mag3(driver.doorRenderOffset('*31')!));
      expect(train.started).toBe(false);
      expect([...train.ent.origin]).toEqual([0, 0, 0]);
    }
    // Non-vacuous: the sliders genuinely travelled (64u sideways each) ...
    expect(sliderTravel).toBeGreaterThan(30);
    // ... while the plug never moved a unit, nobody fired its relay, and
    // the lift never started.
    expect(plugTravel).toBeLessThan(0.01);
    const plug31 = driver.server.movers.find((m) => m.ent.model === '*31')!;
    expect([...plug31.ent.origin]).toEqual([...plug31.pos1]);
    expect(fired.has('t91')).toBe(false);
    expect(fired.has('t4')).toBe(false);
    // Phase 2: the real walk-in through the *32/*33 entry doors.
    driver.pm.origin = v3(-1560, 1536, 150);
    driver.pm.velocity = v3();
    let doorCycle = 0;
    for (let i = 0; i < 200 && driver.playerHealth > 0; i++) {
      driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      for (const t of driver.server.firedThisTick) fired.add(t);
      doorCycle = Math.max(doorCycle, mag3(driver.doorRenderOffset('*32')!));
    }
    // Non-vacuous: the entry doors cycled as the bot walked through.
    expect(doorCycle).toBeGreaterThan(30);
    // RENDERED + SIM verdict: the lift never started and never moved — the
    // brush mesh sits at the parked pose while the doors cycled, and the
    // plug stayed shut throughout (no t91/t4 cascade, no graft coupling).
    expect(fired.has('t91')).toBe(false);
    expect(fired.has('t4')).toBe(false);
    expect(train.started).toBe(false);
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    expect(driver.doorRenderOffset('*12')).toEqual([0, 0, 0]);
    expect(mag3(driver.doorRenderOffset('*31')!)).toBeLessThan(0.01);
    expect([...plug31.ent.origin]).toEqual([...plug31.pos1]);
  });

  it('(t) the exit lift waits for the player: doors park while camped, the plug cycles on *34, the train runs once and parks', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // The exit lift complex: the *31 plug (drops 156 on t4, C-default hold),
    // the *32/*33 entry sliders (64 sideways each), and the *12 func_train
    // (t91 → t88 → t89 (wait .5) → t90, one-way). Lump geometry: the reported
    // spot sits just east of the *32 door, inside the *32/*33 rest volumes
    // but overlapping NO trigger of the targetname'd plug.
    const train = driver.server.trains.find((t) => t.ent.model === '*12')!;
    expect(train).toBeDefined();
    const plug = driver.server.movers.find((m) => m.ent.model === '*31')!;
    const btn34 = driver.server.movers.find((m) => m.ent.model === '*34')!;
    expect(btn34.wait).toBe(3); // C SP_func_button default (not 1)
    // Phase 1: camp the reported spot — nearby, aboard nothing — 400 ticks.
    // C rest-baked Touch_DoorTrigger volumes open the sliders once and the
    // TOP wait keeps resetting while camped: they park open instead of
    // cycling. The targetname'd plug owns no trigger (C SP_func_door), so
    // it sits at pos1 no matter how long the lean lasts — pre-fix this same
    // lean lowered it (the reported "elevator descends as its door opens").
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 5);
    expect(driver.pm.onGround).toBe(true);
    const off = (m: string): [number, number, number] => driver.doorRenderOffset(m)!;
    expect(off('*31')).not.toBeNull();
    expect(off('*32')).not.toBeNull();
    expect(off('*33')).not.toBeNull();
    expect(off('*12')).not.toBeNull();
    const park31: Array<[number, number, number]> = [];
    const park32: Array<[number, number, number]> = [];
    const park33: Array<[number, number, number]> = [];
    const fired = new Set<string>();
    for (let i = 0; i < 400; i++) {
      SV_SetPlayerHealth(driver.server, 100); // setup: hold the camper alive
      driver.step(neutralCmd(), 0.1);
      for (const t of driver.server.firedThisTick) fired.add(t);
      // The lift never starts while the doors park: no t91/t4 cascade.
      expect(train.started).toBe(false);
      expect([...train.ent.origin]).toEqual([0, 0, 0]);
      expect(off('*12')).toEqual([0, 0, 0]);
      if (i >= 60) {
        park31.push(off('*31'));
        park32.push(off('*32'));
        park33.push(off('*33'));
      }
    }
    // Non-vacuous: the sliders genuinely travelled open (64 sideways) and
    // parked — rendered offsets frozen.
    expect(mag3(off('*32'))).toBeGreaterThan(30);
    expect(mag3(off('*33'))).toBeGreaterThan(30);
    for (const [nm, trace] of [['*32', park32], ['*33', park33]] as const) {
      for (const o of trace) expect(o).toEqual(trace[0]);
      void nm;
    }
    // ... while the plug never moved and no relay fired the whole camp.
    for (const o of park31) expect(o).toEqual([0, 0, 0]);
    expect([...plug.ent.origin]).toEqual([...plug.pos1]);
    expect(fired.has('t91')).toBe(false);
    expect(fired.has('t4')).toBe(false);
    // Phase 2: the C-intended opener — E-use the *34 elevator button. It
    // hovers centered above the doorway (RELEASE-4 over-door housing), so
    // the press is an aimed E-use from the slot face at the live bounds
    // center (the server-lane E-use pattern): the driver loop fires t4 on
    // the button's TOP arrival, never on touch.
    driver.pm.origin = v3(-1688, 1536, 120);
    driver.pm.velocity = v3();
    const aimUse34 = (): void => {
      const b = driver.server.moverBounds.get(btn34.ent.num)!;
      const cx = (b.mins[0]! + b.maxs[0]!) / 2, cy = (b.mins[1]! + b.maxs[1]!) / 2, cz = (b.mins[2]! + b.maxs[2]!) / 2;
      const ex = driver.pm.origin[0]!, ey = driver.pm.origin[1]!, ez = driver.pm.origin[2]! + 22;
      const dx = cx - ex, dy = cy - ey, dz = cz - ez;
      const lh = Math.hypot(dx, dy) || 1;
      const pitch = (Math.atan2(-dz, lh) * 180) / Math.PI;
      const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
      driver.step({ msec: 100, angles: [pitch, yaw, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_USE }, 0.1);
    };
    let t4first = -1;
    let tick = 0;
    for (let i = 0; i < 10 && t4first < 0; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      aimUse34();
      tick++;
      if (driver.server.firedThisTick.includes('t4')) t4first = tick;
    }
    expect(t4first).toBeGreaterThanOrEqual(0); // the face E-use fired t4
    expect(btn34.state).not.toBe('bottom');
    // Step out of the slot at once: the E-use press holds no overlap (the
    // housing is above every hull), so the pure C cycle below is measured
    // without a rider near the button.
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    // The plug drops the full 156 (pos1 z 0 → pos2 z -156), rendered and
    // simulated identically — while the lift sits out the cycle. (Movers
    // step in whole ticks, so poll to the clamped pos2, not past it.)
    let guard = 0;
    while (plug.ent.origin[2]! > -155 && guard++ < 100) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      tick++;
      expect(driver.server.firedThisTick.includes('t4')).toBe(false);
    }
    expect(plug.ent.origin[2]!).toBeCloseTo(-156, 0);
    expect(mag3(off('*31'))).toBeGreaterThan(100);
    expect(train.started).toBe(false);
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    // Intended wait at the top: the C-default hold (~3s), then the return.
    // (No t4 anywhere in here: the rider left the button, so the hold is
    // the pure door wait — a re-press would stretch it, which is exactly
    // what the old touch-plug bug did every camp tick.)
    let holdTicks = 0;
    guard = 0;
    while (plug.state !== 'bottom' && guard++ < 400) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      tick++;
      expect(driver.server.firedThisTick.includes('t4')).toBe(false);
      if (plug.state === 'waiting' || plug.state === 'top') holdTicks++;
      expect(train.started).toBe(false);
    }
    expect(holdTicks).toBeGreaterThanOrEqual(28);
    expect(holdTicks).toBeLessThanOrEqual(32);
    expect([...plug.ent.origin]).toEqual([...plug.pos1]);
    expect(off('*31')).toEqual([0, 0, 0]);
    // Repeat use: the button cycled back to BOTTOM on its own 3s, so a
    // second face E-use re-fires t4 and the plug drops again.
    expect(btn34.state).toBe('bottom');
    driver.pm.origin = v3(-1688, 1536, 120);
    driver.pm.velocity = v3();
    let t4second = -1;
    for (let i = 0; i < 10 && t4second < 0; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      aimUse34();
      tick++;
      if (driver.server.firedThisTick.includes('t4')) t4second = tick;
    }
    expect(t4second).toBeGreaterThan(t4first + 25); // a separate later cycle
    guard = 0;
    while (plug.ent.origin[2]! > -155 && guard++ < 120) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      tick++;
    }
    expect(plug.ent.origin[2]!).toBeCloseTo(-156, 0);
    expect(train.started).toBe(false);
    expect(driver.playerHealth).toBeGreaterThan(0);
    expectInWorld(driver.pm.origin, driver.map!);
    // Phase 3: press the lift's call button. The driver has no
    // button-touch path for the health-gated *13, so the press runs the
    // button's own use entry — the same call its E-use/shot would make —
    // and every verdict below is rendered or sim-travel state. Park the body
    // back at the safe hall camp first (movers are not solid to the driver
    // trace, so the lift's travel and park are what this pins).
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    expectInWorld(driver.pm.origin, driver.map!);
    const btn = driver.server.movers.find((m) => m.ent.model === '*13')!;
    expect(btn).toBeDefined();
    SV_UseMover(driver.server, btn);
    // Step back to the safe camp while the lift runs (arrival must park
    // with no second cycle and nobody aboard).
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      peak = Math.max(peak, mag3(off('*12')));
    }
    // RENDERED verdict: the lift travelled (offset peaked far from rest).
    expect(peak).toBeGreaterThan(10);
    // Arrival: the far corner t90 (-2080,1472,-8) minus the brush-mins base
    // (-2064,1472,-48) = (-16, 0, 40), rendered and simulated identically.
    const endOff = off('*12');
    expect(endOff[0]!).toBeCloseTo(-16, 0);
    expect(endOff[1]!).toBeCloseTo(0, 0);
    expect(endOff[2]!).toBeCloseTo(40, 0);
    expect(train.arrived).toBe(true);
    expect(train.ent.origin[0]!).toBeCloseTo(-16, 6);
    expect(train.ent.origin[1]!).toBeCloseTo(0, 6);
    expect(train.ent.origin[2]!).toBeCloseTo(40, 6);
    // Parks again with nobody aboard: 150 ticks, zero further motion.
    for (let i = 0; i < 150; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      expect(off('*12')).toEqual(endOff);
    }
    expect(train.arrived).toBe(true);
    expect(driver.playerHealth).toBeGreaterThan(0);
    expectInWorld(driver.pm.origin, driver.map!);
  });

  it('(s) walk-out from the debris spot (-384.4,33.8,-16), both hulls + soldier', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const map = driver.map!;
    // The solid under the spot is the LIVE func_wall *9 slab (standing
    // clip, C SOLID_BSP — not a leftover freed clip, not debris): pin it.
    const w9 = driver.server.entities.find((e) => !e.freed && e.classname === 'func_wall' && e.model === '*9')!;
    expect(w9).toBeDefined();
    expect(driver.server.brushClips.has(w9.num)).toBe(true);
    // The old clip sweep landed exactly on contact (feet -40 = slab top
    // -40), so every overlapping sweep read allsolid and the body glued
    // (0.0 in every direction). The C DIST_EPSILON enter bias lands +1/32
    // proud, so settle from above the way the engine does (an exact-plane
    // teleport wedges even in C — d1 == 0 counts as inside — exactly like
    // gate (l), so the test falls in, never teleports exact).
    const settle = (): void => {
      driver.pm.origin = v3(-384.4, 33.8, 60);
      driver.pm.velocity = v3();
      for (let i = 0; i < 30; i++) driver.step(neutralCmd(), 0.1);
      expect(driver.pm.onGround).toBe(true);
    };
    settle();
    expect(driver.pm.origin[0]!).toBeCloseTo(-384.4, 1);
    expect(driver.pm.origin[1]!).toBeCloseTo(33.8, 1);
    expect(driver.pm.origin[2]!).toBeCloseTo(-16, 1);
    // Standing hull walks N/S/E with no jump and no crouch (glue reads
    // exactly 0.0, so any generous threshold discriminates).
    const legs: Array<[string, number, number]> = [
      ['E', 0, 100],
      ['N', 90, 50],
      ['S', 270, 100],
    ];
    for (const [nm, yaw, min] of legs) {
      settle();
      const bx = driver.pm.origin[0]!;
      const by = driver.pm.origin[1]!;
      for (let i = 0; i < 20; i++) {
        driver.step({ msec: 100, angles: [0, yaw, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      }
      const moved = Math.hypot(driver.pm.origin[0]! - bx, driver.pm.origin[1]! - by);
      expect(moved).toBeGreaterThan(min);
      expectInWorld(driver.pm.origin, map);
    }
    // Crouched hull walks too.
    settle();
    {
      const bx = driver.pm.origin[0]!;
      const by = driver.pm.origin[1]!;
      for (let i = 0; i < 20; i++) {
        driver.step({ msec: 100, angles: [0, 90, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: BUTTON_DUCK }, 0.1);
      }
      expect(Math.hypot(driver.pm.origin[0]! - bx, driver.pm.origin[1]! - by)).toBeGreaterThan(20);
      expectInWorld(driver.pm.origin, map);
    }
    // West walks freely until the world rock face at x=-412 (hull contact
    // at origin -428) and stops there: the stop is the C world trace
    // blocking (fraction < 1 on the C player mask — solid rock holds in C
    // too and must stay), not glue. Pressing on proves it holds.
    settle();
    for (let i = 0; i < 20; i++) {
      driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    }
    const wx = driver.pm.origin[0]!;
    const wy = driver.pm.origin[1]!;
    expect(-384.4 - wx).toBeGreaterThan(40);
    for (let i = 0; i < 20; i++) {
      driver.step({ msec: 100, angles: [0, 180, 0], forwardmove: 200, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    }
    expect(Math.hypot(driver.pm.origin[0]! - wx, driver.pm.origin[1]! - wy)).toBeLessThan(3);
    const worldOnly = SV_TraceFor(map, MASK_PLAYERSOLID_C);
    const rock = worldOnly(
      v3(driver.pm.origin[0], driver.pm.origin[1], driver.pm.origin[2]),
      v3(-16, -16, -24),
      v3(16, 16, 32),
      v3(driver.pm.origin[0]! - 64, driver.pm.origin[1], driver.pm.origin[2]),
    );
    expect(rock.fraction).toBeLessThan(1);
    expectInWorld(driver.pm.origin, map);
    // A soldier chasing through the spot reaches the player: the courtyard
    // light soldier (#341, awake chaser like gate (b)) runs the lane from
    // the south side while the player kites north at patrol pace. Kiting
    // (not standing) is the deterministic trigger: a posted player lets
    // the soldier plant at firing range and trade shots (C-plausible
    // ai_run_missile behavior), which never crosses the band; a retreating
    // player keeps the chase hot through the spot. Verdicts are the run
    // minimum (gate-(b) close bar) plus the band crossing.
    const A = driver.server.monsters.find((m) => m.edict.num === 341)!;
    expect(A).toBeDefined();
    driver.pm.origin = v3(-384.4, 100, 60);
    driver.pm.velocity = v3();
    A.edict.origin = v3(-384.4, -60, 60);
    // Face the chaser at the player: #341 walks a patrol beat and C sight
    // needs facing — teleported sideways to its beat it would walk off
    // instead of acquiring (RELEASE-13 gating).
    A.state.yaw = 90;
    let minAy = Infinity;
    let maxAy = -Infinity;
    let minGap = Infinity;
    for (let t = 0; t < 150; t++) {
      SV_SetPlayerHealth(driver.server, 100); // setup: hold the kiter alive
      driver.step({ msec: 100, angles: [0, 90, 0], forwardmove: 100, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
      minAy = Math.min(minAy, A.edict.origin[1]!);
      maxAy = Math.max(maxAy, A.edict.origin[1]!);
      minGap = Math.min(
        minGap,
        Math.hypot(A.edict.origin[0]! - driver.pm.origin[0]!, A.edict.origin[1]! - driver.pm.origin[1]!),
      );
      if (minGap < 40) break;
    }
    // Through the spot band (crosses y=33.8) and closing on the player
    // (the gate-(b) close bar: the run may end stood off at firing range,
    // so the verdict is the minimum over the run).
    expect(minAy).toBeLessThan(33.8);
    expect(maxAy).toBeGreaterThan(33.8);
    expect(minGap).toBeLessThan(100);
    expectInWorld(driver.pm.origin, map);
  });

  it('(u) board the parked lift and ride it: feet on top, grounded, no fall-through', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    // The exit lift (*12 func_train, t91): parked with its top at z=0. The
    // shaft walls wedge a rider the moment it settles (zero walking room —
    // verified by stepping all four directions), so the boarding below is
    // placement setup exactly like the server-lane pmove-rider footprint —
    // and every verdict (feet, ground, carry, render) is a real driver-loop
    // outcome that fails without the mover clip + carry wiring.
    const train = driver.server.trains.find((t) => t.ent.model === '*12')!;
    expect(train.started).toBe(false);
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    // The train ride: place the rider on the parked top (feet +1/32 above
    // it), settle, E-call the lift, ride the full leg. The carry keeps
    // feet==top every tick; the render tracks the sim exactly.
    driver.pm.origin = v3(-2056, 1500, 24.03);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    expect(driver.pm.onGround).toBe(true);
    expect(driver.pm.groundEntity).toBe(train.ent.num);
    expect(driver.pm.origin[2]! - 24).toBeCloseTo(0, 1);
    expect(driver.doorRenderOffset('*12')).toEqual([0, 0, 0]);
    // E-call: aim at the *13 button center (reach + facing, wall-checked).
    const eye0 = v3(driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22);
    const ctr: [number, number, number] = [-2016, 1536, 80];
    const dx0 = ctr[0]! - eye0[0]!, dy0 = ctr[1]! - eye0[1]!, dz0 = ctr[2]! - eye0[2]!;
    const l0 = Math.hypot(dx0, dy0) || 1;
    const aim0: [number, number, number] = [
      (Math.atan2(-dz0, l0) * 180) / Math.PI,
      (Math.atan2(dy0, dx0) * 180) / Math.PI,
      0,
    ];
    driver.step({ msec: 100, angles: aim0, forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_USE }, 0.1);
    expect(driver.events).toContain('use');
    // The button fires its target on reaching the TOP (id button_wait, one
    // tick later at 200u/s over 4u); the train then runs its leg.
    stepDriver(driver, neutralCmd(), 3);
    expect(train.started).toBe(true);
    // Full leg: grounded on the pusher every tick, feet glued to the top,
    // rendered mesh tracking the sim origin bit-exactly.
    let peak = 0;
    for (let i = 0; i < 60 && !train.arrived; i++) {
      driver.step(neutralCmd(), 0.1);
      const top = train.ent.origin[2]!;
      const feet = driver.pm.origin[2]! - 24;
      expect(driver.pm.onGround).toBe(true);
      expect(driver.pm.groundEntity).toBe(train.ent.num);
      expect(feet).toBeCloseTo(top, 0);
      const off = driver.doorRenderOffset('*12')!;
      expect(off[0]!).toBeCloseTo(train.ent.origin[0]!, 6);
      expect(off[1]!).toBeCloseTo(train.ent.origin[1]!, 6);
      expect(off[2]!).toBeCloseTo(train.ent.origin[2]!, 6);
      peak = Math.max(peak, Math.abs(train.ent.origin[0]!) + Math.abs(train.ent.origin[2]!));
      expectInWorld(driver.pm.origin, driver.map!);
    }
    expect(train.arrived).toBe(true);
    expect(peak).toBeGreaterThan(10);
    // Arrival: the t90 corner (-2080,1472,-8) minus the brush-mins base
    // (-2064,1472,-48) = (-16, 0, 40), rendered and simulated identically.
    expect(train.ent.origin[0]!).toBeCloseTo(-16, 6);
    expect(train.ent.origin[1]!).toBeCloseTo(0, 6);
    expect(train.ent.origin[2]!).toBeCloseTo(40, 6);
    expect(driver.pm.origin[2]! - 24).toBeCloseTo(40, 0);
    expect(driver.pm.groundEntity).toBe(train.ent.num);
    // Parks with the rider aboard: 150 ticks, zero further motion.
    const endOff = driver.doorRenderOffset('*12')!;
    for (let i = 0; i < 150; i++) {
      driver.step(neutralCmd(), 0.1);
      expect(driver.doorRenderOffset('*12')).toEqual(endOff);
      expect(driver.pm.groundEntity).toBe(train.ent.num);
    }
    expect(train.arrived).toBe(true);
    expectInWorld(driver.pm.origin, driver.map!);
  });

  it('(v) E-use and touch press the lift buttons: reach, facing, no fan-out', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const train = driver.server.trains.find((t) => t.ent.model === '*12')!;
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    const btn34 = driver.server.movers.find((m) => m.ent.model === '*34')!;
    const plug = driver.server.movers.find((m) => m.ent.model === '*31')!;
    // Per-window target collection for the no-fan-out audit: ship
    // pathtargets (t143-t147 loops: 'brittany', 'speakc', 'speakd') fire
    // ambiently every few ticks, so the audit asserts per press-window
    // (only the aimed button's own target fires there), not globally.
    let window: Set<string> | null = null;
    const collectTargets = (): void => {
      if (!window) return;
      for (const t of driver.server.firedThisTick) window.add(t);
    };
    const aimAt = (tx: number, ty: number, tz: number): [number, number, number] => {
      const e = [driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + 22];
      const dx = tx - e[0]!, dy = ty - e[1]!, dz = tz - e[2]!;
      const l = Math.hypot(dx, dy) || 1;
      return [(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0];
    };
    const press = (aim: [number, number, number]): boolean => {
      const n = driver.events.length;
      driver.step({ msec: 100, angles: aim, forwardmove: 0, sidemove: 0, upmove: 0, buttons: BUTTON_USE }, 0.1);
      collectTargets();
      return driver.events.length > n && driver.events[driver.events.length - 1] === 'use';
    };
    // Reach gate: the camp is ~350u from *13 — aiming at it presses nothing.
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 5);
    window = new Set<string>();
    expect(press(aimAt(-2016, 1536, 80))).toBe(false);
    expect(window.size).toBe(0);
    expect(train.started).toBe(false);
    expect(btn13.state).toBe('bottom');
    // Facing gate: at the shaft in range but aimed away — nothing fires.
    driver.pm.origin = v3(-2030, 1536, -24);
    driver.pm.velocity = v3();
    stepDriver(driver, neutralCmd(), 10);
    const good = aimAt(-2016, 1536, 80);
    // Level gaze the opposite way: truly facing away in 3D (at steep pitch
    // yaw alone barely moves the ray, so pitch must go level too).
    const away: [number, number, number] = [0, good[1]! + 180, 0];
    window = new Set<string>();
    expect(press(away)).toBe(false);
    expect(window.size).toBe(0);
    expect(train.started).toBe(false);
    // Aimed *13 press within reach: the button fires t91 (and NOT t4 — only
    // the aimed button fires) and the train runs its full leg to arrival
    // (wait -1 holds the button TOP: no return).
    window = new Set<string>();
    const w13 = window;
    expect(press(good)).toBe(true);
    expect(btn13.state).toBe('going_up');
    let peak = 0;
    for (let i = 0; i < 60 && !train.arrived; i++) {
      driver.step(neutralCmd(), 0.1);
      collectTargets();
      peak = Math.max(peak, Math.abs(train.ent.origin[0]!) + Math.abs(train.ent.origin[2]!));
    }
    expect(train.arrived).toBe(true);
    expect(peak).toBeGreaterThan(10);
    expect(w13.has('t91')).toBe(true);
    expect(w13.has('t4')).toBe(false);
    expect(train.ent.origin[0]!).toBeCloseTo(-16, 6);
    expect(train.ent.origin[2]!).toBeCloseTo(40, 6);
    expect(btn13.state).toBe('top');
    for (let i = 0; i < 50; i++) {
      driver.step(neutralCmd(), 0.1);
      collectTargets();
    }
    expect(btn13.state).toBe('top');
    expect(driver.doorRenderOffset('*13')).toEqual([0, 0, 4]);
    // E-use path: the *34 elevator button hovers centered above the doorway
    // (RELEASE-4 over-door housing, 1u off the shut face) — out of every
    // hull, so touch can never press it. Aim from the slot face at the live
    // bounds center: the driver loop fires t4 on the button's TOP arrival.
    // The health-gated *13 answers use only — it never fires here.
    // Ambient ship relays are not collected here (see the audit note above).
    window = null;
    driver.pm.origin = v3(-1688, 1536, 120);
    driver.pm.velocity = v3();
    window = new Set<string>();
    const w34 = window;
    let saw34 = false;
    let sawOffset = false;
    let useOk = false;
    for (let i = 0; i < 10 && !saw34; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      const b = driver.server.moverBounds.get(btn34.ent.num)!;
      const cx = (b.mins[0]! + b.maxs[0]!) / 2, cy = (b.mins[1]! + b.maxs[1]!) / 2, cz = (b.mins[2]! + b.maxs[2]!) / 2;
      if (press(aimAt(cx, cy, cz))) useOk = true;
      if (driver.server.firedThisTick.includes('t4')) saw34 = true;
      const off = driver.doorRenderOffset('*34')!;
      if (Math.abs(off[0]!) + Math.abs(off[1]!) + Math.abs(off[2]!) > 1) sawOffset = true;
    }
    expect(useOk).toBe(true); // the aimed E-use pressed
    expect(saw34).toBe(true);
    expect(sawOffset).toBe(true);
    expect(btn34.state).not.toBe('bottom');
    // Leave the overlap at once (gate (t) pattern): a parked rider would
    // re-fire t4 every button cycle and the button would never observably
    // rest at BOTTOM. The plug's cycle runs on without the presser.
    driver.pm.origin = v3(-1669, 1514, 120);
    driver.pm.velocity = v3();
    // The plug drops the full 156 on the press — while the arrived train
    // parks through the cycle (a plug firing never drives the lift).
    const plugZ0 = plug.ent.origin[2]!;
    let guard34 = 0;
    while (plug.ent.origin[2]! > plugZ0 - 155 && guard34++ < 100) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      collectTargets();
      expect(driver.server.firedThisTick.includes('t4')).toBe(false);
    }
    expect(plug.ent.origin[2]!).toBeCloseTo(plugZ0 - 156, 0);
    expect(train.arrived).toBe(true);
    expect(train.ent.origin[0]!).toBeCloseTo(-16, 6);
    expect(train.ent.origin[2]!).toBeCloseTo(40, 6);
    // The button finishes its C-default 3s hold and returns to BOTTOM on
    // its own — offset back to 0.
    let back = false;
    for (let i = 0; i < 60 && !back; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
      collectTargets();
      back = btn34.state === 'bottom';
    }
    expect(back).toBe(true);
    expect(btn34.state).toBe('bottom');
    expect(driver.doorRenderOffset('*34')).toEqual([0, 0, 0]);
    // No-fan-out audit, per press-window: *13 fired t91 but never t4, *34
    // fired t4 but never t91 — only the aimed/touched button fires. (The
    // ship pathtarget relays fire ambiently throughout and are excluded by
    // the windowed collection; the level never exits from a press.)
    expect(w13.has('t91')).toBe(true);
    expect(w13.has('t4')).toBe(false);
    expect(w34.has('t4')).toBe(true);
    expect(w34.has('t91')).toBe(false);
    expect(train.started).toBe(true);
    expect(driver.events).not.toContain('exit');
    expectInWorld(driver.pm.origin, driver.map!);
  });

  it('(w) the low tunnel reaches the *27 exit volume: blue stats screen, sane counters', { timeout: 180000 }, async () => {
    // C-intended exit path (base2 is not shipped): a low tunnel east of the
    // plug (x -1700 → -1776 at feet -80) sweeps clear at player hull all the
    // way to the *27 trigger volume (x -1840..-1712, y 1448..1640, z -24..32
    // — a body with feet at -80 grazes its floor). The plug/train complex is
    // optional side content (t91 fires its target_secret); the tunnel is the
    // way out. The server owns the finished state; the HUD renders it
    // centered in blue with HelpComputer-lite stats (kills / secrets / goals
    // over totals + level time, C p_hud.c).
    const boot = await bootBase1();
    const { driver } = boot;
    // Pure time formatter pins (M:SS from level.time, never wall-clock).
    expect(formatLevelTime(0)).toBe('0:00');
    expect(formatLevelTime(59)).toBe('0:59');
    expect(formatLevelTime(60)).toBe('1:00');
    expect(formatLevelTime(277)).toBe('4:37');
    // Server totals at spawn (C SP_ counts): monsters live, 3 secrets (t91
    // lift + t77 + t76), 1 goal (t92 behind *11) — all SP-spawned.
    expect(driver.server.totalMonsters).toBeGreaterThan(0);
    expect(driver.server.totalSecrets).toBe(3);
    expect(driver.server.totalGoals).toBe(1);
    expect(driver.server.finished).toBe(false);
    // Route documentation (sim truth, C player mask): the tunnel sweeps
    // clear at player hull from x -1700 to x -1776 at feet -80, on the
    // center line and 24u to either side — the full width that reaches *27.
    // (Same clip-trace construction as the driver's own world trace.)
    const clip = SV_ClipTrace(driver.server, SV_TraceFor(driver.map!));
    const sweep = (sx: number, y: number): number =>
      clip(
        v3(sx, y, -56), v3(-16, -16, -24), v3(16, 16, 32), v3(-1776, y, -56),
      ).fraction;
    for (const y of [1520, 1544, 1568]) expect(sweep(-1700, y)).toBe(1);
    // Descend into the tunnel east of the plug: teleport below the plug
    // bottom (80 — body top 72 clears it) and settle from above the way the
    // engine does (never an exact-plane plant). The real fall ends on the
    // pit floor at feet -80, inside the *27 volume.
    driver.pm.origin = v3(-1750, 1544, 40);
    driver.pm.velocity = v3();
    // NB: the loop runs unconditionally — t37 fires on the first overlap
    // (body top 72 already grazes the volume floor) while the engine is
    // still falling; cutting the loop at finished would plant the verdict
    // mid-air instead of on the pit floor.
    const fired = new Set<string>();
    for (let i = 0; i < 40; i++) {
      driver.step(neutralCmd(), 0.1);
      for (const t of driver.server.firedThisTick) fired.add(t);
    }
    // The body genuinely fell (not a teleport plant) and rests on the floor.
    expect(driver.pm.origin[2]!).toBeCloseTo(-56, 0);
    expect(driver.server.finished).toBe(true);
    expect(driver.pm.onGround).toBe(true);
    expectInWorld(driver.pm.origin, driver.map!);
    // The *27 brush trigger fired t37 → target_changelevel during the real
    // descent, and the server marked the finish via the exit path.
    expect(fired.has('t37')).toBe(true);
    expect(driver.server.finished).toBe(true);
    expect(driver.server.finishReason).toBe('exit');
    expect(driver.server.finishTime).toBeGreaterThan(0);
    // The plug/train complex sat out the exit: optional side content,
    // never touched.
    const train = driver.server.trains.find((t) => !t.ship)!;
    expect(train.started).toBe(false);
    expect([...train.ent.origin]).toEqual([0, 0, 0]);
    const plug = driver.server.movers.find((m) => m.ent.model === '*31')!;
    expect([...plug.ent.origin]).toEqual([...plug.pos1]);
    // RENDERED verdict: the finished message carries the headline + the
    // stats lines, with every counter sane (kills/secrets/goals <= totals).
    const msg = driver.message;
    expect(msg).toContain('LEVEL COMPLETE');
    expect(msg).toContain('kills');
    expect(msg).toContain('secrets');
    expect(msg).toContain('goals');
    expect(msg).toContain('time');
    const kills = msg.match(/kills (\d+)\/(\d+)/)!;
    const secrets = msg.match(/secrets (\d+)\/(\d+)/)!;
    const goals = msg.match(/goals (\d+)\/(\d+)/)!;
    const time = msg.match(/time (\d+:\d\d)/)!;
    expect(kills).not.toBeNull();
    expect(secrets).not.toBeNull();
    expect(goals).not.toBeNull();
    expect(time).not.toBeNull();
    expect(Number(kills![1])).toBeLessThanOrEqual(Number(kills![2]));
    expect(Number(secrets![1])).toBeLessThanOrEqual(Number(secrets![2]));
    expect(Number(goals![1])).toBeLessThanOrEqual(Number(goals![2]));
    expect(Number(kills![2])).toBeGreaterThan(0);
    expect(Number(secrets![2])).toBe(3);
    expect(Number(goals![2])).toBe(1);
    // The changelevel path: 'exit' fires (and the driver goes invincible —
    // the old lift path's 'finished' event does not apply here).
    expect(driver.events).toContain('exit');
    expect(driver.events).not.toContain('finished');
    expect(driver.exited).toBe(true);
    // The screen persists: firing afterwards never overwrites it.
    driver.step(attackCmd([0, 0, 0]), 0.1);
    expect(driver.message).toBe(msg);
    // In-canvas render path: the stats block lands in FINISH_BLUE pixels
    // (centered multi-line block, post-`r_brightness` lift like fps/pos).
    const target = { width: 320, height: 240, color: new Uint32Array(320 * 240) };
    drawPlayHud(target, boot, { fps: 0, frame: 1 });
    expect(target.color.some((c) => c === FINISH_BLUE)).toBe(true);
    expectInWorld(driver.pm.origin, driver.map!);
  });
});
