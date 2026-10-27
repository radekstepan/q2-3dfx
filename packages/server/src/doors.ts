// @q2/server/doors — C-parity movers: func_door_secret, func_door_rotating,
// Think_CalcMoveSpeed. Ports game/g_func.c (door_secret_move1..6,
// door_secret_use/blocked/die, SP_func_door_secret, door_go_up/down +
// AngleMove_Calc for func_door_rotating, SP_func_door_rotating,
// Think_CalcMoveSpeed, door_blocked, Touch_DoorTrigger gating).
//
// Ground truth is ../external/quake-2-source/game/g_func.c; the TS port in
// ../external/quake-2-JS was cross-checked for the angular branch only.
// base1 ships no secret or rotating doors, so this module is proven by
// synthetic unit tests (doors.test.ts), not by the base1 bot.

import {
  DOOR_TOGGLE,
  MOVER_BOTTOM,
  MOVER_GOING_DOWN,
  MOVER_GOING_UP,
  MOVER_TOP,
  MOVER_WAITING,
} from '@q2/game';
import type { Edict, Mover } from '@q2/game';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';

// --- spawnflag bits (game/g_func.c door defines) ---------------------------
// DOOR_START_OPEN/REVERSE/CRUSHER/NOMONSTER/TOGGLE live in @q2/game (func.ts);
// the axis + secret bits are door-kind-specific and kept here, same pattern
// as the server's local DOOR_NOMONSTER copy in index.ts.

/** SP_func_door_rotating axis select (DOOR_X_AXIS / DOOR_Y_AXIS; else Z). */
export const DOOR_X_AXIS = 64;
/** SP_func_door_rotating axis select (see above). */
export const DOOR_Y_AXIS = 128;
/** func_door(_rotating) REVERSE bit (g_func.c; local copy, cf. DOOR_NOMONSTER). */
export const DOOR_REVERSE = 2;
/** func_door(_rotating) CRUSHER bit (g_func.c; local copy). */
export const DOOR_CRUSHER = 4;
/** func_door_secret: shootable even when targeted. */
export const SECRET_ALWAYS_SHOOT = 1;
/** func_door_secret: first move is left of the arrow. */
export const SECRET_1ST_LEFT = 2;
/** func_door_secret: first move is down from the arrow. */
export const SECRET_1ST_DOWN = 4;

/** Default secret-door travel speed (SP_func_door_secret forces 50). */
export const SECRET_SPEED = 50;
/** Pauses bracketing the slide (door_secret_move1/move5: exactly 1.0s). */
export const SECRET_PAUSE = 1.0;
/** Default secret hold-open wait (SP_func_door_secret: wait defaults to 5). */
export const SECRET_DEFAULT_WAIT = 5;
/** Default rotating-door swing (SP_func_door_rotating: distance defaults 90). */
export const ROT_DEFAULT_DISTANCE = 90;
/** Touch debounce for secret/rotating blocked damage (both use 0.5s). */
export const MOVER_TOUCH_DEBOUNCE = 0.5;
/** Crush damage for non-client/monster blockers (door/secret/train_blocked). */
export const CRUSH_DAMAGE = 100000;

// --- Think_CalcMoveSpeed (game/g_func.c) ------------------------------------
// Only the team master runs it; it sets every team member's speed (scaling
// accel/decel with it) so the shortest move's time governs and all parts
// arrive together. Our sim is constant-speed (Move_Calc-lite), so there are
// no accel/decel fields to scale — speeds alone carry the behaviour.

/** Minimal mover shape Think_CalcMoveSpeed reads and writes. */
export interface CalcMoveMember {
  distance: number;
  speed: number;
}

/**
 * id Think_CalcMoveSpeed over an explicit team (master first).
 * time = min |distance| / master.speed; every member gets
 * newspeed = |distance| / time. Single-member teams are the identity.
 */
export function thinkCalcMoveSpeed(members: CalcMoveMember[]): void {
  if (members.length === 0) return;
  let min = Infinity;
  for (const m of members) {
    const d = Math.abs(m.distance);
    if (d < min) min = d;
  }
  const master = members[0]!;
  if (!(master.speed > 0) || !(min > 0) || !Number.isFinite(min)) return;
  const time = min / master.speed;
  if (!(time > 0)) return;
  for (const m of members) m.speed = Math.abs(m.distance) / time;
}

/**
 * Apply Think_CalcMoveSpeed to every `team`-keyed mover group (size >= 2).
 * id teams via the `team` entity key; unteamed movers are teams of one and
 * need no adjustment. distance = |pos2 - pos1|, master = spawn order.
 */
export function applyTeamMoveSpeeds(movers: Mover[]): void {
  const groups = new Map<string, Mover[]>();
  for (const m of movers) {
    const team = m.ent.extra['team'];
    if (!team) continue;
    const g = groups.get(team);
    if (g) g.push(m);
    else groups.set(team, [m]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const members: CalcMoveMember[] = g.map((m) => ({
      distance: Math.hypot(
        m.pos2[0]! - m.pos1[0]!,
        m.pos2[1]! - m.pos1[1]!,
        m.pos2[2]! - m.pos1[2]!,
      ),
      speed: m.speed,
    }));
    thinkCalcMoveSpeed(members);
    for (let i = 0; i < g.length; i++) g[i]!.speed = members[i]!.speed;
  }
}

// --- func_door_secret (game/g_func.c) ---------------------------------------
// Sequence: use (at rest only) -> back to pos1 (move1) -> 1s pause (move2)
// -> slide to pos2 (move3) -> hold `wait` (move4; -1 holds forever) ->
// return to pos1 (move5) -> 1s pause (move6) -> close to origin (done).
// C plays NO sounds on this chain (the move funcs carry no gi.sound calls;
// moveinfo sounds are set but never fired) — silence here is C-faithful.
// C spawns no Touch_DoorTrigger for secrets: touch never opens one; use
// (button/trigger relay or damage when shootable) is the only opener, and
// re-fire is gated on being fully back at rest (origin compare in use).

export type SecretPhase =
  | 'idle'
  | 'back'
  | 'pause1'
  | 'slide'
  | 'hold'
  | 'open'
  | 'return'
  | 'pause2'
  | 'close';

export interface SecretMover {
  ent: Edict;
  /** Rest origin the lump spawned at (C compares against vec3_origin; brush models rest at 0,0,0). */
  origin0: Vec3;
  /** Backed-out position (origin0 + side*width*right, or -width*up). */
  pos1: Vec3;
  /** Slid-open position (pos1 + length*forward). */
  pos2: Vec3;
  speed: number;
  /** Hold-open seconds (-1 = stay open). */
  wait: number;
  dmg: number;
  /** Shootable even while closed (no targetname, or ALWAYS_SHOOT). */
  shootable: boolean;
  phase: SecretPhase;
  legEnd: number;
  waitUntil: number;
  touchDebounce: number;
}

/** Advance `origin` toward `dest` at `speed*dt`; snap + true on arrival. */
function stepOriginToward(origin: Vec3, dest: Vec3, speed: number, dt: number): boolean {
  const dx = dest[0]! - origin[0]!;
  const dy = dest[1]! - origin[1]!;
  const dz = dest[2]! - origin[2]!;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const step = speed * dt;
  if (len <= step || len === 0) {
    origin[0] = dest[0]!;
    origin[1] = dest[1]!;
    origin[2] = dest[2]!;
    return true;
  }
  const k = step / len;
  origin[0] = origin[0]! + dx * k;
  origin[1] = origin[1]! + dy * k;
  origin[2] = origin[2]! + dz * k;
  return false;
}

function secretOriginEq(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * SP_func_door_secret geometry. `size` is the brush-model bounds size
 * (maxs - mins); null (unknown model) yields a degenerate door, like C
 * would with an empty size. Consumes ent.angles (VectorClear) like C.
 */
export function spawnSecretDoor(ent: Edict, size: Vec3 | null): SecretMover {
  const fwd = v3();
  const right = v3();
  const up = v3();
  AngleVectors(ent.angles, fwd, right, up);
  ent.angles[0] = 0;
  ent.angles[1] = 0;
  ent.angles[2] = 0;
  const sx = size ? size[0]! : 0;
  const sy = size ? size[1]! : 0;
  const sz = size ? size[2]! : 0;
  const dotR = Math.abs(right[0]! * sx + right[1]! * sy + right[2]! * sz);
  const dotU = Math.abs(up[0]! * sx + up[1]! * sy + up[2]! * sz);
  const dotF = Math.abs(fwd[0]! * sx + fwd[1]! * sy + fwd[2]! * sz);
  // side = 1 - (flags & SECRET_1ST_LEFT): +1 normally, -1 when 1ST_LEFT (2).
  const side = ent.spawnflags & SECRET_1ST_LEFT ? -1 : 1;
  const width = ent.spawnflags & SECRET_1ST_DOWN ? dotU : dotR;
  const length = dotF;
  const origin0 = v3(ent.origin[0], ent.origin[1], ent.origin[2]);
  let pos1: Vec3;
  if (ent.spawnflags & SECRET_1ST_DOWN) {
    pos1 = v3(
      origin0[0]! - width * up[0]!,
      origin0[1]! - width * up[1]!,
      origin0[2]! - width * up[2]!,
    );
  } else {
    pos1 = v3(
      origin0[0]! + side * width * right[0]!,
      origin0[1]! + side * width * right[1]!,
      origin0[2]! + side * width * right[2]!,
    );
  }
  const pos2 = v3(
    pos1[0]! + length * fwd[0]!,
    pos1[1]! + length * fwd[1]!,
    pos1[2]! + length * fwd[2]!,
  );
  const sm: SecretMover = {
    ent,
    origin0,
    pos1,
    pos2,
    speed: SECRET_SPEED,
    wait: ent.wait === 0 ? SECRET_DEFAULT_WAIT : ent.wait,
    dmg: ent.dmg === 0 ? 2 : ent.dmg,
    shootable: !ent.targetname || (ent.spawnflags & SECRET_ALWAYS_SHOOT) !== 0,
    phase: 'idle',
    legEnd: 0,
    waitUntil: -1,
    touchDebounce: 0,
  };
  ent.state = sm.phase;
  return sm;
}

/**
 * door_secret_use: no-op unless fully at rest (C compares s.origin against
 * vec3_origin — here origin0, identical for brush models). Starts the back
 * leg. Returns true when the sequence started (re-fire gate for callers).
 */
export function secretUse(sm: SecretMover, now: number): boolean {
  if (sm.phase !== 'idle') return false;
  if (!secretOriginEq(sm.ent.origin, sm.origin0)) return false;
  sm.phase = 'back';
  const dx = sm.pos1[0]! - sm.ent.origin[0]!;
  const dy = sm.pos1[1]! - sm.ent.origin[1]!;
  const dz = sm.pos1[2]! - sm.ent.origin[2]!;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  sm.legEnd = now + (sm.speed > 0 ? dist / sm.speed : 0);
  sm.ent.state = sm.phase;
  return true;
}

/**
 * Advance one secret door by dt. Returns the origin displacement this tick
 * (for SV_Push-style rider carrying). Think chain mirrors move1..move6/done.
 */
export function secretThink(sm: SecretMover, now: number, dt: number): Vec3 {
  const ox = sm.ent.origin[0]!;
  const oy = sm.ent.origin[1]!;
  const oz = sm.ent.origin[2]!;
  switch (sm.phase) {
    case 'back':
      if (stepOriginToward(sm.ent.origin, sm.pos1, sm.speed, dt) || now >= sm.legEnd) {
        sm.ent.origin[0] = sm.pos1[0]!;
        sm.ent.origin[1] = sm.pos1[1]!;
        sm.ent.origin[2] = sm.pos1[2]!;
        sm.phase = 'pause1';
        sm.waitUntil = now + SECRET_PAUSE;
        sm.ent.state = sm.phase;
      }
      break;
    case 'pause1':
      if (now >= sm.waitUntil) {
        sm.phase = 'slide';
        const dx = sm.pos2[0]! - sm.ent.origin[0]!;
        const dy = sm.pos2[1]! - sm.ent.origin[1]!;
        const dz = sm.pos2[2]! - sm.ent.origin[2]!;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        sm.legEnd = now + (sm.speed > 0 ? dist / sm.speed : 0);
        sm.ent.state = sm.phase;
      }
      break;
    case 'slide':
      if (stepOriginToward(sm.ent.origin, sm.pos2, sm.speed, dt) || now >= sm.legEnd) {
        sm.ent.origin[0] = sm.pos2[0]!;
        sm.ent.origin[1] = sm.pos2[1]!;
        sm.ent.origin[2] = sm.pos2[2]!;
        if (sm.wait < 0) {
          sm.phase = 'open';
        } else {
          sm.phase = 'hold';
          sm.waitUntil = now + sm.wait;
        }
        sm.ent.state = sm.phase;
      }
      break;
    case 'hold':
      if (now >= sm.waitUntil) {
        sm.phase = 'return';
        const dx = sm.pos1[0]! - sm.ent.origin[0]!;
        const dy = sm.pos1[1]! - sm.ent.origin[1]!;
        const dz = sm.pos1[2]! - sm.ent.origin[2]!;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        sm.legEnd = now + (sm.speed > 0 ? dist / sm.speed : 0);
        sm.ent.state = sm.phase;
      }
      break;
    case 'return':
      if (stepOriginToward(sm.ent.origin, sm.pos1, sm.speed, dt) || now >= sm.legEnd) {
        sm.ent.origin[0] = sm.pos1[0]!;
        sm.ent.origin[1] = sm.pos1[1]!;
        sm.ent.origin[2] = sm.pos1[2]!;
        sm.phase = 'pause2';
        sm.waitUntil = now + SECRET_PAUSE;
        sm.ent.state = sm.phase;
      }
      break;
    case 'pause2':
      if (now >= sm.waitUntil) {
        sm.phase = 'close';
        const dx = sm.origin0[0]! - sm.ent.origin[0]!;
        const dy = sm.origin0[1]! - sm.ent.origin[1]!;
        const dz = sm.origin0[2]! - sm.ent.origin[2]!;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        sm.legEnd = now + (sm.speed > 0 ? dist / sm.speed : 0);
        sm.ent.state = sm.phase;
      }
      break;
    case 'close':
      if (stepOriginToward(sm.ent.origin, sm.origin0, sm.speed, dt) || now >= sm.legEnd) {
        sm.ent.origin[0] = sm.origin0[0]!;
        sm.ent.origin[1] = sm.origin0[1]!;
        sm.ent.origin[2] = sm.origin0[2]!;
        sm.phase = 'idle';
        sm.ent.state = sm.phase;
        // door_secret_done re-arms damage so a closed secret is shootable
        // again (shootable doors only; targeted non-ALWAYS_SHOOT doors
        // stay inert, exactly like C).
        if (sm.shootable) {
          sm.ent.health = 0;
        }
      }
      break;
    case 'idle':
    case 'open':
    case 'hold':
      break;
  }
  return v3(sm.ent.origin[0]! - ox, sm.ent.origin[1]! - oy, sm.ent.origin[2]! - oz);
}

export interface SecretBlockedHit {
  /** Damage to deal (CRUSH_DAMAGE + gib-nuke for debris, dmg otherwise). */
  dmg: number;
  /** True when the victim is debris/gibs: take the damage AND free it. */
  crush: boolean;
}

/**
 * door_secret_blocked: non-client/monster victims take 100000 (plus the
 * BecomeExplosion1 nuke — `crush` tells the caller to free the victim);
 * players/monsters take dmg, debounced at 0.5s. Null while debounced.
 */
export function secretBlocked(
  sm: SecretMover,
  victimKind: 'player' | 'monster' | 'other',
  now: number,
): SecretBlockedHit | null {
  if (victimKind === 'other') return { dmg: CRUSH_DAMAGE, crush: true };
  if (now < sm.touchDebounce) return null;
  sm.touchDebounce = now + MOVER_TOUCH_DEBOUNCE;
  return { dmg: sm.dmg, crush: false };
}

/**
 * door_secret_die: shooting a closed shootable secret runs use (which
 * requires rest, so mid-sequence shots are ignored, like C).
 */
export function secretDie(sm: SecretMover, now: number): boolean {
  if (!sm.shootable) return false;
  return secretUse(sm, now);
}

// --- func_door_rotating (game/g_func.c) --------------------------------------
// Angular twin of func_door: pos1/pos2 are ANGLES (degrees). Axis from
// spawnflags (X_AXIS / Y_AXIS, else Z), REVERSE negates, distance defaults
// to 90. START_OPEN swaps the angles and negates movedir (door rests open
// and closes when triggered). door_go_up/down dispatch on classname; sounds
// fire on leg start (sound_start) and arrival (sound_end) like linear doors.

/**
 * C door_use/door_go_up for the slider touch path (game/g_func.c): GOING_UP
 * → nothing (C returns early: already going up); TOP (or WAITING, our
 * TOP-with-a-pending-close) → reset the FULL wait, no leg restart and no
 * target fire (C only resets nextthink); TOGGLE at UP/TOP/WAITING → start
 * the DOWN leg (C reverses paired doors); otherwise (BOTTOM, or DOWN
 * mid-close) → start the UP leg from the current origin.
 *
 * Returns 'opened' when an UP leg starts (caller fires the door's target
 * once, like C door_go_up's G_UseTargets), 'closed' on a TOGGLE close (C
 * door_go_down fires no targets), 'held' on a TOP wait reset, null when
 * already going up.
 */
export function doorTouchUse(m: Mover, now: number): 'opened' | 'closed' | 'held' | null {
  if (m.state === MOVER_GOING_UP) return null;
  if (m.ent.spawnflags & DOOR_TOGGLE) {
    if (m.state === MOVER_TOP || m.state === MOVER_WAITING) {
      m.state = MOVER_GOING_DOWN;
      const dx = m.pos1[0]! - m.ent.origin[0]!;
      const dy = m.pos1[1]! - m.ent.origin[1]!;
      const dz = m.pos1[2]! - m.ent.origin[2]!;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      m.legEnd = now + (m.speed > 0 ? dist / m.speed : 0);
      m.waitEnd = -1;
      m.ent.state = m.state;
      return 'closed';
    }
    // TOGGLE at BOTTOM/DOWN falls through to the UP leg below (C door_use
    // runs door_go_up for every other state).
  } else if (m.state === MOVER_TOP || m.state === MOVER_WAITING) {
    if (m.wait >= 0) {
      m.waitEnd = now + m.wait;
      m.ent.state = m.state;
    }
    return 'held';
  }
  m.state = MOVER_GOING_UP;
  const dx = m.pos2[0]! - m.ent.origin[0]!;
  const dy = m.pos2[1]! - m.ent.origin[1]!;
  const dz = m.pos2[2]! - m.ent.origin[2]!;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  m.legEnd = now + (m.speed > 0 ? dist / m.speed : 0);
  m.waitEnd = -1;
  m.ent.state = m.state;
  return 'opened';
}

export interface RotMover {
  ent: Edict;
  /** Closed angles (C pos1; mapper angles are VectorClear'ed). */
  startAngles: Vec3;
  /** Open angles (C pos2 = start + distance*movedir). */
  endAngles: Vec3;
  speed: number;
  wait: number;
  dmg: number;
  state: string;
  legEnd: number;
  waitEnd: number;
  touchDebounce: number;
  /** sounds == 1: silent (SP_func_door_rotating). */
  silent: boolean;
}

/** Real pak sound keys (C defaults; sounds==1 suppresses them). */
export const DOOR_SOUND_START = 'doors/dr1_strt.wav';
export const DOOR_SOUND_END = 'doors/dr1_end.wav';

/** SP_func_door_rotating: axis from spawnflags, 90-degree default swing. */
export function spawnRotDoor(ent: Edict): RotMover {
  const movedir = v3(0, 0, 0);
  if (ent.spawnflags & DOOR_X_AXIS) movedir[2] = 1;
  else if (ent.spawnflags & DOOR_Y_AXIS) movedir[0] = 1;
  else movedir[1] = 1; // Z_AXIS default
  if (ent.spawnflags & DOOR_REVERSE) {
    movedir[0] = -movedir[0]!;
    movedir[1] = -movedir[1]!;
    movedir[2] = -movedir[2]!;
  }
  const raw = ent.extra['distance'];
  let distance = raw !== undefined ? Number(raw) : NaN;
  if (!Number.isFinite(distance)) distance = ROT_DEFAULT_DISTANCE;
  // C VectorClears s.angles: the mapper angle key is ignored.
  ent.angles[0] = 0;
  ent.angles[1] = 0;
  ent.angles[2] = 0;
  let startAngles = v3(0, 0, 0);
  let endAngles = v3(movedir[0]! * distance, movedir[1]! * distance, movedir[2]! * distance);
  if (ent.spawnflags & 1 /* DOOR_START_OPEN */) {
    // Swap so the door rests open; movedir negation is internal (C keeps
    // it for team/areaportal consistency — no teams here, noted).
    const t = startAngles;
    startAngles = endAngles;
    endAngles = t;
    ent.angles[0] = startAngles[0]!;
    ent.angles[1] = startAngles[1]!;
    ent.angles[2] = startAngles[2]!;
  }
  const rm: RotMover = {
    ent,
    startAngles,
    endAngles,
    speed: ent.speed || 100,
    wait: ent.wait === 0 ? 3 : ent.wait,
    dmg: ent.dmg === 0 ? 2 : ent.dmg,
    state: MOVER_BOTTOM,
    legEnd: 0,
    waitEnd: -1,
    touchDebounce: 0,
    silent: ent.sounds === 1,
  };
  ent.state = rm.state;
  return rm;
}

function rotDist(a: Vec3, b: Vec3): number {
  const dx = b[0]! - a[0]!;
  const dy = b[1]! - a[1]!;
  const dz = b[2]! - a[2]!;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * door_use for a rotating door. Returns 'opened' when an opening leg starts
 * (caller fires the door's target — C door_go_up runs G_UseTargets), 'closed'
 * when a TOGGLE door starts closing (no targets — C door_go_down fires none),
 * null when nothing happened (already going up, or TOP wait reset).
 */
export function rotUse(rm: RotMover, now: number): 'opened' | 'closed' | null {
  if (rm.ent.spawnflags & DOOR_TOGGLE) {
    if (rm.state === MOVER_GOING_UP || rm.state === MOVER_TOP) {
      rotGoDown(rm, now);
      return 'closed';
    }
  }
  return rotGoUp(rm, now) ? 'opened' : null;
}

/** door_go_up (angular branch): resets TOP wait, else starts the up leg. */
export function rotGoUp(rm: RotMover, now: number): boolean {
  if (rm.state === MOVER_GOING_UP) return false;
  // C has no WAITING state: TOP with a pending go_down IS our WAITING, and
  // door_go_up on TOP only resets the wait (SV_TouchDoorsAt re-fire likewise
  // refreshes the wait instead of starting a second leg).
  if (rm.state === MOVER_TOP || rm.state === MOVER_WAITING) {
    if (rm.wait >= 0) {
      rm.waitEnd = now + rm.wait;
      rm.ent.state = rm.state;
    }
    return false;
  }
  rm.state = MOVER_GOING_UP;
  const dist = rotDist(rm.ent.angles, rm.endAngles);
  rm.legEnd = now + (rm.speed > 0 ? dist / rm.speed : 0);
  rm.waitEnd = -1;
  rm.ent.state = rm.state;
  return true;
}

/** door_go_down (angular branch). */
export function rotGoDown(rm: RotMover, now: number): void {
  rm.state = MOVER_GOING_DOWN;
  const dist = rotDist(rm.ent.angles, rm.startAngles);
  rm.legEnd = now + (rm.speed > 0 ? dist / rm.speed : 0);
  rm.waitEnd = -1;
  rm.ent.state = rm.state;
}

/**
 * Advance one rotating door by dt (AngleMove_Calc/Begin/Final, constant
 * speed — our sim has no accel branch, matching the linear movers).
 * Returns sound keys fired this tick (start on leg begin, end on arrival).
 */
export function rotThink(rm: RotMover, now: number, dt: number): string[] {
  const sounds: string[] = [];
  const fire = (s: string): void => {
    if (!rm.silent) sounds.push(s);
  };
  if (rm.state === MOVER_GOING_UP || rm.state === MOVER_GOING_DOWN) {
    const dest = rm.state === MOVER_GOING_UP ? rm.endAngles : rm.startAngles;
    const dx = dest[0]! - rm.ent.angles[0]!;
    const dy = dest[1]! - rm.ent.angles[1]!;
    const dz = dest[2]! - rm.ent.angles[2]!;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const step = rm.speed * dt;
    if (len <= step || len === 0 || now >= rm.legEnd) {
      rm.ent.angles[0] = dest[0]!;
      rm.ent.angles[1] = dest[1]!;
      rm.ent.angles[2] = dest[2]!;
      fire(DOOR_SOUND_END);
      if (rm.state === MOVER_GOING_UP) {
        rm.state = MOVER_TOP;
        if (rm.wait < 0 || rm.ent.spawnflags & DOOR_TOGGLE) {
          rm.waitEnd = -1;
        } else {
          rm.state = MOVER_WAITING;
          rm.waitEnd = now + rm.wait;
        }
      } else {
        rm.state = MOVER_BOTTOM;
        rm.waitEnd = -1;
      }
      rm.ent.state = rm.state;
    } else {
      const k = step / len;
      rm.ent.angles[0] = rm.ent.angles[0]! + dx * k;
      rm.ent.angles[1] = rm.ent.angles[1]! + dy * k;
      rm.ent.angles[2] = rm.ent.angles[2]! + dz * k;
    }
    return sounds;
  }
  if (rm.state === MOVER_WAITING && rm.waitEnd >= 0 && now >= rm.waitEnd) {
    rotGoDown(rm, now);
    fire(DOOR_SOUND_START);
    rm.ent.state = rm.state;
  }
  return sounds;
}

/** Sound key for a leg start (rotGoUp/rotGoDown play sound_start in C). */
export function rotStartSound(rm: RotMover): string | null {
  return rm.silent ? null : DOOR_SOUND_START;
}

export interface RotBlockedHit extends SecretBlockedHit {
  /** C door_blocked response: reverse travel, or keep crushing through. */
  action: 'reverse' | 'continue';
}

/**
 * door_blocked for rotating doors: debris takes the 100000 crush (+ free);
 * players/monsters take dmg debounced at 0.5s. CRUSHER doors never reverse;
 * negative-wait doors squash straight through (C only reverses when
 * wait >= 0); otherwise travel reverses (up->down, anything else->up).
 */
export function rotBlocked(
  rm: RotMover,
  victimKind: 'player' | 'monster' | 'other',
  now: number,
): RotBlockedHit | null {
  if (victimKind === 'other') return { dmg: CRUSH_DAMAGE, crush: true, action: 'continue' };
  if (now < rm.touchDebounce) return null;
  rm.touchDebounce = now + MOVER_TOUCH_DEBOUNCE;
  const crusher = (rm.ent.spawnflags & DOOR_CRUSHER) !== 0;
  const action: 'reverse' | 'continue' = !crusher && rm.wait >= 0 ? 'reverse' : 'continue';
  return { dmg: rm.dmg, crush: false, action };
}

/** Apply a rotBlocked 'reverse' verdict (C re-runs go_up/go_down by state). */
export function rotReverse(rm: RotMover, now: number): void {
  if (rm.state === MOVER_GOING_DOWN) rotGoUp(rm, now);
  else rotGoDown(rm, now);
}
