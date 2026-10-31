// RELEASE-12 water-secret pool: geometry + escape + traverse (Q2_PAK-gated).
//
// The provisional position x=1057.9 y=865.3 z=-207.9 resolves to a standing
// spot on the floor of the t77 secret room ("You have found a secret area.",
// entity at 1066 860 -224): leaf 365 is air, the room floor is at feet -232
// (origin -208). South of the room lies the secret pool (water x 1030..1150
// / y 650..830, surface -255); the room floor slab (top -232) extends south
// to a face at y~=832, i.e. 23 units above the surface — more than STEPSIZE
// (18), so the intended exit is the C out-of-water vault (PM_CheckSpecial-
// Movement: waterlevel 2 + wall + air above -> 350 up / 50 forward), not a
// step or a swim-up. The pool/room walls surveyed axial-only; the two
// non-flat contacts in the wider pool basin are walkable bevels (21-30 deg,
// normal.z >= 0.7): a shore pit at (400-450, 530-580) with a 63-unit east
// wall (correctly unclimbable — stall without penetration, retreat frees).
// Base1 carries no water-current brushes and no SURF_SLICK texinfos, so the
// port's currents/slick omissions are behavior-identical here.
//
// Live hookup mirrors the driver (raw C-mask trace + clips, mapped only at
// the pmove boundary; point contents solid-aware). Movement is renderer-
// agnostic; the driver path is covered by apps/web ladder/drowning tests.
import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import { loadBsp, pointLeaf, traceBox } from '@q2/bsp';
import type { BspMap } from '@q2/bsp';
import {
  bspPointContentsFor,
  makePmoveState,
  pmoveFull,
  resetPmoveWorld,
  setPmoveWorld,
  withPmoveContents,
  PMF_TIME_WATERJUMP,
  STEPSIZE,
} from '@q2/game';
import { parseEntities } from '@q2/game';
import { v3 } from '@q2/math';
import {
  SV_ClipTrace,
  SV_Init,
  SV_TraceFor,
} from './index.js';

const Q2_PAK = process.env.Q2_PAK;
const MASK_C = 1 | 2 | 0x10000 | 0x2000000;

function loadBase1(): BspMap {
  const bytes = readFileSync(Q2_PAK as string);
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  return loadBsp(new PakFile(buf).readFile('maps/base1.bsp')) as BspMap;
}

function installLivePmove(map: BspMap): ReturnType<typeof SV_Init> {
  const st = SV_Init();
  setPmoveWorld(
    withPmoveContents(SV_ClipTrace(st, SV_TraceFor(map), -1, true)),
    bspPointContentsFor(map),
  );
  return st;
}

function cmd(
  angles: [number, number, number],
  forwardmove = 0,
  sidemove = 0,
  upmove = 0,
  msec = 100,
): { msec: number; angles: Float32Array; forwardmove: number; sidemove: number; upmove: number; buttons: number } {
  return { msec, angles: new Float32Array(angles), forwardmove, sidemove, upmove, buttons: 0 };
}

afterEach(() => {
  resetPmoveWorld();
});

describe.runIf(!!Q2_PAK)('RELEASE-12 secret-pool geometry + escape + traverse', () => {
  it('(w1) provisional position verifies against map geometry', { timeout: 120000 }, () => {
    const map = loadBase1();
    // Provisional spot is air inside the secret room (leaf 365, contents 0).
    const leaf = pointLeaf(map, v3(1057.9, 865.3, -207.9));
    expect(leaf).toBe(365);
    // The t77 secret entity sits just above the room floor nearby.
    const dicts = parseEntities(map.entities);
    const t77 = dicts.find((d) => d['classname'] === 'target_secret' && d['targetname'] === 't77');
    expect(t77, 'setup: base1 must carry the t77 water secret').toBeDefined();
    const at = (t77!['origin'] ?? '').split(' ').map(Number);
    expect(at[0]!).toBeCloseTo(1066, 0);
    expect(at[1]!).toBeCloseTo(860, 0);
    // Room floor directly below the provisional spot: feet -232.
    const drop = traceBox(
      map, v3(1066, 860, -170), v3(1066, 860, -300),
      v3(-16, -16, -24), v3(16, 16, 32), MASK_C,
    );
    expect(drop.endpos[2]! - 24).toBeCloseTo(-232, 0);
    // Pool surface column south of the slab face: water top at -255.
    let waterTop = -999;
    for (let z = -330; z <= -80; z += 5) {
      const l = pointLeaf(map, v3(1080, 800, z));
      const c = l >= 0 ? (map as unknown as { leafs: Int32Array }).leafs[l * 13]! : 1;
      if (c & 32) waterTop = z;
    }
    expect(waterTop).toBe(-255);
    // Edge height: room floor (-232) minus surface (-255) = 23 > STEPSIZE,
    // so escape needs the vault, never a step or a swim-up.
    expect(-232 - waterTop).toBeGreaterThan(STEPSIZE);
  });

  it('(w2) swim + vault escape through normal input (10Hz authority)', { timeout: 180000 }, () => {
    const map = loadBase1();
    installLivePmove(map);
    const pm = makePmoveState();
    pm.origin = v3(1080, 780, -290);
    pm.velocity = v3();
    pmoveFull(pm, cmd([0, 90, 0]));
    expect(pm.waterlevel).toBe(3);
    // Swim north toward the slab face and up to the surface.
    let vaultTick = -1;
    let peak = pm.origin[2]!;
    let escaped = false;
    for (let i = 0; i < 120; i++) {
      pmoveFull(pm, cmd([0, 90, 0], 200, 0, 200));
      if (pm.origin[2]! > peak) peak = pm.origin[2]!;
      if (pm.pmFlags & PMF_TIME_WATERJUMP) {
        if (vaultTick < 0) vaultTick = i;
        // C vault impulse: 50 forward, 350 up decaying under gravity.
        expect(pm.velocity[2]!).toBeLessThanOrEqual(350);
      }
      if (pm.onGround && pm.origin[2]! > -230) {
        escaped = true;
        break;
      }
      expect(Number.isFinite(pm.origin[2]!)).toBe(true);
    }
    expect(vaultTick, 'the C out-of-water vault must fire at the slab face').toBeGreaterThanOrEqual(0);
    expect(peak, 'vault flight must clear the 23-unit edge').toBeGreaterThan(-200);
    expect(escaped, 'escape must land on the room floor, not in the pool').toBe(true);
    expect(pm.waterlevel).toBe(0);
    expect(pm.onGround).toBe(true);
    expect(pm.origin[2]!).toBeCloseTo(-208, 0);
  });

  it('(w3) traverse: room walk, walkable bevels, steep-wall contrast, vault band at 50ms', { timeout: 180000 }, () => {
    const map = loadBase1();
    installLivePmove(map);
    // Room walk: landing spot north to the y944 wall — blocked cleanly.
    const pm = makePmoveState();
    pm.origin = v3(1080, 845, -208);
    pm.velocity = v3();
    for (let i = 0; i < 5; i++) pmoveFull(pm, cmd([0, 90, 0]));
    expect(pm.onGround).toBe(true);
    for (let i = 0; i < 20; i++) pmoveFull(pm, cmd([0, 90, 0], 400, 0, 0));
    expect(pm.origin[1]!).toBeLessThanOrEqual(944.1);
    expect(pm.onGround).toBe(true);
    // Walkable bevel: descend the pit's west slope (normal.z 0.93 >= 0.7),
    // stay grounded on the dip floor, no allsolid glue.
    const b = makePmoveState();
    b.origin = v3(385, 540, -24);
    b.velocity = v3();
    for (let i = 0; i < 5; i++) pmoveFull(b, cmd([0, 0, 0]));
    expect(b.onGround).toBe(true);
    let minFeet = 999;
    for (let i = 0; i < 150; i++) {
      pmoveFull(b, cmd([0, 0, 0], 100, 0, 0));
      minFeet = Math.min(minFeet, b.origin[2]! - 24);
      expect(Number.isFinite(b.origin[0]!)).toBe(true);
    }
    expect(minFeet, 'must descend the walkable bevel into the dip').toBeLessThan(-100);
    expect(b.onGround).toBe(true);
    // The dip's east wall (63 units, near-vertical) correctly blocks: no
    // penetration past the face band, and walking back west frees the body.
    const stallX = b.origin[0]!;
    for (let i = 0; i < 30; i++) pmoveFull(b, cmd([0, 0, 0], 100, 0, 0));
    expect(b.origin[0]! - stallX).toBeLessThan(5);
    for (let i = 0; i < 60; i++) pmoveFull(b, cmd([0, 0, 0], -100, 0, 0));
    expect(b.origin[0]!).toBeLessThan(stallX - 10);
    // Steep contrast: the slab face (vertical, normal.z 0) never grounds —
    // the swimmer stops at hull contact, stays submerged and airborne.
    const w = makePmoveState();
    w.origin = v3(1080, 770, -280);
    w.velocity = v3();
    pmoveFull(w, cmd([0, 90, 0]));
    expect(w.waterlevel).toBe(3);
    for (let i = 0; i < 15; i++) pmoveFull(w, cmd([0, 90, 0], 400, 0, 0));
    expect(w.origin[1]!).toBeLessThanOrEqual(816.5);
    expect(w.origin[1]!).toBeGreaterThan(800);
    expect(w.onGround).toBe(false);
    expect(w.waterlevel).toBe(3);
    // Vault band fires at the 50ms prediction cadence too when WL2 holds.
    const e = makePmoveState();
    e.origin = v3(1080, 810, -262);
    e.velocity = v3();
    pmoveFull(e, cmd([0, 90, 0], 0, 0, 0, 50));
    expect(e.waterlevel).toBe(2);
    let vault50 = -1;
    for (let i = 0; i < 40; i++) {
      pmoveFull(e, cmd([0, 90, 0], 200, 0, 200, 50));
      if (e.pmFlags & PMF_TIME_WATERJUMP) {
        vault50 = i;
        break;
      }
    }
    expect(vault50).toBeGreaterThanOrEqual(0);
  });
});
