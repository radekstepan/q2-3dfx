// map-viewer enemies tests: spawn extraction + asset path mapping.
// Synthetic dicts only — no PAKs, no DOM.
import { describe, expect, it } from 'vitest';
import {
  collectEnemySpawns,
  enemyKindForClassname,
  isEnemyClassname,
  modelPathForEnemyKind,
  skinPathForEnemyClassname,
  summarizeEnemies,
} from './enemies.js';

describe('enemyKindForClassname', () => {
  it('maps lite soldiers, gunner and infantry', () => {
    expect(enemyKindForClassname('monster_soldier')).toBe('soldier');
    expect(enemyKindForClassname('monster_soldier_light')).toBe('soldier');
    expect(enemyKindForClassname('monster_soldier_ss')).toBe('soldier');
    expect(enemyKindForClassname('monster_gunner')).toBe('gunner');
    expect(enemyKindForClassname('monster_infantry')).toBe('infantry');
  });
  it('returns null for unknown monsters and non-monsters', () => {
    expect(enemyKindForClassname('monster_berserk')).toBeNull();
    expect(enemyKindForClassname('info_player_start')).toBeNull();
    expect(enemyKindForClassname('')).toBeNull();
  });
  it('isEnemyClassname matches any monster_* prefix', () => {
    expect(isEnemyClassname('monster_berserk')).toBe(true);
    expect(isEnemyClassname('monster_soldier')).toBe(true);
    expect(isEnemyClassname('item_health')).toBe(false);
  });
});

describe('enemy asset paths', () => {
  it('maps kinds to their MD2 lumps', () => {
    expect(modelPathForEnemyKind('soldier')).toBe('models/monsters/soldier/tris.md2');
    expect(modelPathForEnemyKind('gunner')).toBe('models/monsters/gunner/tris.md2');
    expect(modelPathForEnemyKind('infantry')).toBe('models/monsters/infantry/tris.md2');
  });
  it('picks soldier skin variants by classname', () => {
    expect(skinPathForEnemyClassname('monster_soldier_light', 'soldier')).toBe(
      'models/monsters/soldier/skin_lt.pcx',
    );
    expect(skinPathForEnemyClassname('monster_soldier_ss', 'soldier')).toBe(
      'models/monsters/soldier/skin_ss.pcx',
    );
    expect(skinPathForEnemyClassname('monster_soldier', 'soldier')).toBe(
      'models/monsters/soldier/skin.pcx',
    );
    expect(skinPathForEnemyClassname('monster_gunner', 'gunner')).toBe(
      'models/monsters/gunner/skin.pcx',
    );
    expect(skinPathForEnemyClassname('monster_infantry', 'infantry')).toBe(
      'models/monsters/infantry/skin.pcx',
    );
  });
});

describe('collectEnemySpawns', () => {
  it('collects point monsters with origins and yaw', () => {
    const spawns = collectEnemySpawns([
      { classname: 'worldspawn' },
      { classname: 'monster_soldier', origin: '0 -64 8', angle: '90' },
      { classname: 'monster_gunner', origin: '64 0 112', angles: '0 180 0' },
      { classname: 'info_player_start', origin: '0 0 0' },
    ]);
    expect(spawns).toHaveLength(2);
    expect(spawns[0]).toMatchObject({
      index: 1,
      classname: 'monster_soldier',
      kind: 'soldier',
      origin: [0, -64, 8],
      yaw: 90,
    });
    expect(spawns[1]).toMatchObject({ classname: 'monster_gunner', kind: 'gunner', yaw: 180 });
  });
  it('keeps unknown monster_* variants with a null kind (fallback mesh)', () => {
    const spawns = collectEnemySpawns([{ classname: 'monster_berserk', origin: '1 2 3' }]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.kind).toBeNull();
  });
  it('skips monsters without usable origins and defaults yaw to 0', () => {
    const spawns = collectEnemySpawns([
      { classname: 'monster_soldier' },
      { classname: 'monster_infantry', origin: 'bogus' },
      { classname: 'monster_infantry', origin: '1 2 3' },
    ]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.yaw).toBe(0);
  });
  it('never throws on garbage input', () => {
    expect(collectEnemySpawns([])).toEqual([]);
    expect(() => collectEnemySpawns([{} as never])).not.toThrow();
  });
});

describe('summarizeEnemies', () => {
  it('reports zero and per-kind counts', () => {
    expect(summarizeEnemies([])).toBe('enemies: 0');
    expect(
      summarizeEnemies([
        { index: 0, classname: 'monster_soldier', kind: 'soldier', origin: [0, 0, 0], yaw: 0 },
        { index: 1, classname: 'monster_soldier_ss', kind: 'soldier', origin: [0, 0, 0], yaw: 0 },
        { index: 2, classname: 'monster_infantry', kind: 'infantry', origin: [0, 0, 0], yaw: 0 },
      ]),
    ).toBe('enemies: 3 (infantry x1, soldier x2)');
  });
});
