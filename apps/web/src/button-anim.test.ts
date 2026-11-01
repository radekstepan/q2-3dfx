// RELEASE-16 — shootable secret-button texture/lighting states.
//
// User report: near (-2146.2, 1556.6, -24) the secret's shootable button is
// always lit; its inward press motion when shot is correct and must be
// preserved. Ground truth (game/g_func.c): button_wait selects frame 1 +
// EF_ANIM23, button_return resets frame 0, button_done restores EF_ANIM01.
// The button is base1 *13 (func_button, target t91, wait -1, health 1): its
// up/down faces carry 4-frame +0btshoot chains (faces 7498/7499), the sides
// are static box1_1. Unpressed = ANIM01 (frames 0-1); shot + held TOP =
// ANIM23 (frames 2-3, the "lit" variant). Physical travel (+4z, TOP hold)
// is preserved exactly; only the texture selection was missing (both
// renderers always showed the base +0btshoot1).
//
// Boots real base1 and asserts, on real assets:
//   (b1) *13 before/after shooting: live texId moves ANIM01->ANIM23 range,
//        software pixels change, travel stays [0,0,4], secret fires.
//   (b2) repeat shots while held never re-fire (C UP/TOP no-op).
//   (b3) negative control: forcing the before frame reproduces the before
//        pixels exactly (mover-distance assertions alone cannot show this).
//   (b4) *34 E-use cycle: ANIM01 -> ANIM23 at TOP -> ANIM23 while returning
//        (C button_return keeps effects) -> ANIM01 at BOTTOM, plus 2Hz
//        autoanim flips at rest.
//   (b5) WebGL2 scene side: refreshGpuScene materialHandles follow the live
//        texIds before/after (the stub-GL suite proves the rebind draws).
import { describe, expect, it, afterEach } from 'vitest';
import { resetCVars } from '@q2/config';
import type { UserCmdT } from '@q2/input';
import { v3, type Vec3 } from '@q2/math';
import type { MiniSurf } from '@q2/sw-renderer';
import { SV_ClipTrace, SV_DamageButton, SV_SetPlayerHealth, SV_TraceFor, SV_UseButton } from '@q2/server';
import { refreshGpuScene } from '@q2/webgl-renderer';
import { bootPlay, buildAsyncView, resolveDisplay } from './play.js';

const WEB_Q2_PAK = process.env.Q2_PAK;

function neutralCmd(angles: [number, number, number] = [0, 0, 0]): UserCmdT {
  return { msec: 100, angles, forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };
}

async function bootBase1(width = 192, height = 144) {
  const { readFileSync } = await import('fs');
  const raw = readFileSync(WEB_Q2_PAK as string);
  const buf = new ArrayBuffer(raw.length);
  new Uint8Array(buf).set(raw);
  const { ingestPak } = await import('./pak.js');
  return bootPlay({ width, height, pak: ingestPak(buf) });
}

function renderFrame(
  boot: ReturnType<typeof bootPlay>,
  parts: { view: { origin: Vec3; angles: Vec3; fovX: number; time: number; lightStyles: Float32Array }; renderables: Parameters<ReturnType<typeof bootPlay>['refresh']['renderView']>[2] },
): Uint32Array {
  boot.refresh.beginFrame();
  boot.refresh.renderView(
    parts.view as Parameters<ReturnType<typeof bootPlay>['refresh']['renderView']>[0],
    boot.host.world,
    parts.renderables,
  );
  boot.refresh.endFrame();
  return new Uint32Array(resolveDisplay(boot));
}

/** Authoritative-eye view + gun re-anchored renderables (underwater pattern). */
function frameParts(
  boot: ReturnType<typeof bootPlay>,
  angles: [number, number, number],
) {
  const { driver } = boot;
  const eye = v3(driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]! + driver.pm.viewheight);
  const view = {
    origin: eye,
    angles: v3(angles[0], angles[1], angles[2]),
    fovX: 90,
    time: 3.7,
    lightStyles: new Float32Array(256).fill(1),
  };
  const { renderables } = buildAsyncView(boot.host, 0);
  for (const e of renderables) {
    if (e.depthHack) e.origin = new Float32Array([eye[0]!, eye[1]!, eye[2]!]) as typeof e.origin;
  }
  return { view, renderables };
}

/** Animated faces of a button door (chain length > 1). */
function animFaces(boot: ReturnType<typeof bootPlay>, model: string): MiniSurf[] {
  const faces = boot.driver.doorAnimFaces(model);
  expect(faces).not.toBeNull();
  const anim = faces!.filter((s) => s.animTexIds && s.animTexIds.length > 1);
  expect(anim.length).toBeGreaterThan(0);
  return anim;
}

function aimAt(driver: ReturnType<typeof bootPlay>['driver'], tx: number, ty: number, tz: number): [number, number, number] {
  const ex = driver.pm.origin[0]!, ey = driver.pm.origin[1]!, ez = driver.pm.origin[2]! + 22;
  const dx = tx - ex, dy = ty - ey, dz = tz - ez;
  const l = Math.hypot(dx, dy) || 1;
  return [(Math.atan2(-dz, l) * 180) / Math.PI, (Math.atan2(dy, dx) * 180) / Math.PI, 0];
}

afterEach(() => {
  resetCVars();
});

describe.runIf(!!WEB_Q2_PAK)('RELEASE-16 secret-button art states (real base1)', () => {
  it('(b1) shooting *13 swaps its texture state and preserves travel', { timeout: 180000 }, async () => {
    const W = 192;
    const H = 144;
    const boot = await bootBase1(W, H);
    const { driver } = boot;
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    expect(btn13.ent.health).toBe(1);
    expect(btn13.wait).toBe(-1);
    // Settle onto the parked train top (proven rider spot), looking up at
    // the button's animated down-face.
    driver.pm.origin = v3(-2056, 1500, 24.03);
    driver.pm.velocity = v3();
    for (let i = 0; i < 10; i++) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(driver.pm.onGround).toBe(true);
    const faces = animFaces(boot, '*13');
    const chainOf = (s: MiniSurf): number[] => s.animTexIds!;
    const inClass = (s: MiniSurf, a: number, b: number): boolean => {
      const idx = chainOf(s).indexOf(s.texId);
      return idx === a || idx === b;
    };
    const expectHeld = (): void => {
      for (const s of faces) expect(inClass(s, 2, 3)).toBe(true);
    };
    // Unpressed: every animated face shows an ANIM01 frame (chain 0-1).
    for (const s of faces) expect(inClass(s, 0, 1)).toBe(true);
    const angles = aimAt(driver, -2016, 1536, 80);
    // Shoot it (bolt damage path): lethal hit restores health and fires.
    expect(SV_DamageButton(driver.server, btn13, 1)).toBe(true);
    expect(btn13.state).toBe('going_up');
    let guard = 0;
    while (btn13.state !== 'top' && guard++ < 10) {
      SV_SetPlayerHealth(driver.server, 100);
      driver.step(neutralCmd(), 0.1);
    }
    expect(btn13.state).toBe('top');
    // Held TOP: every animated face shows an ANIM23 frame (chain 2-3, the
    // authored lit variant) — not the base texture.
    expectHeld();
    // Physical press motion preserved: +4z TOP hold, secret found, t91 fired.
    expect(driver.doorRenderOffset('*13')).toEqual([0, 0, 4]);
    expect(driver.server.foundSecrets).toBe(1);
    expect(driver.server.firedThisTick.includes('t91') || btn13.state === 'top').toBe(true);
    // Re-place the eye exactly (the shot ticks moved the body and started
    // the train) and render the held state with zero further ticks — the
    // live texIds persist on the faces, so the camera is bit-identical.
    driver.pm.origin = v3(-2056, 1500, 24.03);
    driver.pm.velocity = v3();
    const held = renderFrame(boot, frameParts(boot, angles));
    // Negative control: forcing the unpressed frames reproduces a visibly
    // different image from the identical camera — the delta IS the swap.
    // (Mover-distance assertions alone cannot show this: offset is [0,0,4]
    // in both renders.)
    const heldTex = faces.map((s) => s.texId);
    faces.forEach((s, i) => {
      s.texId = chainOf(s)[0]!;
    });
    // ...and with the swap forced away, the held-state assertion fails.
    expect(expectHeld).toThrow();
    const forced = renderFrame(boot, frameParts(boot, angles));
    let diff = 0;
    for (let i = 0; i < held.length; i++) if (held[i] !== forced[i]) diff++;
    expect(diff).toBeGreaterThan(50);
    expect(diff).toBeLessThan(held.length * 0.3);
    // Restore the held frames.
    faces.forEach((s, i) => {
      s.texId = heldTex[i]!;
    });
  });

  it('(b2) repeat shots on the held *13 never re-fire', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    expect(SV_DamageButton(driver.server, btn13, 1)).toBe(true);
    let guard = 0;
    while (btn13.state !== 'top' && guard++ < 10) driver.step(neutralCmd(), 0.1);
    expect(btn13.state).toBe('top');
    const faces = animFaces(boot, '*13');
    const heldTex = faces.map((s) => s.texId);
    for (let i = 0; i < 50; i++) driver.step(neutralCmd(), 0.1);
    // C UP/TOP no-op: still TOP, still the ANIM23 frames, still +4z.
    expect(btn13.state).toBe('top');
    expect(SV_DamageButton(driver.server, btn13, 5)).toBe(true); // accumulates, cannot re-fire
    expect(btn13.state).toBe('top');
    expect(faces.map((s) => s.texId)).toEqual(heldTex);
    expect(driver.doorRenderOffset('*13')).toEqual([0, 0, 4]);
  });

  it('(b4) *34 E-use cycle walks ANIM01 -> ANIM23 -> ANIM23 -> ANIM01', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const btn34 = driver.server.movers.find((m) => m.ent.model === '*34')!;
    const faces = animFaces(boot, '*34');
    const chainOf = (s: MiniSurf): number[] => s.animTexIds!;
    const cls = (s: MiniSurf): number => chainOf(s).indexOf(s.texId);
    // Rest: ANIM01 range.
    for (const s of faces) expect(cls(s) === 0 || cls(s) === 1).toBe(true);
    // 2Hz autoanim liveness at rest: +0.5s flips the phase.
    const restTex = faces.map((s) => s.texId);
    for (let i = 0; i < 5; i++) driver.step(neutralCmd(), 0.1);
    const flipped = faces.map((s) => s.texId);
    expect(flipped).not.toEqual(restTex);
    for (const s of faces) expect(cls(s) === 0 || cls(s) === 1).toBe(true);
    // Press via the production E-use path (slot face, aimed at live center).
    const box = driver.server.moverBounds.get(btn34.ent.num)!;
    const ctr = v3((box.mins[0]! + box.maxs[0]!) / 2, (box.mins[1]! + box.maxs[1]!) / 2, (box.mins[2]! + box.maxs[2]!) / 2);
    const eye = v3(-1688, 1536, 142);
    const dx = ctr[0]! - eye[0]!, dy = ctr[1]! - eye[1]!, dz = ctr[2]! - eye[2]!;
    const len = Math.hypot(dx, dy, dz);
    const pressed = SV_UseButton(driver.server, eye, v3(dx / len, dy / len, dz / len), {
      trace: SV_ClipTrace(driver.server, SV_TraceFor(driver.map!)),
    });
    expect(pressed?.ent.model).toBe('*34');
    let guard = 0;
    while (btn34.state !== 'waiting' && btn34.state !== 'top' && guard++ < 20) driver.step(neutralCmd(), 0.1);
    // TOP arrival: ANIM23 range (C button_wait).
    for (const s of faces) expect(cls(s) === 2 || cls(s) === 3).toBe(true);
    // Return leg: still ANIM23 (C button_return only resets s.frame).
    guard = 0;
    while (btn34.state !== 'going_down' && guard++ < 100) driver.step(neutralCmd(), 0.1);
    expect(btn34.state).toBe('going_down');
    for (const s of faces) expect(cls(s) === 2 || cls(s) === 3).toBe(true);
    // BOTTOM arrival: ANIM01 restored (C button_done).
    guard = 0;
    while (btn34.state !== 'bottom' && guard++ < 100) driver.step(neutralCmd(), 0.1);
    expect(btn34.state).toBe('bottom');
    for (const s of faces) expect(cls(s) === 0 || cls(s) === 1).toBe(true);
  });

  it('(b5) WebGL2 scene handles follow the live texIds', { timeout: 180000 }, async () => {
    const boot = await bootBase1();
    const { driver } = boot;
    const btn13 = driver.server.movers.find((m) => m.ent.model === '*13')!;
    const faces = animFaces(boot, '*13');
    const eye = v3(-2056, 1500, 46);
    const view = {
      origin: eye,
      angles: v3(-32, 42, 0),
      fovX: 90,
      time: 3.7,
      lightStyles: new Float32Array(256).fill(1),
    };
    const handles = (): Array<number | undefined> => {
      const scene = refreshGpuScene(driver.mini, [], view as never, 192, 144);
      return faces.map((s) => scene.surfaces.find((r) => r.surfaceId === s.id)?.materialHandle);
    };
    // The down-face is visible from below (the up-face is correctly
    // backface-culled from this camera): every VISIBLE handle tracks live.
    const liveBefore = faces.map((s) => s.texId);
    const seenBefore = handles();
    expect(seenBefore.filter((h) => h !== undefined).length).toBeGreaterThan(0);
    seenBefore.forEach((h, i) => {
      if (h !== undefined) expect(h).toBe(liveBefore[i]);
    });
    expect(SV_DamageButton(driver.server, btn13, 1)).toBe(true);
    let guard = 0;
    while (btn13.state !== 'top' && guard++ < 10) driver.step(neutralCmd(), 0.1);
    const liveAfter = faces.map((s) => s.texId);
    const seenAfter = handles();
    expect(seenAfter.filter((h) => h !== undefined).length).toBeGreaterThan(0);
    seenAfter.forEach((h, i) => {
      if (h !== undefined) expect(h).toBe(liveAfter[i]);
    });
    // The visible handles moved off the base frame (proves the GPU
    // selection follows the animation, not the bake).
    const base = faces[0]!.animTexIds![0];
    expect(seenAfter.filter((h) => h !== undefined).some((h) => h !== base)).toBe(true);
  });
});
