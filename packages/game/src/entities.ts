// @q2/game/entities — entity string parser + edict management.
// Ports g_spawn.c's COM_Parse-based entity lump parsing and G_Spawn/G_Free.
// The BSP entities lump is a sequence of { "key" "value" ... } blocks.

import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';

export type EntDict = Record<string, string>;

/** Parse a BSP entities lump into key/value dicts. Returns [] on empty input. */
export function parseEntities(text: string): EntDict[] {
  const out: EntDict[] = [];
  let i = 0;
  const n = text.length;
  const skipWs = (): void => {
    while (i < n) {
      const c = text[i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else break;
    }
  };
  const parseToken = (): string | null => {
    skipWs();
    if (i >= n) return null;
    const c = text[i]!;
    if (c === '{' || c === '}') {
      i++;
      return c;
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1]!;
          i += 2;
          if (e === 'n') s += '\n';
          else s += e;
        } else {
          s += text[i]!;
          i++;
        }
      }
      i++; // closing quote
      return s;
    }
    // bare token
    let s = '';
    while (i < n) {
      const d = text[i]!;
      if (d === ' ' || d === '\t' || d === '\n' || d === '\r' || d === '{' || d === '}') break;
      s += d;
      i++;
    }
    return s;
  };

  for (;;) {
    const t = parseToken();
    if (t === null) break;
    if (t !== '{') continue; // skip stray tokens between blocks
    const dict: EntDict = {};
    for (;;) {
      const key = parseToken();
      if (key === null || key === '}') break;
      const val = parseToken();
      if (val === null || val === '}') break;
      dict[key] = val;
    }
    out.push(dict);
  }
  return out;
}

export function parseVec3(s: string | undefined, fallback: Vec3): Vec3 {
  if (!s) return v3(fallback[0], fallback[1], fallback[2]);
  const parts = s.trim().split(/\s+/).map(Number);
  return v3(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0);
}

export function parseFloat(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const v = Number(s);
  return Number.isFinite(v) ? v : fallback;
}

export function parseInt(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const v = Number.parseInt(s, 10);
  return Number.isFinite(v) ? v : fallback;
}

// --- edicts ---

let nextEdictNum = 0;

export interface Edict {
  num: number;
  freed: boolean;
  classname: string;
  origin: Vec3;
  angles: Vec3;
  mins: Vec3;
  maxs: Vec3;
  velocity: Vec3;
  health: number;
  maxHealth: number;
  solid: number;
  movetype: number;
  spawnflags: number;
  targetname: string;
  target: string;
  model: string;
  message: string;
  count: number; // item quantity / generic counter
  dmg: number;
  speed: number;
  wait: number;
  lip: number;
  sounds: number;
  /** opaque per-logic state (movers, triggers, monsters) */
  state: string;
  extra: Record<string, string>;
}

export const SOLID_NOT = 0;
export const SOLID_TRIGGER = 1;
export const SOLID_BBOX = 2;
export const SOLID_BSP = 3;
export const MOVETYPE_NONE = 0;
export const MOVETYPE_STEP = 1;
export const MOVETYPE_PUSH = 2;

export function spawnEdict(dict: EntDict): Edict {
  const e: Edict = {
    num: nextEdictNum++,
    freed: false,
    classname: dict['classname'] ?? 'noclass',
    origin: parseVec3(dict['origin'], v3()),
    angles: parseVec3(dict['angles'], v3()),
    mins: parseVec3(dict['mins'], v3(-16, -16, -24)),
    maxs: parseVec3(dict['maxs'], v3(16, 16, 32)),
    velocity: v3(),
    health: parseInt(dict['health'], 0),
    maxHealth: 0,
    solid: SOLID_NOT,
    movetype: MOVETYPE_NONE,
    spawnflags: parseInt(dict['spawnflags'], 0),
    targetname: dict['targetname'] ?? '',
    target: dict['target'] ?? '',
    model: dict['model'] ?? '',
    message: dict['message'] ?? '',
    count: parseInt(dict['count'], 0),
    dmg: parseInt(dict['dmg'], 0),
    speed: parseFloat(dict['speed'], 0),
    wait: parseFloat(dict['wait'], 0),
    lip: parseFloat(dict['lip'], 0),
    sounds: parseInt(dict['sounds'], 0),
    state: '',
    extra: { ...dict },
  };
  e.maxHealth = e.health;
  return e;
}

/** For deterministic tests: reset the global edict counter. */
export function resetEdictNums(): void {
  nextEdictNum = 0;
}

export function freeEdict(e: Edict): void {
  e.freed = true;
}

/** Find all entities whose targetname equals name (G_Find by FOFS_targetname). */
export function findByTargetname(list: Edict[], name: string): Edict[] {
  return list.filter((e) => !e.freed && e.targetname === name);
}

/** Find all entities with the given classname. */
export function findByClassname(list: Edict[], classname: string): Edict[] {
  return list.filter((e) => !e.freed && e.classname === classname);
}

/** "use" routing: fire every entity targeted by `user.target` (G_UseTargets). */
export function useTargets(
  list: Edict[],
  user: Edict,
  fire: (target: Edict, user: Edict) => void,
): void {
  if (!user.target) return;
  for (const t of findByTargetname(list, user.target)) fire(t, user);
}
