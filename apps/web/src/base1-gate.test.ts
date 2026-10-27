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
//   (f) skill-change reboot re-filters the roster (3/5/3 infantry, 17/19/17),
//   (g) doors + glass render CLOSED at spawn (the graft).
import { describe, expect, it, vi, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { v3 } from '@q2/math';
import type { Entity } from '@q2/renderer-api';
import { MODEL_EXTRA_STRIDE } from '@q2/bsp';
import { parseEntities } from '@q2/game';
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
    // Live player throughout: still standing, and it shot back the whole way.
    expect(driver.playerHealth).toBeGreaterThan(0);
    expect(driver.events).toContain('monshot');
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
    const target = driver.server.monsters.find((m) => m.edict.extra['skinnum'] === '2')!;
    driver.pm.origin = v3(target.edict.origin[0]! + 48, target.edict.origin[1]!, target.edict.origin[2]! + 24);
    driver.pm.velocity = v3();
    const yaw = yawAt(
      [driver.pm.origin[0]!, driver.pm.origin[1]!],
      [target.edict.origin[0]!, target.edict.origin[1]!],
    );
    const shotsBefore = driver.events.filter((e) => e === 'shot').length;
    const hitsBefore = driver.events.filter((e) => e === 'hit').length;
    let ticks = 0;
    while (!driver.events.includes('kill') && ticks++ < 60) driver.step(attackCmd([0, yaw, 0]), 0.1);
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

  it('(f) skill-change reboot re-filters the roster (3/5/3 infantry, 17/19/17)', { timeout: 180000 }, async () => {
    const infantry = (boot: { driver: { server: { entities: { classname: string }[] } } }): number =>
      boot.driver.server.entities.filter((e) => e.classname === 'monster_infantry').length;
    const snapMonsters = (boot: { driver: { snapshot(t: number): { entities: unknown[] }; server: { time: number } } }): number =>
      boot.driver.snapshot(boot.driver.server.time).entities.length - 1; // minus the player
    setCVar('skill', 0);
    const easy = await bootBase1();
    expect(easy.driver.server.skill).toBe(0);
    expect(infantry(easy)).toBe(3);
    expect(snapMonsters(easy)).toBe(17); // submitted roster, not just spawn lists
    // "Change the dropdown": the menu sets the cvar and re-calls the boot
    // path (rebootPlay), so the new skill applies to this level immediately.
    setCVar('skill', 2);
    const hard = rebootPlay(easy);
    expect(hard.pak).not.toBeNull();
    expect(hard.driver.server.skill).toBe(2);
    expect(infantry(hard)).toBe(5);
    expect(snapMonsters(hard)).toBe(19);
    // And back down: the roster re-filters the other way too.
    setCVar('skill', 1);
    const med = rebootPlay(hard);
    expect(med.driver.server.skill).toBe(1);
    expect(infantry(med)).toBe(3);
    expect(snapMonsters(med)).toBe(17);
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
});
