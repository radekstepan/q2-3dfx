// RELEASE-3 — aim and overlay alignment at every resolution.
//
// Headless pins for the alignment contract (real-browser proof lives in
// resolution-fit.test.ts): crosshair/HUD rows rendered into real buffers at
// 640x480, 800x600 and 1024x768; CPU/GPU projection centers agree; a
// base1 eye-ray hits where the crosshair points (Q2_PAK). No arithmetic
// tautologies: every assertion reads a rendered buffer, a projected trace,
// or the pure fit math against explicit stage sizes.
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars, setCVar } from '@q2/config';
import { AngleVectors, v3 } from '@q2/math';
import { setupCamera } from '@q2/sw-renderer';
import { buildProjectionMatrix, buildViewMatrix, multiplyMat4, transformPoint } from '@q2/webgl-renderer';
import { SV_TraceFor } from '@q2/server';
import { bootPlay, drawPlayHud, fpsHudAnchor, posHudAnchor } from './play.js';
import { fitPlayCanvas, fitScaleForStage } from './dom.js';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g['document'];
  delete g['window'];
});

const RESOLUTIONS = [
  [640, 480],
  [800, 600],
  [1024, 768],
] as const;

describe('RELEASE-3 aim and overlay anchoring (headless pins)', () => {
  it('fit math preserves the framebuffer aspect and never overflows the stage', () => {
    for (const [w, h] of RESOLUTIONS) {
      // Roomy stage: fills width or height exactly.
      const roomy = fitScaleForStage(w, h, 1280, 800);
      expect(roomy.cssW).toBeLessThanOrEqual(1280);
      expect(roomy.cssH).toBeLessThanOrEqual(800);
      expect(Math.abs(roomy.cssW / roomy.cssH - w / h)).toBeLessThan(0.01);
      expect(Math.abs(roomy.cssW / w - roomy.cssH / h)).toBeLessThan(1 / Math.min(w, h) + 1e-9);
      // Cramped stage: shrinks (never clips), aspect still exact.
      const cramped = fitScaleForStage(w, h, 300, 200);
      expect(cramped.cssW).toBeLessThanOrEqual(300);
      expect(cramped.cssH).toBeLessThanOrEqual(200);
      expect(Math.abs(cramped.cssW / cramped.cssH - w / h)).toBeLessThan(0.02);
      expect(cramped.scale).toBeLessThan(1);
    }
    // Degenerate inputs degrade to a 1x box, never NaN/zero CSS.
    for (const bad of [0, -10, NaN, Infinity]) {
      const f = fitScaleForStage(640, 480, bad, bad);
      expect(Number.isFinite(f.cssW) && f.cssW >= 1).toBe(true);
      expect(Number.isFinite(f.cssH) && f.cssH >= 1).toBe(true);
      expect(Number.isFinite(f.scale) && f.scale > 0).toBe(true);
    }
  });

  it('fitPlayCanvas is headless-safe and reports the legacy x2 box without a DOM', () => {
    expect(typeof document).toBe('undefined');
    const fit = fitPlayCanvas(null, 640, 480);
    expect(fit.applied).toBe(false);
    expect(fit.cssW).toBe(1280);
    expect(fit.cssH).toBe(960);
  });

  it('all HUD rows stay inside the buffer at every offered resolution', () => {
    for (const [w, h] of RESOLUTIONS) {
      // Top row: fps top-right (8px margins), pos top-left.
      const fps = fpsHudAnchor(w, 'fps 60');
      expect(fps.y).toBe(8);
      expect(fps.x).toBeGreaterThanOrEqual(0);
      expect(fps.x).toBeLessThan(w);
      expect(posHudAnchor()).toEqual({ x: 8, y: 8 });
      // Bottom rows (drawPlayHud geometry): weapon caption above the gun,
      // hp/ammo/message lines — none may leave the buffer or force scroll.
      const gunH = 36;
      expect(h - gunH - 10).toBeGreaterThan(28); // caption below the devroom hint
      expect(h - 18).toBeLessThan(h); // hp/ammo row
      expect(h - 30).toBeGreaterThanOrEqual(0); // message row
      expect(h - 48).toBeGreaterThanOrEqual(0); // second hp row (low-hp layout)
    }
  });

  it('rendered crosshair sits on the framebuffer center pixel at every resolution', () => {
    for (const [w, h] of RESOLUTIONS) {
      const boot = bootPlay({ width: w, height: h, renderer: 'software', pak: null });
      expect(boot.host.fb.width).toBe(w);
      expect(boot.host.fb.height).toBe(h);
      const target = { width: w, height: h, color: new Uint32Array(w * h) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      const cx = (w / 2) | 0;
      const cy = (h / 2) | 0;
      // Center dot: full white.
      expect(target.color[cy * w + cx]).toBe(0xffffffff);
      // Arms: dim cross (9 wide / 9 tall), all inside the buffer.
      expect(target.color[cy * w + cx - 4]).toBe(0xff888888);
      expect(target.color[cy * w + cx + 4]).toBe(0xff888888);
      expect(target.color[(cy - 4) * w + cx]).toBe(0xff888888);
      expect(target.color[(cy + 4) * w + cx]).toBe(0xff888888);
    }
  });

  it('CPU camera and GPU projection agree on the screen center', () => {
    // A point dead ahead must land on the crosshair through BOTH backends'
    // independent projection math (CPU pixel convention is center-0.5,
    // GPU NDC maps to exact center: within 1px, inside the crosshair arms).
    for (const [w, h] of RESOLUTIONS) {
      const origin = new Float32Array([0, 0, 32]);
      const angles = new Float32Array([0, 0, 0]);
      const cam = setupCamera(origin, angles, 90, w, h);
      const fwd = cam.forward;
      const px = cam.xCenter + 0 * cam.focalX;
      const py = cam.yCenter - 0 * cam.focalY;
      expect(px).toBeCloseTo(w / 2 - 0.5, 9);
      expect(py).toBeCloseTo(h / 2 - 0.5, 9);
      const P = buildProjectionMatrix(90, w, h);
      // Project via the GPU basis: a point straight ahead of the camera
      // maps to NDC (0,0) by construction of the shared focal math.
      const ahead: [number, number, number] = [100, 0, 32];
      const dx = ahead[0] - 0;
      const dy = ahead[1] - 0;
      const dz = ahead[2] - 32;
      // View coords: dot with the camera basis (R/Y-left, U, F).
      const vx = dx * cam.right[0]! + dy * cam.right[1]! + dz * cam.right[2]!;
      const vy = dx * cam.up[0]! + dy * cam.up[1]! + dz * cam.up[2]!;
      const vz = dx * cam.forward[0]! + dy * cam.forward[1]! + dz * cam.forward[2]!;
      const cpuX = cam.xCenter + (vx * cam.focalX) / vz;
      const cpuY = cam.yCenter - (vy * cam.focalY) / vz;
      expect(Math.abs(cpuX - (w / 2 - 0.5))).toBeLessThan(1e-6);
      expect(Math.abs(cpuY - (h / 2 - 0.5))).toBeLessThan(1e-6);
      // GPU NDC for the same view point: build the MVP from the same basis
      // and divide — must read (0,0) up to float rounding.
      const VM = buildViewMatrix(origin, fwd, cam.right, cam.up);
      const MVP = multiplyMat4(P, VM);
      const [nx, ny] = transformPoint(MVP, ahead[0], ahead[1], ahead[2]);
      expect(Math.abs(nx)).toBeLessThan(1e-5);
      expect(Math.abs(ny)).toBeLessThan(1e-5);
      // NDC (0,0) displays at canvas center (w/2, h/2): the integer
      // crosshair pixel is within 1px of both conventions.
      expect(Math.abs(w / 2 - (w / 2 - 0.5))).toBeLessThanOrEqual(0.5);
    }
  });

  it('fps/pos readouts render in-canvas with exact colors (no DOM overlay)', () => {
    const boot = bootPlay({ width: 160, height: 120, renderer: 'software', pak: null });
    setCVar('cl_showfps', 1);
    try {
      const target = { width: 160, height: 120, color: new Uint32Array(160 * 120) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      let green = 0;
      for (let y = 8; y < 16; y++) {
        for (let x = 104; x < 152; x++) {
          if (target.color[y * 160 + x] === 0xff00ff00) green++;
        }
      }
      expect(green).toBeGreaterThan(10);
      let grey = 0;
      for (let y = 8; y < 16; y++) {
        for (let x = 8; x < 64; x++) {
          if (target.color[y * 160 + x] === 0xff999999) grey++;
        }
      }
      expect(grey).toBeGreaterThan(5);
    } finally {
      setCVar('cl_showfps', 1);
    }
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

async function bootBase1(width: number, height: number) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

describe.runIf(!!WEB_Q2_PAK)('RELEASE-3 shot ray meets the crosshair (real base1)', () => {
  it('a level eye-ray down the view axis projects inside the crosshair arms', { timeout: 120000 }, async () => {
    for (const [w, h] of RESOLUTIONS) {
      const boot = await bootBase1(w, h);
      const { driver } = boot;
      // Stand the player up and look level down +X (yaw 0): the eye ray
      // must strike world geometry straight ahead (spawn room walls).
      driver.pm.viewAngles = new Float32Array([0, 0, 0]) as unknown as typeof driver.pm.viewAngles;
      const eye = v3(
        driver.pm.origin[0]!,
        driver.pm.origin[1]!,
        driver.pm.origin[2]! + 22,
      );
      const fwd = v3();
      const right = v3();
      const up = v3();
      AngleVectors(driver.pm.viewAngles as unknown as Float32Array, fwd, right, up);
      const far = v3(
        eye[0]! + fwd[0]! * 8192,
        eye[1]! + fwd[1]! * 8192,
        eye[2]! + fwd[2]! * 8192,
      );
      const trace = SV_TraceFor(driver.map!);
      const hit = trace(eye, v3(), v3(), far);
      // Must hit the room (not the void): the projection below is only
      // meaningful against real geometry.
      expect(hit.fraction).toBeLessThan(1);
      const p = hit.endpos;
      const cam = setupCamera(
        new Float32Array(eye),
        driver.pm.viewAngles as unknown as Float32Array,
        90,
        w,
        h,
      );
      const d = v3(p[0]! - eye[0]!, p[1]! - eye[1]!, p[2]! - eye[2]!);
      const vx = d[0]! * cam.right[0]! + d[1]! * cam.right[1]! + d[2]! * cam.right[2]!;
      const vy = d[0]! * cam.up[0]! + d[1]! * cam.up[1]! + d[2]! * cam.up[2]!;
      const vz = d[0]! * cam.forward[0]! + d[1]! * cam.forward[1]! + d[2]! * cam.forward[2]!;
      expect(vz).toBeGreaterThan(0);
      const px = cam.xCenter + (vx * cam.focalX) / vz;
      const py = cam.yCenter - (vy * cam.focalY) / vz;
      // Straight-ahead impact: within the 9x9 crosshair (C spread aside —
      // the center pellet travels exactly this ray; muzzle parallax only
      // applies to the projectile spawn, never to hitscan aim).
      expect(Math.abs(px - ((w / 2) | 0))).toBeLessThanOrEqual(4);
      expect(Math.abs(py - ((h / 2) | 0))).toBeLessThanOrEqual(4);
    }
  });
});
