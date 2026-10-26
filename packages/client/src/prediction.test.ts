import { describe, expect, it } from 'vitest';
import { setCVar } from '@q2/config';
import { PMF_DUCKED, makePmoveState, pmove, resetPmoveWorld, setPmoveWorld } from '@q2/game';
import type { TraceFn, UserCmd } from '@q2/game';
import {
  CL_Interpolate,
  CL_Predict,
  CL_PredictPmove,
  extrapolateOrigin,
  interpFraction,
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
   * the per-tick snapshots). `duck` holds BUTTON_DUCK in the staged cmds
   * and sets PMF_DUCKED on the server each tick (the driver-side
   * translation pending the game wiring — see `isDuckHeld`).
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
      if (duck) server.pmFlags |= PMF_DUCKED;
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
      if (duck) server.pmFlags |= PMF_DUCKED;
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
      // The driver-side translation the game still needs (PM_CheckDuck
      // ignores the cmd bit): holding crouch sets PMF_DUCKED, which drops
      // the hull to maxs.z=4 / viewheight=12 (standing: 32/22).
      const st = makePmoveState();
      st.pmFlags |= PMF_DUCKED;
      pmove(st, {
        msec: 50,
        angles: new Float32Array([0, 0, 0]) as UserCmd['angles'],
        forwardmove: 0,
        sidemove: 0,
        upmove: 0,
        buttons: 8, // BUTTON_DUCK rides along; hull comes from PMF_DUCKED
      });
      expect(st.maxs[2]).toBe(4);
      expect(st.viewheight).toBe(12);
      expect(PMF_DUCKED).toBe(1);
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
});
