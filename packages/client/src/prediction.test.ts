import { describe, expect, it } from 'vitest';
import { setCVar } from '@q2/config';
import { PMF_DUCKED, PMF_ON_GROUND, makePmoveState, pmove, resetPmoveWorld, setPmoveWorld } from '@q2/game';
import type { TraceFn, UserCmd } from '@q2/game';
import {
  CL_Interpolate,
  CL_Predict,
  CL_PredictPmove,
  extrapolateOrigin,
  interpFraction,
  lerpAngle,
  lerpOrigin,
  Predictor,
} from './prediction.js';
import type { PredictCmd, Snapshot } from './prediction.js';

const snap = (t: number, x: number): Snapshot => ({
  serverTime: t,
  entities: [{ id: 1, origin: [x, 0, 0], velocity: [10, 0, 0] }],
});

describe('interp math (10Hz samples -> smooth render origins)', () => {
  it('midpoints lerp exactly', () => {
    expect(lerpOrigin([0, 0, 0], [10, 0, 0], 0.5)).toEqual([5, 0, 0]);
  });

  it('fraction clamps outside the window (hold nearest, no jitter)', () => {
    expect(interpFraction(0, 0.1, -1)).toBe(0);
    expect(interpFraction(0, 0.1, 99)).toBe(1);
    expect(interpFraction(0.1, 0.1, 0.1)).toBe(0);
  });

  it('CL_Interpolate lerps entities present in both snapshots', () => {
    const out = CL_Interpolate(snap(0, 0), snap(0.1, 10), 0.05);
    expect(out).toHaveLength(1);
    expect(out[0]!.origin[0]).toBeCloseTo(5, 9);
  });

  it('CL_Interpolate holds entities missing from one side', () => {
    const prev: Snapshot = { serverTime: 0, entities: [{ id: 7, origin: [3, 0, 0], velocity: [0, 0, 0] }] };
    const next: Snapshot = { serverTime: 0.1, entities: [] };
    expect(CL_Interpolate(prev, next, 0.05)[0]!.origin).toEqual([3, 0, 0]);
    const back = CL_Interpolate(next, prev, 0.05);
    expect(back[0]!.origin).toEqual([3, 0, 0]);
  });

  it('CL_Predict extrapolates the local player forward', () => {
    const predicted = CL_Predict(snap(1.0, 100), 1, 0.05);
    expect(predicted![0]).toBeCloseTo(100.5, 9);
  });

  it('CL_Predict returns null for unknown ids', () => {
    expect(CL_Predict(snap(1.0, 0), 999, 0.05)).toBeNull();
  });

  it('extrapolateOrigin integrates velocity', () => {
    expect(extrapolateOrigin([1, 2, 3], [10, 0, -5], 0.1)).toEqual([2, 2, 2.5]);
  });

  it('Predictor renders lerped remotes + predicted local without jitter', () => {
    const p = new Predictor();
    p.pushSnapshot(snap(0, 0));
    p.pushSnapshot(snap(0.1, 10));
    // Server time at newest + half tick; interp delay 0.1 -> renderTime 0.05.
    const ents = p.renderEntities(0.1, 1);
    expect(ents).toHaveLength(1);
    // Local player is predicted from newest (dt=0 -> newest origin).
    expect(ents[0]!.origin[0]).toBeCloseTo(10, 9);
    // A remote entity would sit at the lerp midpoint instead:
    const remote = CL_Interpolate(snap(0, 0), snap(0.1, 10), 0.05);
    expect(remote[0]!.origin[0]).toBeCloseTo(5, 9);
  });

  it('Predictor ignores out-of-order snapshots', () => {
    const p = new Predictor();
    p.pushSnapshot(snap(0.1, 10));
    p.pushSnapshot(snap(0, 0));
    expect(p.next!.serverTime).toBe(0.1);
  });
});

describe('pmove prediction (TODO(M6.1) hookup)', () => {
  /** Deterministic recorded cmd stream: run, strafe, jump, variable msec. */
  const recordedCmds = (): PredictCmd[] => {
    const cmds: PredictCmd[] = [];
    let yaw = 0;
    for (let i = 0; i < 120; i++) {
      yaw += 1.5;
      cmds.push({
        msec: 8 + ((i * 37) % 25), // 8..32ms, dt from msec only (level.time semantics)
        angles: [0, yaw % 360, 0],
        forwardmove: i % 3 === 0 ? 0 : 400,
        sidemove: i % 4 === 0 ? 200 : 0,
        upmove: i === 10 || i === 60 ? 200 : 0, // two jumps
        buttons: 0,
      });
    }
    return cmds;
  };

  it('predicted origins match server pmove for a recorded cmd stream', () => {
    resetPmoveWorld(); // empty world: same default trace hooks both sides
    setCVar('cl_predict', 1);
    try {
      const cmds = recordedCmds();
      // "Server": authoritative pmove from the snapshot state.
      const server = makePmoveState();
      for (const c of cmds) {
        pmove(server, {
          msec: c.msec,
          angles: new Float32Array(c.angles),
          forwardmove: c.forwardmove,
          sidemove: c.sidemove,
          upmove: c.upmove,
          buttons: c.buttons,
        });
      }
      const base: Snapshot = {
        serverTime: 1.0,
        entities: [{ id: 1, origin: [0, 0, 0], velocity: [0, 0, 0] }],
      };
      const predicted = CL_Predict(base, 1, 999, cmds);
      expect(predicted).not.toBeNull();
      // Exact float equality: both sides copy the same Float32 pmove state.
      expect(predicted).toEqual([server.origin[0], server.origin[1], server.origin[2]]);
      // And it must have actually moved (not a vacuous pass).
      expect(Math.abs(predicted![0]) + Math.abs(predicted![1])).toBeGreaterThan(0);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });

  it('cl_predict 0 falls back to constant velocity (A/B baseline)', () => {
    resetPmoveWorld();
    setCVar('cl_predict', 0);
    try {
      const base: Snapshot = {
        serverTime: 1.0,
        entities: [{ id: 1, origin: [100, 0, 0], velocity: [10, 0, 0] }],
      };
      const cmds = recordedCmds();
      // Gate off: identical call must equal legacy extrapolation...
      const gated = CL_Predict(base, 1, 0.05, cmds);
      expect(gated).toEqual(extrapolateOrigin(base.entities[0]!.origin, base.entities[0]!.velocity, 0.05));
      // ...and differ from the real pmove result (accel/friction apply).
      setCVar('cl_predict', 1);
      const moved = CL_Predict(base, 1, 0.05, cmds);
      expect(moved).not.toEqual(gated);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });

  it('Predictor replays pending cmds and keeps interpolation of remotes', () => {
    resetPmoveWorld();
    setCVar('cl_predict', 1);
    try {
      const p = new Predictor();
      p.pushSnapshot({ serverTime: 0, entities: [{ id: 1, origin: [0, 0, 0], velocity: [0, 0, 0] }] });
      p.pushSnapshot({ serverTime: 0.1, entities: [{ id: 1, origin: [0, 0, 0], velocity: [0, 0, 0] }] });
      const cmds = recordedCmds();
      p.setPendingCmds(cmds);
      // The staged stream covers sum(msec) of sim time past the newest
      // snapshot: render there (horizon = whole stream) to replay it fully.
      const totalSecs = cmds.reduce((s, c) => s + c.msec, 0) / 1000;
      const ents = p.renderEntities(0.1 + totalSecs, 1);
      // Server reference for the same stream.
      const server = makePmoveState();
      for (const c of cmds) {
        pmove(server, {
          msec: c.msec,
          angles: new Float32Array(c.angles),
          forwardmove: c.forwardmove,
          sidemove: c.sidemove,
          upmove: c.upmove,
          buttons: c.buttons,
        });
      }
      expect(ents[0]!.origin).toEqual([server.origin[0], server.origin[1], server.origin[2]]);
      // Clearing the queue restores legacy constant-velocity (dt=0 -> snapshot origin).
      p.clearPendingCmds();
      const held = p.renderEntities(0.1, 1);
      expect(held[0]!.origin).toEqual([0, 0, 0]);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });

  it('msec-tolerant run coalescing matches the server tick exactly (rAF jitter + release)', () => {
    resetPmoveWorld();
    setCVar('cl_predict', 1);
    try {
      const base: Snapshot = {
        serverTime: 1.0,
        entities: [{ id: 1, origin: [0, 0, 0], velocity: [0, 0, 0] }],
      };
      const fwd = (msec: number): PredictCmd => ({
        msec,
        angles: [0, 90, 0],
        forwardmove: 400,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      });
      // Six jittered rAF slices summing to exactly 100ms predict exactly the
      // server's single 100ms step (msec split is a delivery artifact).
      const jittered = [16, 17, 16, 17, 17, 17].map(fwd);
      const predicted = CL_PredictPmove(base, 1, jittered);
      const server = makePmoveState();
      pmove(server, {
        msec: 100,
        angles: new Float32Array([0, 90, 0]),
        forwardmove: 400,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      });
      expect(predicted).toEqual([server.origin[0], server.origin[1], server.origin[2]]);
      // Held move + release frame replays as two summed runs, exactly the
      // chunked reference (per-cmd friction would diverge instead).
      const zero = (msec: number): PredictCmd => ({
        msec,
        angles: [0, 90, 0],
        forwardmove: 0,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      });
      const mixed = [...[16, 17, 16, 17, 16].map(fwd), zero(18)];
      const mixedPred = CL_PredictPmove(base, 1, mixed);
      const ref = makePmoveState();
      pmove(ref, {
        msec: 82,
        angles: new Float32Array([0, 90, 0]),
        forwardmove: 400,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      });
      pmove(ref, {
        msec: 18,
        angles: new Float32Array([0, 90, 0]),
        forwardmove: 0,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      });
      expect(mixedPred).toEqual([ref.origin[0], ref.origin[1], ref.origin[2]]);
      // And the two-step run replay genuinely differs from naive per-cmd
      // replay (friction is nonlinear in frametime), so the merge matters.
      const naive = makePmoveState();
      for (const c of mixed) {
        pmove(naive, {
          msec: c.msec,
          angles: new Float32Array(c.angles),
          forwardmove: c.forwardmove,
          sidemove: c.sidemove,
          upmove: c.upmove,
          buttons: c.buttons,
        });
      }
      expect([naive.origin[0], naive.origin[1], naive.origin[2]]).not.toEqual(mixedPred);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });

  it('zero-velocity snap holds the snapshot origin on all-zero inputs', () => {
    resetPmoveWorld();
    setCVar('cl_predict', 1);
    try {
      // Residual velocity below PM_Friction's speed<1 zeroing threshold with
      // released inputs: the replay must not sweep forward (or sink via an
      // airborne gravity step) — it holds the snapshot origin exactly.
      const base: Snapshot = {
        serverTime: 1.0,
        entities: [{ id: 1, origin: [100, 5, -24], velocity: [0.5, 0, 0] }],
      };
      const zeros: PredictCmd[] = [16, 17, 16, 17].map((msec) => ({
        msec,
        angles: [0, 0, 0] as [number, number, number],
        forwardmove: 0,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      }));
      expect(CL_PredictPmove(base, 1, zeros)).toEqual([100, 5, -24]);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });

  it('CL_PredictPmove returns null for unknown ids / empty streams', () => {
    expect(CL_PredictPmove(snap(1.0, 0), 999, recordedCmds())).toBeNull();
    expect(CL_PredictPmove(snap(1.0, 0), 1, [])).toBeNull();
  });

  it('tick-aligned render replays nothing (horizon 0 == snapshot origin)', () => {
    resetPmoveWorld();
    setCVar('cl_predict', 1);
    try {
      const base: Snapshot = {
        serverTime: 1.0,
        entities: [{ id: 1, origin: [50, 0, 0], velocity: [300, 0, 0] }],
      };
      const cmds: PredictCmd[] = [16, 17, 16].map((msec) => ({
        msec,
        angles: [0, 0, 0] as [number, number, number],
        forwardmove: 400,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      }));
      // The old horizon-ignorant replay ran a full frame ahead here; now
      // the render debt is zero so the prediction is the snapshot exactly.
      expect(CL_Predict(base, 1, 0, cmds)).toEqual([50, 0, 0]);
      expect(CL_PredictPmove(base, 1, cmds, 0)).toEqual([50, 0, 0]);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });
});

describe('stop settle (10Hz server, sub-tick renders)', () => {
  /** Flat floor at feet z = 0 (world entity 0), as in pmove.test.ts. */
  const floorTrace: TraceFn = (start, mins, _maxs, end) => {
    const sb = start[2]! + mins[2]!;
    const eb = end[2]! + mins[2]!;
    if (eb < sb && eb <= 0) {
      const f = sb === eb ? 0 : Math.min(1, Math.max(0, sb / (sb - eb)));
      return {
        fraction: f,
        endpos: new Float32Array([
          start[0]! + (end[0]! - start[0]!) * f,
          start[1]! + (end[1]! - start[1]!) * f,
          start[2]! + (end[2]! - start[2]!) * f,
        ]),
        planeNormal: new Float32Array([0, 0, 1]),
        allsolid: false,
        startsolid: false,
        entityNum: 0,
        contents: 0,
      };
    }
    return {
      fraction: 1,
      endpos: new Float32Array(end),
      planeNormal: new Float32Array([0, 0, 1]),
      allsolid: false,
      startsolid: false,
      entityNum: -1,
      contents: 0,
    };
  };

  const ANGLES: [number, number, number] = [0, 0, 0];
  const zeroSegs = (ms: number[]): PredictCmd[] =>
    ms.map((msec) => ({ msec, angles: [...ANGLES] as [number, number, number], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }));

  /**
   * Drive a headless pmove "server" at 10Hz: 1s of full forward run, then
   * `releaseTicks` zero-input ticks. Render the Predictor at sub-tick
   * offsets through every release interval and return all rendered x (plus
   * the per-tick snapshots). `duck` holds BUTTON_DUCK in the staged cmds;
   * the server holds the crouch via the real PM_CheckDuck path (buttons bit
   * + ON_GROUND, no external flag forcing).
   */
  function settleRun(releaseTicks: number, duck: boolean): { xs: number[]; snaps: number[] } {
    setPmoveWorld(floorTrace);
    const server = makePmoveState();
    server.origin[0] = 0;
    server.origin[1] = 0;
    server.origin[2] = 24; // feet resting on the floor
    const ucmd = (msec: number, fwd: number, buttons: number): UserCmd => ({
      msec,
      angles: new Float32Array(ANGLES) as UserCmd['angles'],
      forwardmove: fwd,
      sidemove: 0,
      upmove: 0,
      buttons,
    });
    // Run phase: 10 ticks at full forward speed.
    let time = 0;
    for (let t = 0; t < 10; t++) {
      pmove(server, ucmd(100, 400, duck ? 8 : 0));
      time += 0.1;
    }
    const takeSnap = (): Snapshot => ({
      serverTime: time,
      entities: [
        {
          id: 1,
          origin: [server.origin[0]!, server.origin[1]!, server.origin[2]!] as [number, number, number],
          velocity: [server.velocity[0]!, server.velocity[1]!, server.velocity[2]!] as [number, number, number],
          // Authoritative physics state seeds the replay (Phase 3): ducked
          // snapshots must replay ducked or prediction diverges from server.
          pmFlags: server.pmFlags,
          grounded: server.groundEntity !== -1,
        },
      ],
    });
    const p = new Predictor();
    let prev = takeSnap();
    p.pushSnapshot(prev);
    const segs = [16, 17, 16, 17, 17, 17]; // one jittered 100ms tick
    const staged = zeroSegs(segs).map((c) => ({ ...c, buttons: duck ? 8 : 0 }));
    const xs: number[] = [];
    const snaps: number[] = [server.origin[0]!];
    // Release phase: zero inputs, sub-tick renders, tick-exact snapshots.
    for (let k = 0; k < releaseTicks; k++) {
      p.setPendingCmds(staged);
      let elapsed = 0;
      for (const ms of segs) {
        const ents = p.renderEntities(time + elapsed / 1000, 1);
        xs.push(ents.find((e) => e.id === 1)!.origin[0]);
        elapsed += ms;
      }
      pmove(server, ucmd(100, 0, duck ? 8 : 0));
      time += 0.1;
      const s = takeSnap();
      // Friction-exact vs the 100ms server tick: replaying the staged 100ms
      // from the interval's start snapshot lands bit-identically on the
      // authoritative tick.
      expect(CL_PredictPmove(prev, 1, staged)).toEqual([
        s.entities[0]!.origin[0],
        s.entities[0]!.origin[1],
        s.entities[0]!.origin[2],
      ]);
      p.pushSnapshot(s);
      prev = s;
      // Tick-aligned render: the replayed 100ms must land exactly on the
      // authoritative tick (friction-exact, bit-identical).
      const at = p.renderEntities(time, 1).find((e) => e.id === 1)!.origin[0];
      xs.push(at);
      snaps.push(s.entities[0]!.origin[0]);
      expect(at).toBe(s.entities[0]!.origin[0]);
    }
    return { xs, snaps };
  }

  it('constant-velocity stop settles monotonically, no oscillation/snap-back', () => {
    resetPmoveWorld();
    setCVar('cl_predict', 1);
    try {
      const { xs, snaps } = settleRun(8, false);
      // It actually moved, then every sub-tick render advanced forward or
      // held — never backwards (no oscillation, no snap-back).
      expect(snaps[snaps.length - 1]! - snaps[0]!).toBeGreaterThan(0);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
      }
      // No overshoot past the upcoming tick: each render sits inside the
      // current 100ms interval (prefix of the same friction step).
      expect(Math.max(...xs)).toBeLessThanOrEqual(snaps[snaps.length - 1]! + 1e-9);
      // Settled: the tail holds still (friction zeroed the velocity, the
      // zero-velocity snap pins the origin).
      const tail = xs.slice(-7);
      for (const x of tail) expect(x).toBe(snaps[snaps.length - 1]!);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });

  it('ducked stop settles monotonically with the ducked hull (lower maxs)', () => {
    resetPmoveWorld();
    setCVar('cl_predict', 1);
    try {
      // C PM_CheckDuck: hold (BUTTON_DUCK bit 8 / upmove<0) + ON_GROUND ducks
      // the hull to maxs.z=4 / viewheight=-2 (feet+22; standing: 32/22).
      const st = makePmoveState();
      st.pmFlags |= PMF_ON_GROUND;
      st.groundEntity = 0;
      pmove(st, {
        msec: 50,
        angles: new Float32Array([0, 0, 0]) as UserCmd['angles'],
        forwardmove: 0,
        sidemove: 0,
        upmove: 0,
        buttons: 8, // BUTTON_DUCK hold; hull comes from PM_CheckDuck
      });
      expect(st.maxs[2]).toBe(4);
      expect(st.viewheight).toBe(-2);
      expect(PMF_DUCKED).toBe(1);
      // Airborne hold stands (C: the else branch tries to stand) — no
      // self-sustaining DUCKED while falling.
      const air = makePmoveState();
      air.pmFlags |= PMF_DUCKED;
      pmove(air, {
        msec: 50,
        angles: new Float32Array([0, 0, 0]) as UserCmd['angles'],
        forwardmove: 0,
        sidemove: 0,
        upmove: 0,
        buttons: 8,
      });
      expect(air.maxs[2]).toBe(32);
      // Ducked settle: same monotonic + tick-exact guarantees while held.
      const { xs, snaps } = settleRun(8, true);
      expect(snaps[snaps.length - 1]! - snaps[0]!).toBeGreaterThan(0);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
      }
      const tail = xs.slice(-7);
      for (const x of tail) expect(x).toBe(snaps[snaps.length - 1]!);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });

  it('ducked snapshot replays ducked: prediction matches authoritative pmove', () => {
    resetPmoveWorld();
    setPmoveWorld(floorTrace);
    setCVar('cl_predict', 1);
    try {
      // Authoritative crouched state (grounded, DUCKED, ducked hull).
      const server = makePmoveState();
      server.origin = new Float32Array([0, 0, 24]) as unknown as typeof server.origin;
      server.pmFlags |= PMF_ON_GROUND;
      server.groundEntity = 0;
      server.pmFlags |= PMF_DUCKED;
      server.mins[2] = -24;
      server.maxs[2] = 4;
      const duckCmd = (msec: number): PredictCmd => ({
        msec,
        angles: [0, 0, 0],
        forwardmove: 0,
        sidemove: 0,
        upmove: 0,
        buttons: 8,
      });
      const snap0: Snapshot = {
        serverTime: 1.0,
        entities: [
          {
            id: 1,
            origin: [0, 0, 24],
            velocity: [0, 0, 0],
            pmFlags: server.pmFlags,
            grounded: true,
          },
        ],
      };
      // Authoritative step: one 100ms duck-hold tick.
      const ref = makePmoveState();
      ref.origin = new Float32Array([0, 0, 24]) as unknown as typeof ref.origin;
      ref.pmFlags = server.pmFlags;
      ref.groundEntity = 0;
      ref.mins[2] = -24;
      ref.maxs[2] = 4;
      pmove(ref, {
        msec: 100,
        angles: new Float32Array([0, 0, 0]) as UserCmd['angles'],
        forwardmove: 0,
        sidemove: 0,
        upmove: 0,
        buttons: 8,
      });
      // Prediction from the flagged snapshot must land exactly there (pre-fix
      // it replayed from flags 0 and stood the hull up for the first step).
      expect(CL_PredictPmove(snap0, 1, [duckCmd(100)])).toEqual([
        ref.origin[0]!,
        ref.origin[1]!,
        ref.origin[2]!,
      ]);
      // ...and the replayed hull stays ducked.
      const st = makePmoveState();
      st.pmFlags = snap0.entities[0]!.pmFlags!;
      st.groundEntity = 0;
      expect(st.pmFlags & PMF_DUCKED).toBe(PMF_DUCKED);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });

  it('production staging settles with no oscillation past 0.5u (stop jitter)', () => {
    // Production-faithful stop: the host stages owned cmds incrementally
    // (one per 16ms frame, cleared per tick) and renders at the continuous
    // serverTime + serverAcc clock — unlike settleRun above, which stages
    // the full 100ms tick upfront. Replaying that staged prefix used to
    // expose the partial-step friction overshoot (a short pmove step keeps
    // more velocity, so it travels FARTHER than the full tick it prefixes)
    // as a forward pop + snap-back of up to ~0.54u per release tick.
    // The render now blends linearly to the server-exact tick end instead.
    resetPmoveWorld();
    setPmoveWorld(floorTrace);
    setCVar('cl_predict', 1);
    try {
      const server = makePmoveState();
      server.origin[0] = 0;
      server.origin[1] = 0;
      server.origin[2] = 24; // feet resting on the floor
      const ucmd = (msec: number, fwd: number): UserCmd => ({
        msec,
        angles: new Float32Array(ANGLES) as UserCmd['angles'],
        forwardmove: fwd,
        sidemove: 0,
        upmove: 0,
        buttons: 0,
      });
      let time = 0;
      for (let t = 0; t < 9; t++) {
        pmove(server, ucmd(100, 400));
        time += 0.1;
      }
      const takeSnap = (): Snapshot => ({
        serverTime: time,
        entities: [
          {
            id: 1,
            origin: [server.origin[0]!, server.origin[1]!, server.origin[2]!] as [number, number, number],
            velocity: [server.velocity[0]!, server.velocity[1]!, server.velocity[2]!] as [number, number, number],
            pmFlags: server.pmFlags,
            grounded: server.groundEntity !== -1,
          },
        ],
      });
      const p = new Predictor();
      p.pushSnapshot(takeSnap());
      // Warmup tick so the predictor holds a snapshot pair (production
      // always has prev+next past the first 100ms).
      pmove(server, ucmd(100, 400));
      time += 0.1;
      p.pushSnapshot(takeSnap());
      // Release phase: Host-style 16ms frames, cmd-first, incremental
      // staging, continuous render clock.
      let serverAcc = 0;
      let owned: PredictCmd[] = [];
      const xs: number[] = [];
      for (let i = 0; i < 30; i++) {
        serverAcc += 0.016;
        while (serverAcc >= 0.1) {
          serverAcc -= 0.1;
          pmove(server, ucmd(100, 0));
          time += 0.1;
          const s = takeSnap();
          p.pushSnapshot(s);
          owned = [];
          p.clearPendingCmds();
        }
        owned.push({
          msec: 16,
          angles: [0, 0, 0],
          forwardmove: 0,
          sidemove: 0,
          upmove: 0,
          buttons: 0,
        });
        p.setPendingCmds(owned);
        xs.push(p.renderEntities(time + serverAcc, 1).find((e) => e.id === 1)!.origin[0]);
      }
      // Monotonic settle: never steps backwards (no oscillation/pop).
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
      }
      // Post-settle displacement is exactly zero (the zero-velocity snap
      // pins the settled tail to the frozen tick, no drift or tremor).
      const final = xs[xs.length - 1]!;
      for (const x of xs.slice(-10)) expect(x).toBe(final);
      // The tail sits exactly on the authoritative frozen tick.
      expect(final).toBe(server.origin[0]!);
    } finally {
      setCVar('cl_predict', 1);
      resetPmoveWorld();
    }
  });
});

describe('lerpAngle (C q_shared.c LerpAngle, yaw interp between 10Hz snapshots)', () => {
  it('midpoints straight runs exactly', () => {
    expect(lerpAngle(0, 90, 0.5)).toBeCloseTo(45, 9);
    expect(lerpAngle(90, 0, 0.5)).toBeCloseTo(45, 9);
  });

  it('endpoints hold (frac 0 = prev, frac 1 = next mod 360 — C normalizes nothing)', () => {
    expect(lerpAngle(10, 350, 0)).toBeCloseTo(10, 9);
    // 10 -> 350 lerps the short arc (-20): raw output -10 ≡ 350.
    expect(((lerpAngle(10, 350, 1) % 360) + 360) % 360).toBeCloseTo(350, 9);
  });

  it('takes the short arc through 0/360 (never spins the long way)', () => {
    // 350 -> 10 is +20 through 0, not -340.
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(360, 9);
    // 10 -> 350 is -20 through 0, not +340.
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0, 9);
  });

  it('monotonic: successive fracs never step backwards along the arc', () => {
    const runs: Array<[number, number]> = [
      [0, 90],
      [90, 0],
      [350, 10],
      [10, 350],
      [170, -170],
    ];
    for (const [prev, next] of runs) {
      const end = lerpAngle(prev, next, 1);
      // Shortest-arc signed delta (matches the lerp's own wrap fixup).
      let delta = end - prev;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      let last = prev;
      for (let i = 1; i <= 10; i++) {
        const v = lerpAngle(prev, next, i / 10);
        if (delta >= 0) expect(v).toBeGreaterThanOrEqual(last - 1e-9);
        else expect(v).toBeLessThanOrEqual(last + 1e-9);
        // Bounded by the arc endpoints (no overshoot past next).
        if (delta >= 0) expect(v).toBeLessThanOrEqual(Math.max(prev, end) + 1e-9);
        else expect(v).toBeGreaterThanOrEqual(Math.min(prev, end) - 1e-9);
        last = v;
      }
    }
  });
});
