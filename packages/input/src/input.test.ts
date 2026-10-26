import { describe, expect, it } from 'vitest';
import {
  BUTTON_ATTACK,
  BUTTON_DUCK,
  BUTTON_JUMP,
  applyGamepad,
  buildUserCmd,
  cmdToInputState,
  createInput,
  emptyInput,
  isDuckHeld,
  keyDown,
  keyUp,
  mouseMove,
} from './index.js';

describe('input -> usercmd_t mapping', () => {
  it('keys map to Q2 move speeds (+forward/-back, strafe, up)', () => {
    const input = createInput();
    keyDown(input, 'forward');
    keyDown(input, 'moveleft');
    const cmd = buildUserCmd(input, 16);
    expect(cmd.forwardmove).toBe(400);
    expect(cmd.sidemove).toBe(-400);
    expect(cmd.msec).toBe(16);
  });

  it('opposing keys cancel out', () => {
    const input = createInput();
    keyDown(input, 'forward');
    keyDown(input, 'back');
    expect(buildUserCmd(input, 16).forwardmove).toBe(0);
    keyUp(input, 'forward');
    expect(buildUserCmd(input, 16).forwardmove).toBe(-400);
  });

  it('mouse deltas turn yaw/pitch and are consumed', () => {
    const input = createInput();
    mouseMove(input, 100, -50);
    const cmd = buildUserCmd(input, 16, { sensitivity: 3, mYaw: 0.022, mPitch: 0.022 });
    expect(cmd.angles[1]).toBeCloseTo(-6.6, 9);
    expect(cmd.angles[0]).toBeCloseTo(-3.3, 9);
    // Second build without motion holds angles.
    const again = buildUserCmd(input, 16, { sensitivity: 3, mYaw: 0.022, mPitch: 0.022 });
    expect(again.angles).toEqual(cmd.angles);
  });

  it('pitch clamps at +/-89 degrees', () => {
    const input = createInput();
    mouseMove(input, 0, 100000);
    const cmd = buildUserCmd(input, 16, { sensitivity: 3, mYaw: 0.022, mPitch: 0.022 });
    expect(cmd.angles[0]).toBe(89);
  });

  it('attack/use/jump set button bits', () => {
    const input = createInput();
    keyDown(input, 'attack');
    keyDown(input, 'jump');
    const cmd = buildUserCmd(input, 16);
    expect(cmd.buttons & BUTTON_ATTACK).toBeTruthy();
    expect(cmd.buttons & BUTTON_JUMP).toBeTruthy();
    keyUp(input, 'attack');
    expect(buildUserCmd(input, 16).buttons & BUTTON_ATTACK).toBe(0);
  });

  it('gamepad right stick looks, buttons map to jump/attack', () => {
    const input = createInput();
    applyGamepad(
      input,
      { axes: [0.5, 0, 1, 0], buttons: [{ pressed: true }, { pressed: false }] },
      { sensitivity: 3, mYaw: 0.022, mPitch: 0.022 },
    );
    expect(input.angles[1]).toBeLessThan(0);
    expect(input.buttons & BUTTON_JUMP).toBeTruthy();
    const cmd = buildUserCmd(input, 16);
    expect(cmd.sidemove).toBe(200);
  });

  it('gamepad dead zone ignores drift', () => {
    const input = createInput();
    const before: [number, number, number] = [...input.angles];
    applyGamepad(input, { axes: [0.05, 0, 0, 0], buttons: [] });
    expect(input.angles).toEqual(before);
  });

  it('crouch/duck hold sets BUTTON_DUCK without moving', () => {
    const input = createInput();
    keyDown(input, 'crouch');
    const cmd = buildUserCmd(input, 16);
    expect(cmd.buttons & BUTTON_DUCK).toBeTruthy();
    expect(isDuckHeld(cmd)).toBe(true);
    // Duck is a hold, not locomotion: no move speeds leak into the cmd.
    expect(cmd.forwardmove).toBe(0);
    expect(cmd.sidemove).toBe(0);
    expect(cmd.upmove).toBe(0);
    keyUp(input, 'crouch');
    const released = buildUserCmd(input, 16);
    expect(released.buttons & BUTTON_DUCK).toBe(0);
    expect(isDuckHeld(released)).toBe(false);
  });

  it('duck is an alias for the same crouch hold', () => {
    const input = createInput();
    keyDown(input, 'duck');
    expect(isDuckHeld(buildUserCmd(input, 16))).toBe(true);
    // Releasing one alias while the other is held keeps the hold.
    keyDown(input, 'crouch');
    keyUp(input, 'duck');
    expect(isDuckHeld(buildUserCmd(input, 16))).toBe(true);
    keyUp(input, 'crouch');
    expect(isDuckHeld(buildUserCmd(input, 16))).toBe(false);
  });

  it('legacy InputState conversion keeps yaw/pitch/buttons', () => {
    expect(emptyInput()).toEqual({ forward: 0, side: 0, yaw: 0, pitch: 0, buttons: 0 });
    const input = createInput();
    keyDown(input, 'forward');
    const st = cmdToInputState(buildUserCmd(input, 16));
    expect(st.forward).toBe(400);
  });
});

describe('dom bindings (headless no-op)', () => {
  it('attachToCanvas uses a caller-supplied core and no-ops without DOM', async () => {
    const { attachToCanvas } = await import('./dom.js');
    const target = createInput();
    const bound = attachToCanvas({}, target);
    expect(bound.input).toBe(target);
    bound.dispose();
    const fresh = attachToCanvas({});
    expect(fresh.input).not.toBe(target);
    fresh.dispose();
  });

  it('KeyC maps to crouch, Ctrl stays swim-down', async () => {
    const { CODE_TO_KEY } = await import('./dom.js');
    expect(CODE_TO_KEY['KeyC']).toBe('crouch');
    // Ctrl is kept as swim-down (upmove), not stolen by duck.
    expect(CODE_TO_KEY['ControlLeft']).toBe('down');
  });
});
