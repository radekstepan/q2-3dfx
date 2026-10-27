// @q2/client/prediction — client-side prediction + interpolation (M6.1).
//
// The server ticks at 10Hz (BRAIN.md §5). The client renders uncapped:
// remote entities are lerped between the last two snapshots, and the local
// player is predicted forward from the newest snapshot so input feels
// immediate. All math is pure (headless-testable); time is seconds.
//
// Local-player prediction replays the owned (unacked) usercmd stream through
// the real headless pmove step from @q2/game (`pmoveFull`, the same code path
// the server runs: `PM_StepSlideMove`, accel, friction, gravity). `dt` comes
// ONLY from `cmd.msec` — never wall-clock (`level.time` semantics). When
// `cl_predict` is 0, or no owned cmds are supplied, prediction falls back to
// the legacy constant-velocity extrapolation so the two modes can be A/B'd.
// Interpolation of remote entities is untouched by the pmove hookup.

import { getCVarNumber, SERVER_DT } from '@q2/config';
import { makePmoveState, pmoveFull, PMF_ON_GROUND } from '@q2/game';

export type Origin3 = [number, number, number];

export interface EntityState {
  id: number;
  origin: Origin3;
  velocity: Origin3;
  angles?: Origin3;
  /** Authoritative pm_flags at snapshot time (PMF_DUCKED etc.); seeds replay. */
  pmFlags?: number;
  /** True when the entity was on the ground (seeds groundEntity for duck). */
  grounded?: boolean;
}

/** One 10Hz server sample. */
export interface Snapshot {
  serverTime: number;
  entities: EntityState[];
}

/** Owned input cmd to replay through pmove (headless `usercmd_t` subset). */
export interface PredictCmd {
  /** command duration in ms; ONLY source of dt (id clamps 1..200ms) */
  msec: number;
  /** view angles [pitch, yaw, roll] in degrees */
  angles: Origin3;
  forwardmove: number;
  sidemove: number;
  upmove: number;
  /** bitmask: 1=attack, 2=use, 4=jump ... */
  buttons: number;
}

/** Inputs-equal ignoring per-cmd msec (chunking is a delivery artifact). */
function sameInputs(a: PredictCmd, b: PredictCmd): boolean {
  return (
    a.forwardmove === b.forwardmove && a.sidemove === b.sidemove &&
    a.upmove === b.upmove && a.buttons === b.buttons &&
    a.angles[0] === b.angles[0] && a.angles[1] === b.angles[1] && a.angles[2] === b.angles[2]
  );
}
/** Constant-velocity extrapolation: origin + velocity * dt. */
export function extrapolateOrigin(origin: Origin3, velocity: Origin3, dt: number): Origin3 {
  return [origin[0] + velocity[0] * dt, origin[1] + velocity[1] * dt, origin[2] + velocity[2] * dt];
}

/** Lerp helper shared by prediction smoothing and interpolation. */
export function lerpOrigin(a: Origin3, b: Origin3, f: number): Origin3 {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Clamp helper. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Interpolation fraction for `renderTime` between two snapshots.
 * Degenerate (equal timestamps) yields 0. Result is clamped 0..1 so
 * render times outside the window hold the nearest sample (no jitter,
 * no extrapolation of remote entities).
 */
export function interpFraction(prevTime: number, nextTime: number, renderTime: number): number {
  if (!(nextTime > prevTime)) return 0;
  return clamp01((renderTime - prevTime) / (nextTime - prevTime));
}

/** Render time for a snapshot stream: newest server time minus delay. */
export function renderTimeFor(newestServerTime: number, delay = 0.1): number {
  return newestServerTime - delay;
}

export interface InterpolatedEntity {
  id: number;
  origin: Origin3;
}

/**
 * `CL_Interpolate`: lerp every entity present in both snapshots.
 * Entities missing from one side are held at the available sample.
 */
export function CL_Interpolate(prev: Snapshot, next: Snapshot, renderTime: number): InterpolatedEntity[] {
  const f = interpFraction(prev.serverTime, next.serverTime, renderTime);
  const bById = new Map<number, EntityState>();
  for (const e of next.entities) bById.set(e.id, e);
  const out: InterpolatedEntity[] = [];
  const seen = new Set<number>();
  for (const a of prev.entities) {
    const b = bById.get(a.id);
    seen.add(a.id);
    out.push({ id: a.id, origin: b ? lerpOrigin(a.origin, b.origin, f) : [...a.origin] as Origin3 });
  }
  for (const b of next.entities) {
    if (!seen.has(b.id)) out.push({ id: b.id, origin: [...b.origin] as Origin3 });
  }
  out.sort((x, y) => x.id - y.id);
  return out;
}

/**
 * `CL_PredictPmove`: replay the owned cmd stream through the real headless
 * pmove step (`pmoveFull` from @q2/game — same `PM_StepSlideMove` code path
 * as the server, same injected world trace hooks). Returns the predicted
 * origin, or null for unknown ids / empty streams.
 *
 * `horizonMs` bounds how much of the stream is replayed (default: all of
 * it). `CL_Predict` uses this for past-the-tick catch-up replays; inside the
 * current tick it instead replays a single `SERVER_DT` step with the latest
 * staged cmd (the server-exact tick end — see `CL_Predict`), so a render
 * exactly on a tick returns the snapshot origin exactly and the
 * end-of-interval render replays exactly one 100ms server step. Replaying
 * the whole staged stream regardless of render time (the old behaviour) runs
 * a full frame ahead of the snapshot at tick instants and snaps back when
 * the next snapshot lands — the stop jitter. Runs of identical inputs are
 * still coalesced (msec is a delivery artifact), with the final run
 * truncated to the horizon instead of overshooting it.
 */
export function CL_PredictPmove(
  base: Snapshot,
  localId: number,
  cmds: PredictCmd[],
  horizonMs = Number.POSITIVE_INFINITY,
): Origin3 | null {
  const ent = base.entities.find((e) => e.id === localId);
  if (!ent || cmds.length === 0) return null;
  if (!(horizonMs > 0)) return [...ent.origin] as Origin3;
  const st = makePmoveState();
  st.origin[0] = ent.origin[0];
  st.origin[1] = ent.origin[1];
  st.origin[2] = ent.origin[2];
  st.velocity[0] = ent.velocity[0];
  st.velocity[1] = ent.velocity[1];
  st.velocity[2] = ent.velocity[2];
  // Seed physics state, not just kinematics: the first replayed step runs
  // PM_CheckDuck before PM_CategorizePosition, so a crouched snapshot must
  // carry DUCKED + grounded-ness or the replay stands up for one step and
  // the predicted hull diverges from the authoritative one while ducked.
  // Fields are optional (devroom/legacy snapshots omit them) — only apply
  // when present so default replay behavior is unchanged.
  if (ent.pmFlags !== undefined) st.pmFlags = ent.pmFlags;
  if (ent.grounded !== undefined) {
    st.groundEntity = ent.grounded ? 0 : -1;
    if (ent.grounded) st.pmFlags |= PMF_ON_GROUND;
    else st.pmFlags &= ~PMF_ON_GROUND;
  }
  if (ent.angles) {
    st.viewAngles[0] = ent.angles[0];
    st.viewAngles[1] = ent.angles[1];
    st.viewAngles[2] = ent.angles[2];
  }
  // Zero-velocity snap: mirrors PM_Friction's speed<1 zeroing. A settled
  // server snapshot carries ~zero velocity, but the stale sample can hold a
  // small residual (speed<1) that constant-velocity extrapolation — or an
  // airborne gravity step in the replay — would sweep forward until the next
  // tick snaps it back (the stop rubber-band). When every staged input
  // inside the horizon is movement-zero the server's next step holds still
  // too, so return the snapshot origin exactly instead of integrating
  // residue. Buttons (e.g. attack, duck) do not move the player, so only
  // forward/side/up are checked.
  //
  // The check runs over the horizon-trimmed prefix only: inputs outside the
  // horizon have not happened yet at this render time and must not un-snap
  // a settled render.
  let remaining = horizonMs;
  const runs: Array<{ rep: PredictCmd; take: number }> = [];
  {
    let runStart = 0;
    for (let i = 1; i <= cmds.length; i++) {
      if (i < cmds.length && sameInputs(cmds[i]!, cmds[runStart]!)) continue;
      const rep = cmds[runStart]!;
      let total = 0;
      for (let j = runStart; j < i; j++) total += cmds[j]!.msec;
      if (remaining <= 0) break;
      const take = Math.min(total, remaining);
      remaining -= take;
      runs.push({ rep, take });
      runStart = i;
    }
  }
  let allZeroMove = true;
  for (const { rep } of runs) {
    if (rep.forwardmove !== 0 || rep.sidemove !== 0 || rep.upmove !== 0) {
      allZeroMove = false;
      break;
    }
  }
  const snapSpeed = Math.sqrt(
    ent.velocity[0] * ent.velocity[0] +
    ent.velocity[1] * ent.velocity[1] +
    ent.velocity[2] * ent.velocity[2],
  );
  if (snapSpeed < 1 && allZeroMove) return [...ent.origin] as Origin3;
  // Friction-exact run coalescing: the server integrates ONE 100ms pmove
  // step per tick while the predictor replays N ~16ms frame cmds, and rAF
  // delivers those slices with 16/17ms jitter. PM_Friction is nonlinear in
  // frametime ((1-k*dt)^N != 1-k*N*dt), so per-cmd replay diverges from the
  // tick it predicts — after stopping, the replayed origin overshoots then
  // snaps back each tick (the stop jitter). Group consecutive runs of
  // identical inputs (msec is a delivery artifact, not input) and replay
  // each run as ONE step with the summed msec (clamped 1..200, exactly as
  // Pmove does), restoring the server's chunking: a jittered run summing
  // to 100ms replays bit-identically to the server's single 100ms step,
  // and a mixed stream (held move + release frame) replays as two steps.
  for (const { rep, take } of runs) {
    const total = Math.max(1, Math.min(200, Math.round(take)));
    pmoveFull(st, {
      msec: total,
      angles: new Float32Array(rep.angles),
      forwardmove: rep.forwardmove,
      sidemove: rep.sidemove,
      upmove: rep.upmove,
      buttons: rep.buttons,
    });
  }
  return [st.origin[0]!, st.origin[1]!, st.origin[2]!];
}

/**
 * `CL_Predict`: predict the local player from the newest snapshot.
 *
 * When owned cmds are supplied AND `cl_predict` is nonzero, the render
 * blends linearly from the snapshot origin toward the server-exact tick end
 * by the sub-tick debt `dt / SERVER_DT`, clamped 0..1. `dt <= 0` returns the
 * snapshot origin exactly, so tick-aligned renders never lead the server and
 * never snap back; the end-of-interval render equals the tick target, so
 * constant streams land bit-identically on the next snapshot.
 *
 * The tick end is ONE `SERVER_DT` pmove step run with the latest staged cmd
 * — exactly what the closing server tick will run (the host ticks with the
 * current frame's cmd, so mid-interval history never reaches the server).
 * Replaying the staged prefix instead overshoots the full friction step it
 * prefixes (ground friction decay is front-loaded in a single pmove step —
 * shorter dt keeps more velocity, so a partial step travels farther than the
 * whole tick), which read as a forward pop + snap-back every tick while
 * stopping. The linear blend to the tick end is monotonic by construction.
 * Past the current tick (`dt > SERVER_DT`, catch-up/tests only — production
 * render debt is always sub-tick) the whole staged stream is replayed
 * friction-exactly as before. Otherwise (no cmds, `cl_predict` 0, or unknown
 * id) it falls back to constant-velocity extrapolation
 * `origin + velocity * dt` (legacy A/B baseline). Returns null only for
 * unknown ids.
 */
export function CL_Predict(newest: Snapshot, localId: number, dt: number, cmds?: PredictCmd[]): Origin3 | null {
  const ent = newest.entities.find((e) => e.id === localId);
  if (!ent) return null;
  if (cmds && cmds.length > 0 && getCVarNumber('cl_predict') !== 0) {
    const horizonMs = Math.max(0, dt * 1000);
    if (!(horizonMs > 0)) return [...ent.origin] as Origin3;
    const tickMs = SERVER_DT * 1000;
    if (horizonMs <= tickMs) {
      // Inside the current tick interval: blend snapshot -> server-exact
      // tick end (latest staged cmd held for the whole 100ms quantum).
      const last = cmds[cmds.length - 1]!;
      const end = CL_PredictPmove(newest, localId, [{ ...last, msec: tickMs }]);
      if (end) return lerpOrigin(ent.origin, end, clamp01(horizonMs / tickMs));
    } else {
      // Past the current tick: replay the whole staged stream (multi-step,
      // friction-exact) and hold the end target past the staged duration.
      let total = 0;
      for (const c of cmds) total += c.msec;
      const end = CL_PredictPmove(newest, localId, cmds, total);
      if (end) {
        if (!(total > 0)) return end;
        return lerpOrigin(ent.origin, end, clamp01(horizonMs / total));
      }
    }
  }
  return extrapolateOrigin(ent.origin, ent.velocity, dt);
}

/** Stateful helper used by Host: keeps the last two snapshots. */
export class Predictor {
  prev: Snapshot | null = null;
  next: Snapshot | null = null;
  interpDelay = 0.1;
  /** Owned (unacked) cmds to replay through pmove for the local player. */
  private pendingCmds: PredictCmd[] = [];

  /** Stage the owned cmd stream since the newest acked snapshot. */
  setPendingCmds(cmds: PredictCmd[]): void {
    this.pendingCmds = [...cmds];
  }

  /** Drop the staged owned cmds (e.g. on snapshot ack / teleport). */
  clearPendingCmds(): void {
    this.pendingCmds = [];
  }

  pushSnapshot(snap: Snapshot): void {
    if (this.next && snap.serverTime < this.next.serverTime) return; // out of order
    this.prev = this.next;
    this.next = snap;
  }

  /** Entities to render at `now` (server-time domain). */
  renderEntities(now: number, localId: number): InterpolatedEntity[] {
    if (!this.next) return [];
    if (!this.prev) {
      return this.next.entities.map((e) => ({ id: e.id, origin: [...e.origin] as Origin3 }));
    }
    const renderTime = now - this.interpDelay;
    const ents = CL_Interpolate(this.prev, this.next, renderTime);
    // Override the local player with the prediction (no interp lag on self).
    if (this.next) {
      const dt = Math.max(0, now - this.next.serverTime);
      const predicted =
        this.pendingCmds.length > 0
          ? CL_Predict(this.next, localId, dt, this.pendingCmds)
          : CL_Predict(this.next, localId, dt);
      if (predicted) {
        const slot = ents.find((e) => e.id === localId);
        if (slot) slot.origin = predicted;
        else ents.push({ id: localId, origin: predicted });
      }
    }
    return ents;
  }
}
