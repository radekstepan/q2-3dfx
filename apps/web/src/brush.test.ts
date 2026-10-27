import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import { MODEL_EXTRA_STRIDE } from '@q2/bsp';
import { bspTraceFor, moverUse, parseEntities } from '@q2/game';
import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { UserCmdT } from '@q2/input';
import { bootPlay } from './play.js';
import { SV_AddBarrel } from '@q2/server';
import { readPakEntry } from './pak.js';

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

afterEach(() => {
  resetCVars();
});

const WEB_Q2_PAK = process.env.Q2_PAK;

async function bootPak(width = 96, height = 72) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

describe.runIf(!!WEB_Q2_PAK)('brush models render (doors closed, glass visible)', () => {
  it('fresh boot bakes every mover at the closed pose (origin == pos1)', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver } = boot;
    expect(driver.server.movers.length).toBeGreaterThan(0);
    for (const m of driver.server.movers) {
      // No base1 door/button carries DOOR_START_OPEN, so id spawns every
      // mover AT pos1 (mapper coords = closed): zero rest displacement.
      expect(m.ent.origin[0]).toBeCloseTo(m.pos1[0]!, 6);
      expect(m.ent.origin[1]).toBeCloseTo(m.pos1[1]!, 6);
      expect(m.ent.origin[2]).toBeCloseTo(m.pos1[2]!, 6);
    }
  });

  it('graft covers every mover/train/func_wall model (no invisible brushes)', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver } = boot;
    const map = driver.map!;
    const modelCount = map.modelsExtra.length / MODEL_EXTRA_STRIDE;
    // Expected: union of live faces over mover models + brush-train models
    // + func_wall + func_explosive models (func_explosive renders as brush
    // geometry — the *20 glass window, the *30 slab — never as an MD2 proxy;
    // triggers excluded: NODRAW).
    const wanted = new Set<number>();
    for (const m of driver.server.movers) {
      const n = Number.parseInt(m.ent.model.slice(1), 10);
      if (Number.isFinite(n)) wanted.add(n);
    }
    for (const tr of driver.server.trains) {
      if (tr.ship) continue;
      const n = Number.parseInt(tr.ent.model.slice(1), 10);
      if (Number.isFinite(n)) wanted.add(n);
    }
    for (const e of driver.server.entities) {
      if (!e.freed && (e.classname === 'func_wall' || e.classname === 'func_explosive') && e.model) {
        const n = Number.parseInt(e.model.slice(1), 10);
        if (Number.isFinite(n)) wanted.add(n);
      }
    }
    expect(wanted.size).toBeGreaterThan(0);
    let expected = 0;
    const perModel = new Map<number, number[]>();
    for (const n of wanted) {
      if (n < 0 || n >= modelCount) continue;
      const first = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 1]!;
      const num = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 2]!;
      const live: number[] = [];
      for (let f = first; f < first + num; f++) {
        if (driver.mini.surfaces[f]?.n) {
          live.push(f);
          expected++;
        }
      }
      perModel.set(n, live);
    }
    expect(expected).toBeGreaterThan(0);
    expect(driver.graftedFaceCount()).toBe(expected);
    expect(driver.graftedFacesSorted()).toEqual(
      [...perModel.values()].flat().sort((a, b) => a - b),
    );
    // Every live face of every wanted model sits in some leaf facelist.
    const inLists = new Set<number>();
    for (const leaf of driver.mini.leafs) {
      for (const f of leaf.faceList ?? []) inLists.add(f);
    }
    for (const [n, live] of perModel) {
      expect(live.length).toBeGreaterThan(0);
      for (const f of live) expect(inLists.has(f)).toBe(true);
    }
  });

  it('func_wall *9 *10 are grafted and lump-opaque (no alpha key)', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver } = boot;
    const dicts = parseEntities(driver.map!.entities);
    const walls = dicts.filter((d) => d['classname'] === 'func_wall');
    expect(walls.map((w) => w['model']).sort()).toEqual(['*10', '*9']);
    // Q2 glass reads `alpha` on the func_wall (translucent when present);
    // base1 carries none, so the correct render is opaque, never invisible.
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

  it('moving a door server-side moves the rendered verts exactly', { timeout: 180000 }, async () => {
    const boot = await bootPak();
    const { driver } = boot;
    const map = driver.map!;
    const door = driver.server.movers.find((m) => m.ent.classname === 'func_door');
    expect(door).toBeDefined();
    const n = Number.parseInt(door!.ent.model.slice(1), 10);
    const first = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 1]!;
    const num = map.modelsExtra[n * MODEL_EXTRA_STRIDE + 2]!;
    const before: Float32Array[] = [];
    for (let f = first; f < first + num; f++) {
      const s = driver.mini.surfaces[f];
      if (s && s.n > 0) before.push(new Float32Array(s.verts));
    }
    expect(before.length).toBeGreaterThan(0);
    moverUse(door!, driver.server.time);
    for (let i = 0; i < 15; i++) driver.step(neutralCmd(), 0.1);
    const ox = door!.ent.origin[0]! - door!.pos1[0]!;
    const oy = door!.ent.origin[1]! - door!.pos1[1]!;
    const oz = door!.ent.origin[2]! - door!.pos1[2]!;
    expect(Math.hypot(ox, oy, oz)).toBeGreaterThan(1);
    let k = 0;
    for (let f = first; f < first + num; f++) {
      const s = driver.mini.surfaces[f];
      if (!s || s.n === 0) continue;
      const b = before[k++]!;
      for (let v = 0; v < b.length; v += 3) {
        expect(s.verts[v]! - b[v]!).toBeCloseTo(ox, 4);
        expect(s.verts[v + 1]! - b[v + 1]!).toBeCloseTo(oy, 4);
        expect(s.verts[v + 2]! - b[v + 2]!).toBeCloseTo(oz, 4);
      }
    }
    expect(k).toBe(before.length);
  });

  it('an opening door changes rendered pixels (brush faces reach the pipeline)', { timeout: 240000 }, async () => {
    const boot = await bootPak();
    const { driver } = boot;
    const map = driver.map!;
    const trace = bspTraceFor(map);
    const zero = v3();
    // Vantages: both sides along each door's thinnest axis, 200u out, kept
    // only when the world trace to the door center is clear.
    interface Vantage { pos: [number, number, number]; yaw: number; pitch: number }
    const vantages: Vantage[] = [];
    for (const m of driver.server.movers) {
      if (m.ent.classname !== 'func_door') continue;
      const n = Number.parseInt(m.ent.model.slice(1), 10);
      const mins = [map.modelsMins[n * 3]!, map.modelsMins[n * 3 + 1]!, map.modelsMins[n * 3 + 2]!];
      const maxs = [map.modelsMaxs[n * 3]!, map.modelsMaxs[n * 3 + 1]!, map.modelsMaxs[n * 3 + 2]!];
      const center: [number, number, number] = [
        (mins[0]! + maxs[0]!) / 2, (mins[1]! + maxs[1]!) / 2, (mins[2]! + maxs[2]!) / 2,
      ];
      const ext = [maxs[0]! - mins[0]!, maxs[1]! - mins[1]!, maxs[2]! - mins[2]!];
      let axis = 0;
      if (ext[1]! < ext[axis]!) axis = 1;
      if (ext[2]! < ext[axis]!) axis = 2;
      for (const side of [-1, 1]) {
        const pos: [number, number, number] = [...center] as [number, number, number];
        pos[axis]! += side * (ext[axis]! / 2 + 200);
        const hit = trace(v3(pos[0], pos[1], pos[2]), zero, zero, v3(center[0], center[1], center[2]));
        if (hit.fraction < 1) continue;
        const dx = center[0]! - pos[0]!;
        const dy = center[1]! - pos[1]!;
        const dz = center[2]! - pos[2]!;
        const len = Math.hypot(dx, dy, dz) || 1;
        vantages.push({
          pos,
          yaw: (Math.atan2(dy, dx) * 180) / Math.PI,
          pitch: (-Math.asin(dz / len) * 180) / Math.PI,
        });
      }
    }
    expect(vantages.length).toBeGreaterThan(0);
    // Cosmetic particles would alias across the stepped renders; drop them
    // so closed-vs-open differs ONLY in world (door) faces.
    const render = (v: Vantage): Uint32Array => {
      driver.mini.particles.length = 0;
      boot.refresh.beginFrame();
      boot.refresh.renderView(
        {
          origin: new Float32Array(v.pos) as Vec3,
          angles: new Float32Array([v.pitch, v.yaw, 0]) as Vec3,
          fovX: 90,
          time: 0,
          lightStyles: new Float32Array(256).fill(1),
        },
        { name: 'maps/base1', data: driver.mini },
        [],
      );
      boot.refresh.endFrame();
      return boot.host.fb.color.slice();
    };
    let closed: Uint32Array[] = vantages.map(render);
    // Open every door fully (40 ticks at 100u/s clears any travel).
    for (const m of driver.server.movers) {
      if (m.ent.classname === 'func_door') moverUse(m, driver.server.time);
    }
    for (let i = 0; i < 40; i++) driver.step(neutralCmd(), 0.1);
    let diff = 0;
    vantages.forEach((v, i) => {
      const open = render(v);
      const shut = closed[i]!;
      for (let p = 0; p < shut.length; p++) {
        if (shut[p] !== open[p]) diff++;
      }
    });
    // Without the graft no submodel face ever reaches the pipeline and the
    // two renders are identical; a moved door repaints thousands of pixels.
    expect(diff).toBeGreaterThan(100);
  });
});

describe('barrel render origin (view-side audit)', () => {
  it('extras mirror barrel origins 1:1 (no half-bbox lift)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    SV_AddBarrel(driver.server, v3(10, 20, 0));
    const extras = driver.extraEntities()!;
    const found = extras.find((x) => x.origin[0] === 10 && x.origin[1] === 20);
    expect(found).toBeDefined();
    // Exact match: the renderer draws the MD2 at the entity origin, and the
    // barrel MD2 pivot is the box bottom (see the pak test below), so a
    // +20 half-bbox lift here would visibly float the barrel.
    expect([...found!.origin!]).toEqual([10, 20, 0]);
  });

  it.runIf(!!WEB_Q2_PAK)('barrel MD2 pivot sits at the box bottom (frame min-z ≈ 0)', async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const { parseMD2 } = await import('@q2/formats');
    const pak = ingestPak(buf);
    const md2 = parseMD2(readPakEntry(pak, 'models/objects/barrels/tris.md2'));
    expect(md2.numFrames).toBeGreaterThan(0);
    // Frame 0 (idle): the pivot is the hull bottom — BARREL_MINS z=0 — so
    // rendering at the lump origin (floor-resting, z=0) plants the barrel
    // exactly on the floor with no view-side offset to apply.
    let minZ = Infinity;
    for (let v = 0; v < md2.numVerts; v++) {
      minZ = Math.min(minZ, md2.frames[v * 3 + 2]!);
    }
    expect(minZ).toBeCloseTo(0, 0);
  });
});
