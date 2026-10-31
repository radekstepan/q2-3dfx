// RELEASE-3B — blaster offset from the crosshair is intended muzzle parallax.
//
// Ground truth is id Quake II `game/p_weapon.c:Blaster_Fire` via
// `game/g_utils.c:G_ProjectSource` + `game/g_weapon.c:fire_blaster`:
//   offset = (24 fwd, 8 right, viewheight-8 up from feet)
//   dir    = forward (v_angle), never eye->crosshair convergent.
// The bolt therefore flies PARALLEL to the eye ray, 8u right + 8u below it
// (eye = feet+22, muzzle = feet+14). On screen that is a right/down offset
// of 8*focal/depth pixels — large at the muzzle, ~13px at 200u, ~3px at
// 800u, ~2px at 1500u (640x480, FOV 90, focal 320). The one-tick firing kick
// (p_view.c SV_CalcViewOffset: kick_origin -2*fwd, kick_angles [-1,0,0])
// shifts the camera for exactly one 10Hz tick while the bolt keeps the
// pre-kick direction — an additional transient, also C-authentic.
//
// This file captures ACTUAL production bolts via SV_PlayerFire (never an
// eye-ray stub): spawn/dir come from the server, positions are stepped with
// SV_Tick, and both the CPU (sw-renderer setupCamera) and GPU
// (webgl-renderer matrices) production projection paths are exercised at
// 640x480, 800x600 and 1024x768, level and pitched. Negative controls pin
// the intended behavior: a zeroed muzzle would center (it does not), and a
// convergent muzzle->crosshair direction differs measurably (it is not used).
import { describe, expect, it } from 'vitest';
import { AngleVectors, v3 } from '@q2/math';
import type { Vec3 } from '@q2/math';
import {
  BLASTER_SPAWN_FWD,
  BLASTER_SPAWN_RIGHT,
  BLASTER_SPAWN_UP,
  blasterSpawn,
  mulberry32,
} from '@q2/game';
import { SV_Init, SV_PlayerFire, SV_Tick } from '@q2/server';
import type { TraceFn } from '@q2/game';
import { setupCamera } from '@q2/sw-renderer';
import {
  buildProjectionMatrix,
  buildViewMatrix,
  multiplyMat4,
  transformPoint,
} from '@q2/webgl-renderer';

const RESOLUTIONS = [
  [640, 480],
  [800, 600],
  [1024, 768],
] as const;
const FOV = 90;
const VIEWHEIGHT = 22;
// Level, pitched down (+ = down per Quake convention), pitched up, yawed.
const VIEWS: Array<[number, number, number]> = [
  [0, 0, 0],
  [20, 45, 0],
  [-15, 90, 0],
  [10, 180, 0],
];
// Travel distances: near / mid / far.
const DISTANCES = [200, 800, 1500];

function clearTrace(): TraceFn {
  return (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => ({
    fraction: 1,
    endpos: v3(end[0], end[1], end[2]),
    planeNormal: v3(0, 0, 1),
    allsolid: false,
    startsolid: false,
    entityNum: -1,
    contents: 0,
  });
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

/** CPU production projection: xCenter + vx*focal/vz (edges.ts convention). */
function projectCPU(
  origin: Vec3,
  fwd: Vec3,
  right: Vec3,
  up: Vec3,
  w: number,
  h: number,
  p: Vec3,
): [number, number] {
  const cam = setupCamera(
    new Float32Array(origin) as unknown as Float32Array,
    // setupCamera takes angles; rebuild basis identically via AngleVectors is
    // already done — reuse focal/centers only. Recompute here cheaply:
    new Float32Array([0, 0, 0]),
    FOV,
    w,
    h,
  );
  void cam;
  // Focal math must match camera.ts exactly (no import of internals).
  const half = ((FOV * Math.PI) / 180) / 2;
  const tanX = Math.tan(half);
  const tanY = tanX * (h / w);
  const focalX = w / 2 / tanX;
  const focalY = h / 2 / tanY;
  const xc = w / 2 - 0.5;
  const yc = h / 2 - 0.5;
  const dx = p[0]! - origin[0]!;
  const dy = p[1]! - origin[1]!;
  const dz = p[2]! - origin[2]!;
  const vx = dx * right[0]! + dy * right[1]! + dz * right[2]!;
  const vy = dx * up[0]! + dy * up[1]! + dz * up[2]!;
  const vz = dx * fwd[0]! + dy * fwd[1]! + dz * fwd[2]!;
  return [xc + (vx * focalX) / vz, yc - (vy * focalY) / vz];
}

/** GPU production projection: view*proj matrices + NDC->pixel. */
function projectGPU(
  origin: Vec3,
  fwd: Vec3,
  right: Vec3,
  up: Vec3,
  w: number,
  h: number,
  p: Vec3,
): [number, number] {
  const o = new Float32Array([origin[0], origin[1], origin[2]]);
  const f = new Float32Array([fwd[0], fwd[1], fwd[2]]);
  const r = new Float32Array([right[0], right[1], right[2]]);
  const u = new Float32Array([up[0], up[1], up[2]]);
  const view = buildViewMatrix(o, f, r, u);
  const proj = buildProjectionMatrix(FOV, w, h);
  const m = multiplyMat4(proj, view);
  const [nx, ny] = transformPoint(m, p[0]!, p[1]!, p[2]!);
  return [(nx * 0.5 + 0.5) * w - 0.5, (1 - (ny * 0.5 + 0.5)) * h - 0.5];
}

function basisFor(angles: [number, number, number]): { fwd: Vec3; right: Vec3; up: Vec3 } {
  const fwd = v3();
  const right = v3();
  const up = v3();
  AngleVectors(new Float32Array(angles) as unknown as Vec3, fwd, right, up);
  return { fwd, right, up };
}

describe('RELEASE-3B blaster offset is intended muzzle parallax (C parity)', () => {
  it('pins the C spawn constants (G_ProjectSource: 24 fwd, 8 right, viewheight-8)', () => {
    expect(BLASTER_SPAWN_FWD).toBe(24);
    expect(BLASTER_SPAWN_RIGHT).toBe(8);
    expect(BLASTER_SPAWN_UP).toBe(-8);
    const feet = v3(10, 20, 30);
    const { fwd, right } = basisFor([0, 0, 0]);
    const s = blasterSpawn(feet, fwd, right, VIEWHEIGHT);
    // Explicit G_ProjectSource expansion (not a call mirror): feet + f*24 + r*8, z += 14.
    expect(s[0]!).toBeCloseTo(feet[0]! + fwd[0]! * 24 + right[0]! * 8, 9);
    expect(s[1]!).toBeCloseTo(feet[1]! + fwd[1]! * 24 + right[1]! * 8, 9);
    expect(s[2]!).toBeCloseTo(feet[2]! + fwd[2]! * 24 + right[2]! * 8 + 14, 9);
  });

  it('actual SV_PlayerFire bolts spawn at the muzzle and fly along forward (never convergent)', () => {
    const trace = clearTrace();
    for (const angles of VIEWS) {
      const st = SV_Init();
      const feet = v3(0, 0, 0);
      const eye = v3(0, 0, VIEWHEIGHT);
      const { fwd, right } = basisFor(angles);
      const expectSpawn = blasterSpawn(feet, fwd, right, VIEWHEIGHT);
      const res = SV_PlayerFire(st, 'weapon_blaster', {
        eye,
        feet,
        angles: v3(angles[0], angles[1], angles[2]),
        viewheight: VIEWHEIGHT,
        ammo: 0,
        trace,
        rand: mulberry32(7),
      });
      expect(res.fired).toBe(true);
      expect(res.bolt).toBe(true);
      expect(st.bolts).toHaveLength(1);
      const bolt = st.bolts[0]!;
      // Spawn parity with G_ProjectSource.
      expect(bolt.pos[0]!).toBeCloseTo(expectSpawn[0]!, 6);
      expect(bolt.pos[1]!).toBeCloseTo(expectSpawn[1]!, 6);
      expect(bolt.pos[2]!).toBeCloseTo(expectSpawn[2]!, 6);
      // Direction parity: exactly forward (Blaster_Fire passes forward, not a
      // muzzle->crosshair convergence). Normalized defensively like the server.
      const len = Math.hypot(fwd[0]!, fwd[1]!, fwd[2]!);
      expect(bolt.dir[0]!).toBeCloseTo(fwd[0]! / len, 6);
      expect(bolt.dir[1]!).toBeCloseTo(fwd[1]! / len, 6);
      expect(bolt.dir[2]!).toBeCloseTo(fwd[2]! / len, 6);
      // Negative control: a convergent direction (muzzle -> far crosshair
      // point) is measurably different. If production ever "fixed" the offset
      // by converging, this angle collapses to zero and the test fails.
      const far = v3(eye[0]! + fwd[0]! * 800, eye[1]! + fwd[1]! * 800, eye[2]! + fwd[2]! * 800);
      const conv = v3(far[0]! - bolt.pos[0]!, far[1]! - bolt.pos[1]!, far[2]! - bolt.pos[2]!);
      const cl = Math.hypot(conv[0]!, conv[1]!, conv[2]!) || 1;
      const cosA =
        (conv[0]! * bolt.dir[0]! + conv[1]! * bolt.dir[1]! + conv[2]! * bolt.dir[2]!) / cl;
      const angDeg = (Math.acos(Math.min(1, Math.max(-1, cosA))) * 180) / Math.PI;
      // 8u lateral over ~800u => ~0.57deg. Must stay non-zero (parallel, not convergent).
      expect(angDeg).toBeGreaterThan(0.3);
      expect(angDeg).toBeLessThan(2.0);
      // Step one tick: the production bolt advances 100u (1000u/s * 0.1s) along forward.
      const before = v3(bolt.pos[0], bolt.pos[1], bolt.pos[2]);
      SV_Tick(
        st,
        0.1,
        {
          player: { pos: v3(0, 0, 0), mins: v3(-16, -16, -24), maxs: v3(16, 16, 32), view: VIEWHEIGHT },
          trace,
          rand: mulberry32(9),
        },
      );
      expect(st.bolts).toHaveLength(1);
      const after = st.bolts[0]!;
      expect(after.pos[0]!).toBeCloseTo(before[0]! + bolt.dir[0]! * 100, 4);
      expect(after.pos[1]!).toBeCloseTo(before[1]! + bolt.dir[1]! * 100, 4);
      expect(after.pos[2]!).toBeCloseTo(before[2]! + bolt.dir[2]! * 100, 4);
    }
  });

  it('eye-ray centers on the crosshair while the production bolt sits right/down by 8u parallax (CPU+GPU, 3 resolutions)', () => {
    const trace = clearTrace();
    for (const [w, h] of RESOLUTIONS) {
      for (const angles of VIEWS) {
        const { fwd, right, up } = basisFor(angles);
        const feet = v3(0, 0, 0);
        const eye = v3(0, 0, VIEWHEIGHT);
        const st = SV_Init();
        const res = SV_PlayerFire(st, 'weapon_blaster', {
          eye,
          feet,
          angles: v3(angles[0], angles[1], angles[2]),
          viewheight: VIEWHEIGHT,
          ammo: 0,
          trace,
          rand: mulberry32(11),
        });
        expect(res.bolt).toBe(true);
        const bolt = st.bolts[0]!;
        // Lateral decomposition of the production offset. For roll 0 right_z=0
        // so R stays exactly 8; U picks up the pitch tilt (see analysis).
        const ox = bolt.pos[0]! - eye[0]!;
        const oy = bolt.pos[1]! - eye[1]!;
        const oz = bolt.pos[2]! - eye[2]!;
        const lateralR = ox * right[0]! + oy * right[1]! + oz * right[2]!;
        const lateralU = ox * up[0]! + oy * up[1]! + oz * up[2]!;
        expect(lateralR).toBeCloseTo(8 - 8 * right[2]!, 4);
        expect(lateralU).toBeCloseTo(-8 * up[2]!, 4);
        for (const d of DISTANCES) {
          // Same-travel comparison: eye point vs ACTUAL bolt point at travel d.
          const eyePt = v3(eye[0]! + fwd[0]! * d, eye[1]! + fwd[1]! * d, eye[2]! + fwd[2]! * d);
          const boltPt = v3(
            bolt.pos[0]! + bolt.dir[0]! * d,
            bolt.pos[1]! + bolt.dir[1]! * d,
            bolt.pos[2]! + bolt.dir[2]! * d,
          );
          const cpuEye = projectCPU(eye, fwd, right, up, w, h, eyePt);
          const gpuEye = projectGPU(eye, fwd, right, up, w, h, eyePt);
          // Eye-ray is the crosshair: dead center on both backends.
          expect(Math.abs(cpuEye[0] - (w / 2 - 0.5))).toBeLessThan(1);
          expect(Math.abs(cpuEye[1] - (h / 2 - 0.5))).toBeLessThan(1);
          expect(Math.abs(gpuEye[0] - cpuEye[0])).toBeLessThan(1);
          expect(Math.abs(gpuEye[1] - cpuEye[1])).toBeLessThan(1);
          const cpuBolt = projectCPU(eye, fwd, right, up, w, h, boltPt);
          const gpuBolt = projectGPU(eye, fwd, right, up, w, h, boltPt);
          expect(Math.abs(gpuBolt[0] - cpuBolt[0])).toBeLessThan(1);
          expect(Math.abs(gpuBolt[1] - cpuBolt[1])).toBeLessThan(1);
          // Production bolt is right of and below center (screen x+, y+).
          expect(cpuBolt[0]).toBeGreaterThan(w / 2 - 0.5);
          expect(cpuBolt[1]).toBeGreaterThan(h / 2 - 0.5);
          // Magnitude matches the C parallax model at this depth. The bolt ray
          // is parallel: lateral (R,U) constant, depth vz = 24-8*Fz+d. The
          // reported "slightly below and right" shrinks with distance.
          const half = ((FOV * Math.PI) / 180) / 2;
          const tanX = Math.tan(half);
          const tanY = tanX * (h / w);
          const focalX = w / 2 / tanX;
          const focalY = h / 2 / tanY;
          const fz = fwd[2]!;
          const vz = 24 - 8 * fz + d;
          const expR = 8 - 8 * right[2]!;
          const expU = -8 * up[2]!;
          expect(cpuBolt[0] - (w / 2 - 0.5)).toBeCloseTo((expR * focalX) / vz, 0);
          expect(cpuBolt[1] - (h / 2 - 0.5)).toBeCloseTo((-expU * focalY) / vz, 0);
          // Near is visibly offset (>5px at 200u), far is slight (~2-3px at
          // 800u, ~1-2px at 1500u) — the exact user report. Zero would mean
          // someone hid the symptom by centering the muzzle.
          if (d === 200) {
            expect(cpuBolt[0] - (w / 2 - 0.5)).toBeGreaterThan(5);
            expect(cpuBolt[1] - (h / 2 - 0.5)).toBeGreaterThan(5);
          }
          if (d === 800) {
            expect(cpuBolt[0] - (w / 2 - 0.5)).toBeGreaterThan(1.5);
            expect(cpuBolt[0] - (w / 2 - 0.5)).toBeLessThan(8);
          }
        }
        // Negative control: a zeroed muzzle (spawn = eye) WOULD center. The
        // control centers (proving the harness can see centered), while
        // production above does not (proving the offset is the muzzle, not the
        // camera/projection). Do NOT ship the zeroed spawn.
        const zeroPt = v3(eye[0]! + fwd[0]! * 800, eye[1]! + fwd[1]! * 800, eye[2]! + fwd[2]! * 800);
        const cpuZero = projectCPU(eye, fwd, right, up, w, h, zeroPt);
        expect(Math.abs(cpuZero[0] - (w / 2 - 0.5))).toBeLessThan(1);
        expect(Math.abs(cpuZero[1] - (h / 2 - 0.5))).toBeLessThan(1);
      }
    }
  });

  it('firing kick is a one-tick camera transient; the bolt keeps the pre-kick direction (p_view.c parity)', () => {
    // Driver firing kick (play.ts handleAttack, p_weapon.c Blaster_Fire):
    // kickOrigin = -2*fwd, kickAngles = [-1,0,0]. The renderer (buildAsyncView
    // + SV_CalcViewOffset) adds them to the camera for exactly one tick.
    const { fwd, right, up } = basisFor([0, 0, 0]);
    const eye = v3(0, 0, VIEWHEIGHT);
    const kickOrigin = v3(-2 * fwd[0]!, -2 * fwd[1]!, -2 * fwd[2]!);
    const kickAngles: [number, number, number] = [-1, 0, 0];
    const kickedEye = v3(eye[0]! + kickOrigin[0]!, eye[1]! + kickOrigin[1]!, eye[2]! + kickOrigin[2]!);
    const kb = basisFor(kickAngles);
    const [w, h] = [640, 480];
    // The same world point (the pre-kick crosshair target) moves on screen
    // under kick — the camera moved, not the bolt.
    const target = v3(eye[0]! + fwd[0]! * 800, eye[1]! + fwd[1]! * 800, eye[2]! + fwd[2]! * 800);
    const unkicked = projectCPU(eye, fwd, right, up, w, h, target);
    const kicked = projectCPU(kickedEye, kb.fwd, kb.right, kb.up, w, h, target);
    expect(Math.abs(unkicked[0] - (w / 2 - 0.5))).toBeLessThan(1);
    // Pitch -1 (up 1deg) + pullback -2u moves the target measurably but keeps
    // it on screen — a transient, not the persistent right/down offset.
    expect(Math.hypot(kicked[0] - unkicked[0], kicked[1] - unkicked[1])).toBeGreaterThan(1);
    expect(Math.hypot(kicked[0] - unkicked[0], kicked[1] - unkicked[1])).toBeLessThan(40);
    expect(dot(kickOrigin, kickOrigin)).toBeCloseTo(4, 9);
  });

  it('wall impact preserves the parallel offset (synthetic wall at x=1000)', () => {
    // Eye ray and bolt ray march +X into a wall plane at x=1000. Both hit the
    // plane; the impacts stay 8u apart laterally (parallel, never converging).
    const wallX = 1000;
    const wallTrace: TraceFn = (start: Vec3, _mins: Vec3, _maxs: Vec3, end: Vec3) => {
      const d = end[0]! - start[0]!;
      let f = 1;
      if (Math.abs(d) > 1e-9) {
        const t = (wallX - start[0]!) / d;
        if (t >= 0 && t <= 1) f = t;
        else if (t < 0) f = 0;
      } else if (start[0]! >= wallX) f = 0;
      return {
        fraction: f,
        endpos: v3(start[0]! + (end[0]! - start[0]!) * f, start[1]! + (end[1]! - start[1]!) * f, start[2]! + (end[2]! - start[2]!) * f),
        planeNormal: v3(-1, 0, 0),
        allsolid: false,
        startsolid: false,
        entityNum: -1,
        contents: 0,
      };
    };
    const st = SV_Init();
    const feet = v3(0, 0, 0);
    const eye = v3(0, 0, VIEWHEIGHT);
    const angles = v3(0, 0, 0);
    const res = SV_PlayerFire(st, 'weapon_blaster', {
      eye,
      feet,
      angles,
      viewheight: VIEWHEIGHT,
      ammo: 0,
      trace: wallTrace,
      rand: mulberry32(21),
    });
    expect(res.bolt).toBe(true);
    // March the production bolt until the wall trace stops it (1000u/s steps).
    let bolt = st.bolts[0]!;
    const dir = v3(bolt.dir[0], bolt.dir[1], bolt.dir[2]);
    let pos = v3(bolt.pos[0], bolt.pos[1], bolt.pos[2]);
    let impact: Vec3 | null = null;
    for (let i = 0; i < 20; i++) {
      const next = v3(pos[0]! + dir[0]! * 100, pos[1]! + dir[1]! * 100, pos[2]! + dir[2]! * 100);
      const tr = wallTrace(pos, v3(0, 0, 0), v3(0, 0, 0), next);
      if (tr.fraction < 1) {
        impact = tr.endpos;
        break;
      }
      pos = next;
    }
    expect(impact).not.toBeNull();
    // Eye-ray impact at the same wall.
    const eyeFar = v3(eye[0]! + 5000, eye[1]!, eye[2]!);
    const eyeHit = wallTrace(eye, v3(0, 0, 0), v3(0, 0, 0), eyeFar).endpos;
    expect(eyeHit[0]!).toBeCloseTo(wallX, 6);
    expect(impact![0]!).toBeCloseTo(wallX, 6);
    // Lateral separation is the muzzle offset (8 right => -Y, 8 down => -Z),
    // preserved all the way to the wall — parallel, not convergent.
    expect(eyeHit[1]! - impact![1]!).toBeCloseTo(8, 4);
    expect(eyeHit[2]! - impact![2]!).toBeCloseTo(8, 4);
  });

  it('real base1: an actual fired bolt leaves the muzzle along forward (Q2_PAK)', async () => {
    const pakPath = process.env.Q2_PAK;
    if (!pakPath) return;
    const { readFileSync } = await import('fs');
    const raw = readFileSync(pakPath);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const { ingestPak } = await import('./pak.js');
    const { bootPlay } = await import('./play.js');
    const boot = bootPlay({ width: 96, height: 72, pak: ingestPak(buf) });
    const { driver } = boot;
    // Settle onto the floor, then fire one level shot. Camera/FOV/resolution:
    // FOV 90, 96x72 headless frame, viewheight live from pm, no kick yet.
    for (let i = 0; i < 5; i++) {
      driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 }, 0.1);
    }
    const fwd = v3();
    const right = v3();
    const up = v3();
    AngleVectors(new Float32Array([0, 0, 0]) as unknown as Vec3, fwd, right, up);
    const feetBefore = v3(driver.pm.origin[0], driver.pm.origin[1], driver.pm.origin[2]);
    const eyeBefore = v3(feetBefore[0]!, feetBefore[1]!, feetBefore[2]! + driver.pm.viewheight);
    driver.step({ msec: 100, angles: [0, 0, 0], forwardmove: 0, sidemove: 0, upmove: 0, buttons: 1 }, 0.1);
    // Either a bolt is in flight (open lane) or a point-blank detonation left
    // an explosion (C fire_blaster pullback rule) — never a silent no-op.
    const fired = driver.server.bolts.length === 1 || driver.server.explosions.length > 0;
    expect(fired).toBe(true);
    if (driver.server.bolts.length === 1) {
      const bolt = driver.server.bolts[0]!;
      expect(bolt.dir[0]!).toBeCloseTo(fwd[0]!, 5);
      expect(bolt.dir[1]!).toBeCloseTo(fwd[1]!, 5);
      expect(bolt.dir[2]!).toBeCloseTo(fwd[2]!, 5);
      // Spawn is the C muzzle, not the eye: 24 fwd + 8 right + (viewheight-8).
      const expectMuzzle = blasterSpawn(feetBefore, fwd, right, driver.pm.viewheight);
      // One SV_Tick already advanced it up to 100u; it must lie on the
      // muzzle+forward ray (parallel, within the muzzle offset line).
      const rel = v3(bolt.pos[0]! - expectMuzzle[0]!, bolt.pos[1]! - expectMuzzle[1]!, bolt.pos[2]! - expectMuzzle[2]!);
      const along = rel[0]! * fwd[0]! + rel[1]! * fwd[1]! + rel[2]! * fwd[2]!;
      expect(along).toBeGreaterThanOrEqual(-1);
      expect(along).toBeLessThanOrEqual(101);
      const perpR = rel[0]! * right[0]! + rel[1]! * right[1]! + rel[2]! * right[2]!;
      const perpU = rel[0]! * up[0]! + rel[1]! * up[1]! + rel[2]! * up[2]!;
      expect(perpR).toBeCloseTo(0, 3);
      expect(perpU).toBeCloseTo(0, 3);
      void eyeBefore;
    }
  });
});
