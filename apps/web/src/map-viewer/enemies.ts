// apps/web/src/map-viewer/enemies.ts — enemy spawn extraction for the map viewer.
//
// The viewer never starts gameplay; it renders monster spawn entities as
// static MD2s at their BSP spawn pose so mappers can see where foes stand.
// Pure data mapping only: parsing + pak lump paths. Loading (readPakEntry)
// and registration (SoftwareRenderer) live in main.ts/renderer.ts so this
// module stays headless-testable with synthetic dicts.

import type { EntDict } from '@q2/game';

/** Monster kinds the viewer can pose with a real MD2 (game/assets tables). */
export type EnemyKind = 'soldier' | 'gunner' | 'infantry';

/** Every classname rendered as an enemy (C spawn funcs + light/ss variants). */
export const ENEMY_CLASSNAMES: readonly string[] = [
  'monster_soldier',
  'monster_soldier_light',
  'monster_soldier_ss',
  'monster_gunner',
  'monster_infantry',
];

/** Static spawn pose pulled from one entity dict. Yaw in degrees. */
export interface EnemySpawn {
  index: number;
  classname: string;
  kind: EnemyKind | null;
  origin: [number, number, number];
  yaw: number;
}

/** Map a BSP classname to its lite monster kind; null when not an enemy. */
export function enemyKindForClassname(classname: string): EnemyKind | null {
  if (
    classname === 'monster_soldier' ||
    classname === 'monster_soldier_light' ||
    classname === 'monster_soldier_ss'
  ) {
    return 'soldier';
  }
  if (classname === 'monster_gunner') return 'gunner';
  if (classname === 'monster_infantry') return 'infantry';
  // Unknown monster_* variants still render with the soldier fallback mesh.
  if (classname.startsWith('monster_')) return null;
  return null;
}

/** True for any entity the viewer renders as an enemy. */
export function isEnemyClassname(classname: string): boolean {
  return classname.startsWith('monster_');
}

/** Pak MD2 lump for an enemy kind (mirrors @q2/game assets tables). */
export function modelPathForEnemyKind(kind: EnemyKind): string {
  if (kind === 'gunner') return 'models/monsters/gunner/tris.md2';
  if (kind === 'infantry') return 'models/monsters/infantry/tris.md2';
  return 'models/monsters/soldier/tris.md2';
}

/**
 * Pak skin lump for an enemy classname (m_soldier.c skinnum: light -> skin_lt,
 * ss -> skin_ss, otherwise the kind default; gunner/infantry have one skin).
 */
export function skinPathForEnemyClassname(classname: string, kind: EnemyKind | null): string {
  if (classname === 'monster_soldier_light') return 'models/monsters/soldier/skin_lt.pcx';
  if (classname === 'monster_soldier_ss') return 'models/monsters/soldier/skin_ss.pcx';
  if (kind === 'gunner') return 'models/monsters/gunner/skin.pcx';
  if (kind === 'infantry') return 'models/monsters/infantry/skin.pcx';
  return 'models/monsters/soldier/skin.pcx';
}

function parseOriginTriple(value: string | undefined): [number, number, number] | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((v) => !Number.isFinite(v))) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

function parseYaw(dict: EntDict): number {
  const single = dict['angle'];
  if (typeof single === 'string' && single.trim() !== '') {
    const yaw = Number(single.trim());
    if (Number.isFinite(yaw)) return yaw;
  }
  const triple = dict['angles'];
  if (typeof triple === 'string') {
    const parts = triple.trim().split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every((v) => Number.isFinite(v))) return parts[1]!;
  }
  return 0;
}

/**
 * Collect renderable enemy spawns from parsed entity dicts. Point monsters
 * without a usable origin are skipped (listed as unsupported in panel.ts,
 * never rendered). Never throws.
 */
export function collectEnemySpawns(dicts: EntDict[]): EnemySpawn[] {
  const out: EnemySpawn[] = [];
  try {
    dicts.forEach((dict, index) => {
      try {
        const raw = dict['classname'];
        if (typeof raw !== 'string' || !raw.startsWith('monster_')) return;
        const origin = parseOriginTriple(dict['origin']);
        if (!origin) return;
        const kind = enemyKindForClassname(raw);
        out.push({ index, classname: raw, kind, origin, yaw: parseYaw(dict) });
      } catch {
        /* skip one bad dict, keep the rest */
      }
    });
  } catch {
    return [];
  }
  return out;
}

/** One-line status summary, e.g. `enemies: 3 (soldier x2, infantry x1)`. */
export function summarizeEnemies(spawns: EnemySpawn[]): string {
  if (spawns.length === 0) return 'enemies: 0';
  const counts = new Map<string, number>();
  for (const s of spawns) counts.set(s.kind ?? 'unknown', (counts.get(s.kind ?? 'unknown') ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, n]) => `${kind} x${n}`);
  return `enemies: ${spawns.length} (${parts.join(', ')})`;
}
