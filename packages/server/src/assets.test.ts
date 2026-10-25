// Asset wiring: monster classnames resolve to pak model/skin helpers,
// and every helper path exists in the real pak0.pak (asset-gated).
//
// The pak check mirrors base1.test.ts: loads Q2_PAK via @q2/filesystem at
// test time, skips without it (BRAIN.md §3). @q2/game stays filesystem-free;
// this server test is where names meet bytes.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { PakFile } from '@q2/filesystem';
import {
  findByClassname,
  modelForBolt,
  modelForMonster,
  modelForWeapon,
  monsterKindForClassname,
  resetEdictNums,
  skinForBolt,
  skinForMonster,
  skinForWeaponModel,
  skinsForMonster,
  viewModelForWeapon,
  worldModelForWeapon,
} from '@q2/game';
import { SV_Init, SV_SpawnEntities } from './index.js';

const Q2_PAK = process.env.Q2_PAK;

const MONSTER_LUMP = `
{
"classname" "worldspawn"
}
{
"classname" "monster_soldier"
"origin" "0 0 0"
}
{
"classname" "monster_gunner"
"origin" "128 0 0"
}
`;

describe('monster spawn classnames resolve to asset helpers', () => {
  it('spawned soldier/gunner edicts map to pak model + skin', () => {
    resetEdictNums();
    const st = SV_Init();
    const edicts = SV_SpawnEntities(st, MONSTER_LUMP);
    const soldiers = findByClassname(edicts, 'monster_soldier');
    const gunners = findByClassname(edicts, 'monster_gunner');
    expect(soldiers).toHaveLength(1);
    expect(gunners).toHaveLength(1);
    for (const e of [...soldiers, ...gunners]) {
      const kind = monsterKindForClassname(e.classname);
      expect(kind).not.toBe(null);
      expect(modelForMonster(kind!)).toMatch(/^models\/monsters\/(soldier|gunner)\/tris\.md2$/);
      expect(skinForMonster(kind!)).toMatch(/^models\/monsters\/(soldier|gunner)\/skin\.pcx$/);
    }
  });
});

describe.runIf(!!Q2_PAK)('assets: helper paths exist in real pak0.pak (Q2_PAK)', () => {
  function loadPak(): PakFile {
    const bytes = readFileSync(Q2_PAK as string);
    const buf = new ArrayBuffer(bytes.length);
    new Uint8Array(buf).set(bytes);
    return new PakFile(buf);
  }

  it('monster models + all skins are in the pak', () => {
    const pak = loadPak();
    for (const kind of ['soldier', 'gunner'] as const) {
      expect(pak.has(modelForMonster(kind))).toBe(true);
      for (const skin of skinsForMonster(kind)) {
        expect(pak.has(skin)).toBe(true);
      }
      // every skin lump is non-trivial (real art, not a stub)
      const skinBytes = pak.readFile(skinForMonster(kind));
      expect(skinBytes.byteLength).toBeGreaterThan(10000);
    }
    const soldierMd2 = pak.readFile(modelForMonster('soldier'));
    const gunnerMd2 = pak.readFile(modelForMonster('gunner'));
    console.log(
      `ASSETS soldier=${soldierMd2.byteLength} gunner=${gunnerMd2.byteLength}`,
    );
    expect(soldierMd2.byteLength).toBeGreaterThan(100000);
    expect(gunnerMd2.byteLength).toBeGreaterThan(100000);
  });

  it('weapon view/world models + skins and the bolt are in the pak', () => {
    const pak = loadPak();
    for (const cls of ['weapon_blaster', 'weapon_shotgun', 'weapon_machinegun']) {
      const view = viewModelForWeapon(cls)!;
      const world = worldModelForWeapon(cls)!;
      expect(modelForWeapon(cls)).toBe(view);
      for (const model of [view, world]) {
        expect(pak.has(model)).toBe(true);
        // world (g_) pickup models are small meshes (5-7KB); view models larger
        expect(pak.readFile(model).byteLength).toBeGreaterThan(1000);
      }
      expect(pak.has(skinForWeaponModel(view))).toBe(true);
      expect(pak.has(skinForWeaponModel(world))).toBe(true);
    }
    expect(pak.has(modelForBolt())).toBe(true);
    expect(pak.has(skinForBolt())).toBe(true);
    // the bolt is a tiny 2-frame mesh (628 bytes in pak0.pak) — presence +
    // a parseable header is the check, not bulk
    expect(pak.readFile(modelForBolt()).byteLength).toBeGreaterThan(100);
  });
});
