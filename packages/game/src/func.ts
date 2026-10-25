// @q2/game/func — movers: func_door/plat/button + triggers + teleporter.
// Ports the behaviour of game/g_func.c (doors/plats/buttons) and
// game/g_trigger.c (trigger_once/multiple/relay/counter/teleporter).
// Movement is integrated by the server tick at 10Hz (level.time seconds).

import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import type { Edict } from './entities.js';

export const MOVER_BOTTOM = 'bottom';
export const MOVER_TOP = 'top';
export const MOVER_GOING_UP = 'going_up';
export const MOVER_GOING_DOWN = 'going_down';
export const MOVER_WAITING = 'waiting';

export interface Mover {
  ent: Edict;
  pos1: Vec3;
  pos2: Vec3;
  speed: number; // units/sec
  wait: number; // seconds at top before returning (-1 = stay)
  lip: number;
  state: string;
  /** time at which the current leg finishes */
  legEnd: number;
  /** time at which a waiting mover should start returning (or -1) */
  waitEnd: number;
}

// spawnflag bits
export const DOOR_START_OPEN = 1;
export const DOOR_REVERSE = 2;
export const DOOR_CRUSHER = 4;
export const DOOR_NOMONSTER = 8;
export const DOOR_TOGGLE = 32;
export const PLAT_LOW_TRIGGER = 1;

function dirBetween(a: Vec3, b: Vec3): { dir: Vec3; dist: number } {
  const dx = b[0]! - a[0]!;
  const dy = b[1]! - a[1]!;
  const dz = b[2]! - a[2]!;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist === 0) return { dir: v3(), dist: 0 };
  return { dir: v3(dx / dist, dy / dist, dz / dist), dist };
}

/**
 * Movement direction for an angle key (G_SetMovedir, game/g_utils.c):
 * yaw -1 is straight up, -2 straight down, else yaw degrees in the floor.
 */
export function moveDirForAngle(angleDeg: number): Vec3 {
  if (angleDeg === -1) return v3(0, 0, 1);
  if (angleDeg === -2) return v3(0, 0, -1);
  const rad = (angleDeg * Math.PI) / 180;
  return v3(Math.cos(rad), Math.sin(rad), 0);
}

/**
 * id door travel (SP_func_door): |movedir| . size - lip, where size is the
 * brush model's full bounds. The `distance` entity key does NOT exist for
 * doors in id; base1's door *31 needs this (156, not the 128 default) so the
 * slab actually clears the corridor when open.
 */
export function doorTravel(size: Vec3, angleDeg: number, lip: number): number {
  const dir = moveDirForAngle(angleDeg);
  const dist =
    Math.abs(dir[0]!) * size[0]! + Math.abs(dir[1]!) * size[1]! + Math.abs(dir[2]!) * size[2]!;
  return Math.max(0, dist - lip);
}

/** Spawn a func_door mover. angle = yaw degrees of travel direction. */
export function spawnDoor(ent: Edict, angleDeg: number, distance: number): Mover {
  const dir = moveDirForAngle(angleDeg);
  const lip = ent.lip || 8;
  const travel = Math.max(0, distance - lip);
  const pos1 = v3(ent.origin[0], ent.origin[1], ent.origin[2]);
  // VectorMA(pos1, travel, dir) on all three axes (id g_func.c); the z term
  // matters for angle -1/-2 (vertical) doors such as base1's door *19/*31.
  const pos2 = v3(
    pos1[0]! + dir[0]! * travel,
    pos1[1]! + dir[1]! * travel,
    pos1[2]! + dir[2]! * travel,
  );
  const m: Mover = {
    ent,
    pos1,
    pos2,
    speed: ent.speed || 100,
    wait: ent.wait === 0 ? 3 : ent.wait,
    lip,
    state: ent.spawnflags & DOOR_START_OPEN ? MOVER_TOP : MOVER_BOTTOM,
    legEnd: 0,
    waitEnd: -1,
  };
  ent.state = m.state;
  return m;
}

/** Spawn a func_plat (lift): pos2 = pos1 + height, trigger-at-bottom logic. */
export function spawnPlat(ent: Edict, height: number): Mover {
  const pos1 = v3(ent.origin[0], ent.origin[1], ent.origin[2]);
  const lip = ent.lip || 8;
  const pos2 = v3(pos1[0], pos1[1], pos1[2]! + Math.max(0, height - lip));
  const m: Mover = {
    ent,
    pos1,
    pos2,
    speed: ent.speed || 200,
    wait: ent.wait === 0 ? 3 : ent.wait,
    lip,
    state: MOVER_BOTTOM,
    legEnd: 0,
    waitEnd: -1,
  };
  ent.state = m.state;
  return m;
}

/** Spawn a func_button: moves `lip` units along its angle, fires targets, resets. */
export function spawnButton(ent: Edict, angleDeg: number): Mover {
  const dir = moveDirForAngle(angleDeg);
  const lip = ent.lip || 4;
  const pos1 = v3(ent.origin[0], ent.origin[1], ent.origin[2]);
  const pos2 = v3(pos1[0]! + dir[0]! * lip, pos1[1]! + dir[1]! * lip, pos1[2]! + dir[2]! * lip);
  const m: Mover = {
    ent,
    pos1,
    pos2,
    speed: ent.speed || 40,
    wait: ent.wait === 0 ? 1 : ent.wait,
    lip,
    state: MOVER_BOTTOM,
    legEnd: 0,
    waitEnd: -1,
  };
  ent.state = m.state;
  return m;
}

export function moverUse(m: Mover, now: number): void {
  if (m.state === MOVER_BOTTOM || m.state === MOVER_WAITING) {
    m.state = MOVER_GOING_UP;
    const { dist } = dirBetween(m.ent.origin, m.pos2);
    m.legEnd = now + (m.speed > 0 ? dist / m.speed : 0);
    m.waitEnd = -1;
  } else if (m.ent.spawnflags & DOOR_TOGGLE) {
    if (m.state === MOVER_TOP) {
      m.state = MOVER_GOING_DOWN;
      const { dist } = dirBetween(m.ent.origin, m.pos1);
      m.legEnd = now + (m.speed > 0 ? dist / m.speed : 0);
      m.waitEnd = -1;
    }
  }
  m.ent.state = m.state;
}

/** Advance one mover to `now` (seconds). Returns true when a leg completed. */
export function moverThink(m: Mover, now: number): boolean {
  const o = m.ent.origin;
  if (m.state === MOVER_GOING_UP || m.state === MOVER_GOING_DOWN) {
    const dest = m.state === MOVER_GOING_UP ? m.pos2 : m.pos1;
    const { dir, dist } = dirBetween(o, dest);
    if (dist <= 0 || now >= m.legEnd) {
      o[0] = dest[0]!;
      o[1] = dest[1]!;
      o[2] = dest[2]!;
      if (m.state === MOVER_GOING_UP) {
        m.state = MOVER_TOP;
        if (m.wait < 0 || m.ent.spawnflags & DOOR_TOGGLE) {
          m.waitEnd = -1;
        } else {
          m.state = MOVER_WAITING;
          m.waitEnd = now + m.wait;
        }
      } else {
        m.state = MOVER_BOTTOM;
        m.waitEnd = -1;
      }
      m.ent.state = m.state;
      return true;
    }
    const step = m.speed * 0.1; // integrated per server tick quantum
    void dir;
    const k = Math.min(1, step / dist);
    o[0] = o[0]! + (dest[0]! - o[0]!) * k;
    o[1] = o[1]! + (dest[1]! - o[1]!) * k;
    o[2] = o[2]! + (dest[2]! - o[2]!) * k;
    return false;
  }
  if (m.state === MOVER_WAITING && m.waitEnd >= 0 && now >= m.waitEnd) {
    m.state = MOVER_GOING_DOWN;
    const { dist } = dirBetween(o, m.pos1);
    m.legEnd = now + (m.speed > 0 ? dist / m.speed : 0);
    m.ent.state = m.state;
    m.waitEnd = -1;
    return false;
  }
  return false;
}

// --- triggers ---

export interface Trigger {
  ent: Edict;
  wait: number; // retrigger delay; -1 handled via fired-once
  nextFire: number; // earliest time it may fire again
  fired: boolean; // trigger_once semantics
  fireCount: number;
}

export function spawnTrigger(ent: Edict): Trigger {
  const t: Trigger = {
    ent,
    wait: ent.wait === 0 ? 0.2 : ent.wait,
    nextFire: 0,
    fired: false,
    fireCount: 0,
  };
  if (ent.classname === 'trigger_once') t.wait = -1;
  return t;
}

/**
 * Touch dispatch for trigger_once / trigger_multiple.
 * `onFire` is the G_UseTargets equivalent supplied by the caller.
 * Returns true if the trigger fired this call.
 */
export function triggerTouch(
  t: Trigger,
  now: number,
  toucherClass: string,
  onFire: (t: Trigger) => void,
): boolean {
  if (t.ent.classname === 'trigger_once' && t.fired) return false;
  if (now < t.nextFire) return false;
  if (toucherClass !== 'player' && !(t.ent.spawnflags & 2)) {
    // id: triggers react to players; MONSTER bit (2) allows monsters too
    if (toucherClass !== 'monster') return false;
  }
  t.fired = true;
  t.fireCount++;
  if (t.wait >= 0) t.nextFire = now + t.wait;
  onFire(t);
  return true;
}

/** Teleporter: move `who` to the destination entity's origin/angles. */
export function teleportTo(who: Edict, dest: Edict): void {
  who.origin[0] = dest.origin[0]!;
  who.origin[1] = dest.origin[1]!;
  who.origin[2] = dest.origin[2]! + 10; // id adds a step-up so players don't stick
  who.angles[0] = dest.angles[0]!;
  who.angles[1] = dest.angles[1]!;
  who.angles[2] = dest.angles[2]!;
  who.velocity[0] = 0;
  who.velocity[1] = 0;
  who.velocity[2] = 0;
}

// --- pusher carrying (SV_Push, game/g_phys.c) ---------------------------------
//
// id's SV_Push moves a MOVETYPE_PUSH entity by `move` and carries everything
// standing on it (groundentity == pusher) or embedded in its final position.
// Moves are quantized to 1/8 units for client-side prediction accuracy, and
// a rider that ends up stuck vetoes the whole push: everything rolls back
// and the pusher's blocked function runs (doors reverse via door_blocked).
// Our movers never rotate, so the amove (angular) term of the C code is
// documented-but-absent; translation is exact.

/** A body that can ride a pusher: headless pmove state or edict origin. */
export interface PushRider {
  origin: Vec3;
  mins: Vec3;
  maxs: Vec3;
  /** edict num of the mover this body stands on (-1 = world / none) */
  groundEntity: number;
}

/** id SV_Push move quantization: clamp each component to 1/8 units. */
export function SV_PushQuantize(move: Vec3): Vec3 {
  const q = (x: number): number => {
    const t = x * 8;
    return (t >= 0 ? Math.floor(t + 0.5) : Math.ceil(t - 0.5)) / 8;
  };
  return v3(q(move[0]!), q(move[1]!), q(move[2]!));
}

/**
 * SV_Push (g_phys.c): move `mover` by `move`, carrying riders whose
 * groundEntity is the pusher. Returns false (and rolls everything back)
 * when a carried rider ends up stuck inside solid — the C blocked path.
 * `solidAt` reports whether a rider box at the given origin is stuck.
 */
export function SV_Push(
  mover: Mover,
  move: Vec3,
  riders: PushRider[],
  solidAt: (origin: Vec3, mins: Vec3, maxs: Vec3) => boolean,
): boolean {
  const step = SV_PushQuantize(move);
  const savedMover = v3(mover.ent.origin[0], mover.ent.origin[1], mover.ent.origin[2]);
  mover.ent.origin[0] = savedMover[0]! + step[0]!;
  mover.ent.origin[1] = savedMover[1]! + step[1]!;
  mover.ent.origin[2] = savedMover[2]! + step[2]!;
  const saved: Array<{ rider: PushRider; origin: Vec3 }> = [];
  for (const r of riders) {
    if (r.groundEntity !== mover.ent.num) continue;
    // C moves riders standing on the pusher unconditionally, then checks.
    saved.push({ rider: r, origin: v3(r.origin[0], r.origin[1], r.origin[2]) });
    r.origin[0] = r.origin[0]! + step[0]!;
    r.origin[1] = r.origin[1]! + step[1]!;
    r.origin[2] = r.origin[2]! + step[2]!;
    if (solidAt(r.origin, r.mins, r.maxs)) {
      // C retries the rider at its pre-push spot (relevant for riders, not
      // pushed entities); only a still-stuck rider vetoes the push.
      const s = saved[saved.length - 1]!;
      r.origin[0] = s.origin[0]!;
      r.origin[1] = s.origin[1]!;
      r.origin[2] = s.origin[2]!;
      if (solidAt(r.origin, r.mins, r.maxs)) {
        for (const p of saved) {
          p.rider.origin[0] = p.origin[0]!;
          p.rider.origin[1] = p.origin[1]!;
          p.rider.origin[2] = p.origin[2]!;
        }
        mover.ent.origin[0] = savedMover[0]!;
        mover.ent.origin[1] = savedMover[1]!;
        mover.ent.origin[2] = savedMover[2]!;
        return false;
      }
      saved.pop();
    }
  }
  return true;
}
