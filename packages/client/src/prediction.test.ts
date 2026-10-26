import { describe, expect, it } from 'vitest';
import { setCVar } from '@q2/config';
import { makePmoveState, pmove, resetPmoveWorld } from '@q2/game';
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
      const ents = p.renderEntities(0.1, 1);
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
});
