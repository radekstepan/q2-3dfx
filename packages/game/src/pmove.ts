// @q2/game/pmove — player movement physics, ported from qcommon/pmove.c.
// Quake coords (+X fwd, +Y left, +Z up), angles [pitch, yaw, roll] degrees.
// Determinism: dt comes ONLY from cmd.msec (clamped 1..200ms, as id did).
// No wall-clock, no Math.random anywhere in this module.

import { v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';

// --- tuning constants (id's pm_* globals, qcommon/pmove.c) ---
export const PM_STOPSPEED = 100;
export const PM_MAXSPEED = 300;
export const PM_DUCKSPEED = 100;
export const PM_ACCELERATE = 10;
export const PM_AIRACCELERATE = 0;
export const PM_WATERACCELERATE = 10;
export const PM_FRICTION = 6;
export const PM_WATERFRICTION = 1;
export const PM_WATERSPEED = 400;
export const PM_GRAVITY = 800;
export const PM_JUMP_VELOCITY = 270;
export const STEPSIZE = 18;
export const MIN_STEP_NORMAL = 0.7;
export const MAX_CLIP_PLANES = 5;
export const STOP_EPSILON = 0.1;

// pm_flags bits (game/game.h shared values)
export const PMF_DUCKED = 1 << 0;
export const PMF_JUMP_HELD = 1 << 1;
export const PMF_ON_GROUND = 1 << 2;
export const PMF_TIME_WATERJUMP = 1 << 3;
export const PMF_TIME_LAND = 1 << 4;
export const PMF_TIME_TELEPORT = 1 << 5;

export interface UserCmd {
  msec: number;
  angles: Vec3; // [pitch, yaw, roll]
  forwardmove: number;
  sidemove: number;
  upmove: number;
  buttons: number;
}

export interface PmoveState {
  origin: Vec3;
  velocity: Vec3;
  mins: Vec3;
  maxs: Vec3;
  viewAngles: Vec3;
  pmFlags: number;
  pmTime: number; // ms remaining on pm_time effects
  gravity: number;
  waterlevel: number; // 0..3
  watertype: number;
  groundEntity: number; // -1 = none
  viewheight: number;
  onGround: boolean;
  ladder: boolean;
}

export interface TraceResult {
  fraction: number;
  endpos: Vec3;
  planeNormal: Vec3;
  allsolid: boolean;
  startsolid: boolean;
  entityNum: number; // -1 = world/none
  contents: number;
  /**
   * Surface flags of the hit brushside's texinfo (q_shared.h SURF_* bits,
   * e.g. SURF_SKY from @q2/bsp) — the C trace_t.surface->flags equivalent.
   * Additive optional: absent/0 when the trace never hit a brush.
   */
  surfaceFlags?: number;
}

export type TraceFn = (start: Vec3, mins: Vec3, maxs: Vec3, end: Vec3) => TraceResult;
export type PointContentsFn = (p: Vec3) => number;

export const CONTENTS_NONE = 0;
export const CONTENTS_SOLID = 1;
export const CONTENTS_WATER = 2;
export const CONTENTS_SLIME = 4;
export const CONTENTS_LAVA = 8;
export const CONTENTS_LADDER = 16;
export const MASK_WATER = CONTENTS_WATER | CONTENTS_SLIME | CONTENTS_LAVA;

function defaultTrace(_s: Vec3, _mi: Vec3, _ma: Vec3, end: Vec3): TraceResult {
  return {
    fraction: 1,
    endpos: new Float32Array(end) as Vec3,
    planeNormal: v3(0, 0, 1),
    allsolid: false,
    startsolid: false,
    entityNum: -1,
    contents: 0,
  };
}

function defaultContents(_p: Vec3): number {
  return CONTENTS_NONE;
}

let activeTrace: TraceFn = defaultTrace;
let activeContents: PointContentsFn = defaultContents;

/** Inject the world query hooks (collision + contents). Defaults to empty world. */
export function setPmoveWorld(trace: TraceFn, contents?: PointContentsFn): void {
  activeTrace = trace;
  if (contents) activeContents = contents;
}

export function resetPmoveWorld(): void {
  activeTrace = defaultTrace;
  activeContents = defaultContents;
}

export function makePmoveState(): PmoveState {
  return {
    origin: v3(),
    velocity: v3(),
    mins: v3(-16, -16, -24),
    maxs: v3(16, 16, 32),
    viewAngles: v3(),
    pmFlags: 0,
    pmTime: 0,
    gravity: PM_GRAVITY,
    waterlevel: 0,
    watertype: 0,
    groundEntity: -1,
    viewheight: 22,
    onGround: false,
    ladder: false,
  };
}

export function clonePmoveState(s: PmoveState): PmoveState {
  return {
    origin: new Float32Array(s.origin) as Vec3,
    velocity: new Float32Array(s.velocity) as Vec3,
    mins: new Float32Array(s.mins) as Vec3,
    maxs: new Float32Array(s.maxs) as Vec3,
    viewAngles: new Float32Array(s.viewAngles) as Vec3,
    pmFlags: s.pmFlags,
    pmTime: s.pmTime,
    gravity: s.gravity,
    waterlevel: s.waterlevel,
    watertype: s.watertype,
    groundEntity: s.groundEntity,
    viewheight: s.viewheight,
    onGround: s.onGround,
    ladder: s.ladder,
  };
}

function dot3(a: Vec3 | Float32Array, b: Vec3 | Float32Array): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

/** id's PM_ClipVelocity. Returns blocked flags (1 floor, 2 wall/step). */
export function PM_ClipVelocity(
  input: Vec3,
  normal: Vec3,
  output: Vec3,
  overbounce: number,
): number {
  const backoff = dot3(input, normal) * overbounce;
  for (let i = 0; i < 3; i++) {
    const change = normal[i]! * backoff;
    let v = input[i]! - change;
    if (v > -STOP_EPSILON && v < STOP_EPSILON) v = 0;
    output[i] = v;
  }
  // blocked flags: id returns them from the caller; compute here for convenience
  let blocked = 0;
  if (normal[2]! > 0) blocked |= 1;
  if (normal[2]! === 0) blocked |= 2;
  return blocked;
}

interface SlideCtx {
  origin: Vec3;
  velocity: Vec3;
  mins: Vec3;
  maxs: Vec3;
  frametime: number;
}

function stepSlideMove_(ctx: SlideCtx): void {
  const primal = v3(ctx.velocity[0], ctx.velocity[1], ctx.velocity[2]);
  const planes: Vec3[] = [];
  const end = v3();
  const clipped = v3();
  const dir = v3();
  let timeLeft = ctx.frametime;
  const numbumps = 4;

  for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
    end[0] = ctx.origin[0]! + timeLeft * ctx.velocity[0]!;
    end[1] = ctx.origin[1]! + timeLeft * ctx.velocity[1]!;
    end[2] = ctx.origin[2]! + timeLeft * ctx.velocity[2]!;

    const trace = activeTrace(ctx.origin, ctx.mins, ctx.maxs, end);
    if (trace.allsolid) {
      ctx.velocity[2] = 0;
      return;
    }
    if (trace.fraction > 0) {
      ctx.origin[0] = trace.endpos[0]!;
      ctx.origin[1] = trace.endpos[1]!;
      ctx.origin[2] = trace.endpos[2]!;
      planes.length = 0;
    }
    if (trace.fraction === 1) break;

    timeLeft -= timeLeft * trace.fraction;
    if (planes.length >= MAX_CLIP_PLANES) {
      ctx.velocity[0] = 0;
      ctx.velocity[1] = 0;
      ctx.velocity[2] = 0;
      break;
    }
    planes.push(
      v3(trace.planeNormal[0], trace.planeNormal[1], trace.planeNormal[2]),
    );

    let i = 0;
    for (; i < planes.length; i++) {
      PM_ClipVelocity(ctx.velocity, planes[i]!, clipped, 1.01);
      let j = 0;
      for (; j < planes.length; j++) {
        if (j !== i && dot3(clipped, planes[j]!) < 0) break;
      }
      if (j === planes.length) break;
    }
    if (i !== planes.length) {
      ctx.velocity[0] = clipped[0]!;
      ctx.velocity[1] = clipped[1]!;
      ctx.velocity[2] = clipped[2]!;
    } else {
      if (planes.length !== 2) {
        ctx.velocity[0] = 0;
        ctx.velocity[1] = 0;
        ctx.velocity[2] = 0;
        break;
      }
      const a = planes[0]!;
      const b = planes[1]!;
      dir[0] = a[1]! * b[2]! - a[2]! * b[1]!;
      dir[1] = a[2]! * b[0]! - a[0]! * b[2]!;
      dir[2] = a[0]! * b[1]! - a[1]! * b[0]!;
      const d = dot3(dir, ctx.velocity);
      ctx.velocity[0] = dir[0]! * d;
      ctx.velocity[1] = dir[1]! * d;
      ctx.velocity[2] = dir[2]! * d;
    }
    if (dot3(ctx.velocity, primal) <= 0) {
      ctx.velocity[0] = 0;
      ctx.velocity[1] = 0;
      ctx.velocity[2] = 0;
      break;
    }
  }
}

/**
 * id's PM_StepSlideMove: slide, then try stepping up STEPSIZE and sliding
 * above; keep whichever travelled farther in XY.
 */
export function PM_StepSlideMoveFull(
  origin: Vec3,
  velocity: Vec3,
  mins: Vec3,
  maxs: Vec3,
  frametime: number,
): void {
  stepSlideFallback(origin, velocity, mins, maxs, frametime);
}

// Real implementation with explicit start snapshot (kept separate so the
// exported PM_StepSlideMoveFull signature stays (origin, velocity, ...)).
function stepSlideFallback(
  origin: Vec3,
  velocity: Vec3,
  mins: Vec3,
  maxs: Vec3,
  frametime: number,
): void {
  const startO = v3(origin[0], origin[1], origin[2]);
  const startV = v3(velocity[0], velocity[1], velocity[2]);
  const ctx: SlideCtx = { origin, velocity, mins, maxs, frametime };

  stepSlideMove_(ctx);
  const downO = v3(origin[0], origin[1], origin[2]);
  const downV = v3(velocity[0], velocity[1], velocity[2]);

  const up = v3(startO[0], startO[1], startO[2]! + STEPSIZE);
  const upTrace = activeTrace(up, mins, maxs, up);
  if (upTrace.allsolid) return;

  origin[0] = up[0]!;
  origin[1] = up[1]!;
  origin[2] = up[2]!;
  velocity[0] = startV[0]!;
  velocity[1] = startV[1]!;
  velocity[2] = startV[2]!;
  stepSlideMove_(ctx);

  const down = v3(origin[0], origin[1], origin[2]! - STEPSIZE);
  const downTrace = activeTrace(origin, mins, maxs, down);
  if (!downTrace.allsolid) {
    origin[0] = downTrace.endpos[0]!;
    origin[1] = downTrace.endpos[1]!;
    origin[2] = downTrace.endpos[2]!;
  }

  const downDist =
    (downO[0]! - startO[0]!) * (downO[0]! - startO[0]!) +
    (downO[1]! - startO[1]!) * (downO[1]! - startO[1]!);
  const upDist =
    (origin[0]! - startO[0]!) * (origin[0]! - startO[0]!) +
    (origin[1]! - startO[1]!) * (origin[1]! - startO[1]!);

  if (downDist > upDist || downTrace.planeNormal[2]! < MIN_STEP_NORMAL) {
    origin[0] = downO[0]!;
    origin[1] = downO[1]!;
    origin[2] = downO[2]!;
    velocity[0] = downV[0]!;
    velocity[1] = downV[1]!;
    velocity[2] = downV[2]!;
    return;
  }
  velocity[2] = downV[2]!;
}

/** Legacy two-arg wrapper (BRAIN §5 naming): uses the injected world hooks. */
export function PM_StepSlideMove(st: PmoveState, dt: number): void {
  stepSlideFallback(st.origin, st.velocity, st.mins, st.maxs, dt);
}

export function PM_Friction(st: PmoveState, frametime: number): void {
  const vel = st.velocity;
  const speed = Math.sqrt(
    vel[0]! * vel[0]! + vel[1]! * vel[1]! + vel[2]! * vel[2]!,
  );
  if (speed < 1) {
    vel[0] = 0;
    vel[1] = 0;
    return;
  }
  let drop = 0;
  if (st.onGround || st.ladder) {
    const friction = PM_FRICTION;
    const control = speed < PM_STOPSPEED ? PM_STOPSPEED : speed;
    drop += control * friction * frametime;
  }
  if (st.waterlevel > 0 && !st.ladder) {
    drop += speed * PM_WATERFRICTION * st.waterlevel * frametime;
  }
  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;
  newspeed /= speed;
  vel[0] = vel[0]! * newspeed;
  vel[1] = vel[1]! * newspeed;
  vel[2] = vel[2]! * newspeed;
}

export function PM_Accelerate(
  velocity: Vec3,
  wishdir: Vec3,
  wishspeed: number,
  accel: number,
  frametime: number,
): void {
  const currentspeed = dot3(velocity, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = accel * frametime * wishspeed;
  if (accelspeed > addspeed) accelspeed = addspeed;
  velocity[0] = velocity[0]! + accelspeed * wishdir[0]!;
  velocity[1] = velocity[1]! + accelspeed * wishdir[1]!;
  velocity[2] = velocity[2]! + accelspeed * wishdir[2]!;
}

export function PM_AirAccelerate(
  velocity: Vec3,
  wishdir: Vec3,
  wishspeed: number,
  accel: number,
  frametime: number,
): void {
  let wishspd = wishspeed;
  if (wishspd > 30) wishspd = 30;
  const currentspeed = dot3(velocity, wishdir);
  const addspeed = wishspd - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = accel * wishspeed * frametime;
  if (accelspeed > addspeed) accelspeed = addspeed;
  velocity[0] = velocity[0]! + accelspeed * wishdir[0]!;
  velocity[1] = velocity[1]! + accelspeed * wishdir[1]!;
  velocity[2] = velocity[2]! + accelspeed * wishdir[2]!;
}

function angleVectors(angles: Vec3, forward: Vec3, right: Vec3): void {
  const pitch = (angles[0]! * Math.PI) / 180;
  const yaw = (angles[1]! * Math.PI) / 180;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  forward[0] = cp * cy;
  forward[1] = cp * sy;
  forward[2] = -sp;
  // right = yaw-only right (id zeroes pitch for strafe in PM_AirMove paths)
  right[0] = sy;
  right[1] = -cy;
  right[2] = 0;
}

function normalizeInto(v: Vec3): number {
  const len = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!);
  if (len > 0) {
    v[0] = v[0]! / len;
    v[1] = v[1]! / len;
    v[2] = v[2]! / len;
  }
  return len;
}

export function PM_CategorizePosition(st: PmoveState): void {
  const point = v3(st.origin[0], st.origin[1], st.origin[2]! - 0.25);
  if (st.velocity[2]! > 180) {
    st.onGround = false;
    st.groundEntity = -1;
    st.pmFlags &= ~PMF_ON_GROUND;
  } else {
    const trace = activeTrace(st.origin, st.mins, st.maxs, point);
    if (trace.entityNum === -1 || (trace.planeNormal[2]! < 0.7 && !trace.startsolid)) {
      st.groundEntity = -1;
      st.onGround = false;
      st.pmFlags &= ~PMF_ON_GROUND;
    } else {
      st.groundEntity = trace.entityNum;
      if (st.pmFlags & PMF_TIME_WATERJUMP) {
        st.pmFlags &= ~(PMF_TIME_WATERJUMP | PMF_TIME_LAND | PMF_TIME_TELEPORT);
        st.pmTime = 0;
      }
      if (!(st.pmFlags & PMF_ON_GROUND)) {
        st.pmFlags |= PMF_ON_GROUND;
        if (st.velocity[2]! < -200) {
          st.pmFlags |= PMF_TIME_LAND;
          st.pmTime = st.velocity[2]! < -400 ? 25 : 18;
        }
      }
      st.onGround = true;
    }
  }

  // waterlevel from contents at 3 sample heights (duck-aware viewheight)
  st.waterlevel = 0;
  st.watertype = 0;
  const sample2 = st.viewheight - st.mins[2]!;
  const sample1 = sample2 / 2;
  const p = v3(st.origin[0], st.origin[1], st.origin[2]! + st.mins[2]! + 1);
  let cont = activeContents(p);
  if (cont & MASK_WATER) {
    st.watertype = cont;
    st.waterlevel = 1;
    p[2] = st.origin[2]! + st.mins[2]! + sample1;
    cont = activeContents(p);
    if (cont & MASK_WATER) {
      st.waterlevel = 2;
      p[2] = st.origin[2]! + st.mins[2]! + sample2;
      cont = activeContents(p);
      if (cont & MASK_WATER) st.waterlevel = 3;
    }
  }
}

export const BUTTON_DUCK_BIT = 8;

export function PM_CheckDuck(st: PmoveState, cmd: UserCmd): void {
  // C qcommon/pmove.c PM_CheckDuck: duck hold is cmd.upmove < 0 AND on ground
  // (previous tick's PMF_ON_GROUND). Local extension: holding crouch/duck
  // (BUTTON_DUCK bit 8 from @q2/input KeyC) also ducks — the web driver
  // never sends negative upmove. Airborne + hold STANDS (C: the else branch
  // tries to stand when headroom allows) — no self-sustaining DUCKED flag.
  const hold = cmd.upmove < 0 || (cmd.buttons & BUTTON_DUCK_BIT) !== 0;
  const wantDuck = hold && (st.pmFlags & PMF_ON_GROUND) !== 0;
  if (wantDuck) {
    st.pmFlags |= PMF_DUCKED;
  } else if (st.pmFlags & PMF_DUCKED) {
    // Try to stand up: only clear if headroom allows (id traces maxs 32).
    // C clears on !allsolid alone (exact-touch still counts as inside,
    // same as the trace layer reports it).
    const standing = v3(st.maxs[0]!, st.maxs[1]!, 32);
    const trace = activeTrace(st.origin, st.mins, standing, st.origin);
    if (!trace.allsolid) st.pmFlags &= ~PMF_DUCKED;
  }
  if (st.pmFlags & PMF_DUCKED) {
    st.mins[2] = -24;
    st.maxs[2] = 4;
    // C PM_CheckDuck: ducked eye sits 2 units BELOW the origin (feet+22);
    // the +12 guess put the crouched camera inside low ceilings.
    st.viewheight = -2;
  } else {
    st.mins[2] = -24;
    st.maxs[2] = 32;
    st.viewheight = 22;
  }
}

export function PM_CheckJump(st: PmoveState, cmd: UserCmd): void {
  if (st.pmFlags & PMF_TIME_LAND) return;
  if (cmd.upmove < 10) {
    st.pmFlags &= ~PMF_JUMP_HELD;
    return;
  }
  if (st.pmFlags & PMF_JUMP_HELD) return;
  if (st.waterlevel >= 2) {
    st.groundEntity = -1;
    st.onGround = false;
    if (st.velocity[2]! <= -300) return;
    if (st.watertype === CONTENTS_WATER) st.velocity[2] = 100;
    else if (st.watertype === CONTENTS_SLIME) st.velocity[2] = 80;
    else st.velocity[2] = 50;
    return;
  }
  if (st.groundEntity === -1) return;
  st.pmFlags |= PMF_JUMP_HELD;
  st.groundEntity = -1;
  st.onGround = false;
  st.velocity[2] = st.velocity[2]! + PM_JUMP_VELOCITY;
  if (st.velocity[2]! < PM_JUMP_VELOCITY) st.velocity[2] = PM_JUMP_VELOCITY;
}

export function PM_CheckSpecialMovement(st: PmoveState, cmd: UserCmd): void {
  if (st.pmTime) return;
  st.ladder = false;
  const forward = v3();
  const right = v3();
  angleVectors(st.viewAngles, forward, right);
  // flat forward
  const fx = forward[0]!;
  const fy = forward[1]!;
  const fl = Math.sqrt(fx * fx + fy * fy) || 1;
  const spot = v3(st.origin[0]! + fx / fl, st.origin[1]! + fy / fl, st.origin[2]);
  const trace = activeTrace(st.origin, st.mins, st.maxs, spot);
  if (trace.fraction < 1 && trace.contents & CONTENTS_LADDER) st.ladder = true;

  if (st.waterlevel !== 2) return;
  spot[0] = st.origin[0]! + (fx / fl) * 30;
  spot[1] = st.origin[1]! + (fy / fl) * 30;
  spot[2] = st.origin[2]! + 4;
  // C PM_CheckSpecialMovement: the out-of-water vault needs a WALL at
  // feet+4 (`!(cont & CONTENTS_SOLID)` bails). The inverted probe fired
  // the 350u/s vault in open water whenever air sat 16u above the spot.
  if (!(activeContents(spot) & CONTENTS_SOLID)) return;
  spot[2] += 16;
  if (activeContents(spot)) return;
  st.velocity[0] = (fx / fl) * 50;
  st.velocity[1] = (fy / fl) * 50;
  st.velocity[2] = 350;
  st.pmFlags |= PMF_TIME_WATERJUMP;
  st.pmTime = 255;
}

function waterMove(st: PmoveState, cmd: UserCmd, frametime: number): void {
  const forward = v3();
  const right = v3();
  angleVectors(st.viewAngles, forward, right);
  const wishvel = v3(
    forward[0]! * cmd.forwardmove + right[0]! * cmd.sidemove,
    forward[1]! * cmd.forwardmove + right[1]! * cmd.sidemove,
    forward[2]! * cmd.forwardmove + right[2]! * cmd.sidemove,
  );
  if (!cmd.forwardmove && !cmd.sidemove && !cmd.upmove) wishvel[2] = wishvel[2]! - 60;
  else wishvel[2] = wishvel[2]! + cmd.upmove;

  if (st.ladder && Math.abs(st.velocity[2]!) <= 200) applyLadder(st, cmd, wishvel);

  const wishdir = v3(wishvel[0], wishvel[1], wishvel[2]);
  let wishspeed = normalizeInto(wishdir);
  if (wishspeed > PM_MAXSPEED) {
    const s = PM_MAXSPEED / wishspeed;
    wishvel[0] = wishvel[0]! * s;
    wishvel[1] = wishvel[1]! * s;
    wishvel[2] = wishvel[2]! * s;
    wishspeed = PM_MAXSPEED;
  }
  wishspeed *= 0.5;
  PM_Accelerate(st.velocity, wishdir, wishspeed, PM_WATERACCELERATE, frametime);
  stepSlideFallback(st.origin, st.velocity, st.mins, st.maxs, frametime);
}

function applyLadder(st: PmoveState, cmd: UserCmd, wishvel: Vec3): void {
  // qcommon/pmove.c PM_AddCurrents ladder block: looking up/down past 15
  // degrees while holding forward climbs/descends at 200u/s; otherwise
  // move-up/down drives; with neither held the vertical wish zeroes and the
  // body hangs on the rungs (airMove damps residual velocity to zero).
  const pitch = st.viewAngles[0]!;
  if (pitch <= -15 && cmd.forwardmove > 0) wishvel[2] = 200;
  else if (pitch >= 15 && cmd.forwardmove > 0) wishvel[2] = -200;
  else if (cmd.upmove > 0) wishvel[2] = 200;
  else if (cmd.upmove < 0) wishvel[2] = -200;
  else wishvel[2] = 0;
  if (wishvel[0]! < -25) wishvel[0] = -25;
  else if (wishvel[0]! > 25) wishvel[0] = 25;
  if (wishvel[1]! < -25) wishvel[1] = -25;
  else if (wishvel[1]! > 25) wishvel[1] = 25;
}

function airMove(st: PmoveState, cmd: UserCmd, frametime: number): void {
  const forward = v3();
  const right = v3();
  angleVectors(st.viewAngles, forward, right);
  const wishvel = v3(
    forward[0]! * cmd.forwardmove + right[0]! * cmd.sidemove,
    forward[1]! * cmd.forwardmove + right[1]! * cmd.sidemove,
    0,
  );
  if (st.ladder && Math.abs(st.velocity[2]!) <= 200) applyLadder(st, cmd, wishvel);

  const wishdir = v3(wishvel[0], wishvel[1], wishvel[2]);
  let wishspeed = normalizeInto(wishdir);
  const maxspeed = st.pmFlags & PMF_DUCKED ? PM_DUCKSPEED : PM_MAXSPEED;
  if (wishspeed > maxspeed) {
    const s = maxspeed / wishspeed;
    wishvel[0] = wishvel[0]! * s;
    wishvel[1] = wishvel[1]! * s;
    wishvel[2] = wishvel[2]! * s;
    wishspeed = maxspeed;
  }

  if (st.ladder) {
    PM_Accelerate(st.velocity, wishdir, wishspeed, PM_ACCELERATE, frametime);
    if (!wishvel[2]!) {
      if (st.velocity[2]! > 0) {
        st.velocity[2] = st.velocity[2]! - st.gravity * frametime;
        if (st.velocity[2]! < 0) st.velocity[2] = 0;
      } else {
        st.velocity[2] = st.velocity[2]! + st.gravity * frametime;
        if (st.velocity[2]! > 0) st.velocity[2] = 0;
      }
    }
    stepSlideFallback(st.origin, st.velocity, st.mins, st.maxs, frametime);
  } else if (st.onGround) {
    st.velocity[2] = 0;
    PM_Accelerate(st.velocity, wishdir, wishspeed, PM_ACCELERATE, frametime);
    if (st.gravity > 0) st.velocity[2] = 0;
    else st.velocity[2] = st.velocity[2]! - st.gravity * frametime;
    if (!st.velocity[0]! && !st.velocity[1]!) return;
    stepSlideFallback(st.origin, st.velocity, st.mins, st.maxs, frametime);
  } else {
    if (PM_AIRACCELERATE) PM_AirAccelerate(st.velocity, wishdir, wishspeed, PM_ACCELERATE, frametime);
    else PM_Accelerate(st.velocity, wishdir, wishspeed, 1, frametime);
    st.velocity[2] = st.velocity[2]! - st.gravity * frametime;
    stepSlideFallback(st.origin, st.velocity, st.mins, st.maxs, frametime);
  }
}

/**
 * Full player-move step for one usercmd. dt derives ONLY from cmd.msec
 * (clamped to [1,200]ms, exactly as Pmove() does) — never wall-clock.
 */
export function pmoveFull(st: PmoveState, cmd: UserCmd): void {
  let msec = Math.trunc(cmd.msec);
  if (msec < 1) msec = 1;
  if (msec > 200) msec = 200;
  const frametime = msec / 1000;

  st.viewAngles[0] = cmd.angles[0]!;
  st.viewAngles[1] = cmd.angles[1]!;
  st.viewAngles[2] = cmd.angles[2]!;

  PM_CheckDuck(st, cmd);
  PM_CheckSpecialMovement(st, cmd);
  PM_CategorizePosition(st);
  if (st.pmTime > 0) {
    // Drop timing counter. C Pmove consumes msec>>3 slices (min 1) — ours
    // consumes the full tick, so land/vault windows run shorter, but the
    // flag hygiene is C-exact: expiry clears WATERJUMP/LAND/TELEPORT,
    // otherwise the landing lockout latches forever and CheckJump can never
    // fire again. The land/teleport raw-slide path below is the legacy
    // dry-land behaviour (kept bit-identical), while TIME_WATERJUMP runs
    // C's vault branch: gravity, cancel as soon as falling, then step.
    st.pmTime -= msec;
    if (st.pmTime <= 0) {
      st.pmTime = 0;
      st.pmFlags &= ~(PMF_TIME_WATERJUMP | PMF_TIME_LAND | PMF_TIME_TELEPORT);
    }
    if (st.pmFlags & PMF_TIME_WATERJUMP) {
      st.velocity[2] = st.velocity[2]! - st.gravity * frametime;
      if (st.velocity[2]! < 0) {
        st.pmFlags &= ~(PMF_TIME_WATERJUMP | PMF_TIME_LAND | PMF_TIME_TELEPORT);
        st.pmTime = 0;
      }
    }
    stepSlideFallback(st.origin, st.velocity, st.mins, st.maxs, frametime);
    PM_CategorizePosition(st);
    return;
  }
  PM_CheckJump(st, cmd);
  PM_Friction(st, frametime);
  if (st.waterlevel >= 2) waterMove(st, cmd, frametime);
  else airMove(st, cmd, frametime);
  PM_CategorizePosition(st);
}

/** Legacy single-step entry (BRAIN §5 naming): mutates and returns st. */
export function pmove(st: PmoveState, cmd: UserCmd): PmoveState {
  pmoveFull(st, cmd);
  return st;
}
