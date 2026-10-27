// @q2/input/dom — browser-only bindings. Importing this module from Node
// is safe: every entry point no-ops when `document`/`window` are absent.
import { createInput, keyDown, keyUp, mouseMove } from './index.js';
import type { InputCore, LogicalKey } from './index.js';

const CODE_TO_KEY: Record<string, LogicalKey> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'moveleft',
  KeyD: 'moveright',
  Space: 'jump',
  KeyC: 'crouch',
  KeyE: 'use',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  PageUp: 'lookup',
  PageDown: 'lookdown',
  ShiftLeft: 'up',
  // Ctrl stays swim-down (`upmove -400`): crouch/duck lives on C so the
  // swim fast-descend binding is not lost. Drivers needing Ctrl-duck can
  // map ControlLeft to 'crouch' here instead.
  ControlLeft: 'down',
};

/** Browser code → logical key map (exported for tests; see note above). */
export { CODE_TO_KEY };

export interface DomBindings {
  input: InputCore;
  dispose(): void;
}

/**
 * Attach keyboard + mouse (+pointer lock on click) to a canvas element.
 * Uses `target` when given (e.g. a shared Host input core), otherwise
 * creates a fresh InputCore. Returns the core in use.
 * Safe no-op outside a browser.
 *
 * Input gating (canvas-locked only): mouse fire/look engage solely while
 * `document.pointerLockElement === canvas`. Mousedown on UI panels, the
 * lock-acquiring canvas click, and mousemove while unlocked are all
 * swallowed; lock loss (Esc) clears held fire/use via `pointerlockchange`.
 * Mouseup stays document-global so a release anywhere always clears.
 * Keyboard flow is unaffected (document-level, lock-independent).
 */
export function attachToCanvas(canvas: unknown, target?: InputCore): DomBindings {
  const input = target ?? createInput();
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { input, dispose(): void { /* noop */ } };
  }
  const el = canvas as HTMLElement;
  // Pointer-lock gate: game mouse input (fire + look) engages ONLY while
  // the pointer is locked ON THE CANVAS. Clicks on UI panels (the cvar
  // config menu, dropdowns, buttons) never satisfy this, so they can never
  // become game input — no stray +attack, no look jump, no lock disturbance.
  const isLockedToCanvas = (): boolean =>
    typeof document !== 'undefined' && document.pointerLockElement === el;
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'KeyM' && e.repeat) return;
    const k = CODE_TO_KEY[e.code];
    if (k) {
      keyDown(input, k);
      e.preventDefault();
    }
    if (e.code === 'Mouse0') keyDown(input, 'attack');
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    const k = CODE_TO_KEY[e.code];
    if (k) keyUp(input, k);
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (!isLockedToCanvas()) return;
    mouseMove(input, e.movementX, e.movementY);
  };
  // Canvas-locked only: the acquire-lock click on the canvas is swallowed
  // (it engages pointer lock via onClick, it must not also fire), and UI
  // clicks never reach here as game input because the lock is never held
  // on a panel element.
  const onMouseDown = (e: MouseEvent): void => {
    if (!isLockedToCanvas()) return;
    if (e.button === 0) keyDown(input, 'attack');
    if (e.button === 2) keyDown(input, 'use');
  };
  const onMouseUp = (e: MouseEvent): void => {
    // Ungated on purpose: release must always clear, wherever the button
    // comes up (dragged off-canvas, lock lost mid-hold, Esc menu, ...).
    if (e.button === 0) keyUp(input, 'attack');
    if (e.button === 2) keyUp(input, 'use');
  };
  // Esc / lock loss must release fire cleanly: without this, a button held
  // when the lock drops (Esc opens the config menu, focus moves to a panel)
  // would stick +attack on until the next canvas mousedown.
  const onLockChange = (): void => {
    if (!isLockedToCanvas()) {
      keyUp(input, 'attack');
      keyUp(input, 'use');
    }
  };
  const onClick = (): void => {
    if (el.requestPointerLock) {
      try {
        el.requestPointerLock();
      } catch {
        /* pointer lock unavailable (iframe/permissions) */
      }
    }
  };
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('pointerlockchange', onLockChange);
  el.addEventListener('click', onClick);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return {
    input,
    dispose(): void {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('pointerlockchange', onLockChange);
      el.removeEventListener('click', onClick);
    },
  };
}

/** Snapshot browser gamepads into GamepadLike (null when absent). */
export function pollBrowserGamepads(index = 0): import('./index.js').GamepadLike | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  const p = pads[index];
  if (!p) return null;
  return {
    axes: Array.from(p.axes),
    buttons: Array.from(p.buttons, (b) => ({ pressed: b.pressed })),
  };
}
