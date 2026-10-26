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
 */
export function attachToCanvas(canvas: unknown, target?: InputCore): DomBindings {
  const input = target ?? createInput();
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { input, dispose(): void { /* noop */ } };
  }
  const el = canvas as HTMLElement;
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
    const locked =
      typeof document !== 'undefined' && document.pointerLockElement === el;
    if (!locked) return;
    mouseMove(input, e.movementX, e.movementY);
  };
  const onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) keyDown(input, 'attack');
    if (e.button === 2) keyDown(input, 'use');
  };
  const onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) keyUp(input, 'attack');
    if (e.button === 2) keyUp(input, 'use');
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
