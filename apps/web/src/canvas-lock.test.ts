// Canvas-locked input regression test (config-menu click must not fire).
//
// DOM-light: installs minimal fake `document`/`window` globals around
// `attachToCanvas` (no IndexedDB, no real DOM), dispatches synthetic
// mousedown/mousemove/pointerlockchange on a fake config panel vs the fake
// canvas, and asserts only canvas interaction produces game input.
// Headless-safe: globals are restored after each test, Node imports stay
// side-effect free.
import { afterEach, describe, expect, it } from 'vitest';
import { BUTTON_ATTACK, buildUserCmd, createInput } from '@q2/input';
import { attachToCanvas } from '@q2/input/dom';

type FakeListener = (e: unknown) => void;

class FakeBus {
  private handlers = new Map<string, FakeListener[]>();

  addEventListener(type: string, fn: FakeListener): void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }

  removeEventListener(type: string, fn: FakeListener): void {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== fn));
  }

  dispatch(type: string, event: unknown): void {
    for (const fn of this.handlers.get(type) ?? []) fn(event);
  }

  count(type: string): number {
    return this.handlers.get(type)?.length ?? 0;
  }
}

class FakeDocument extends FakeBus {
  pointerLockElement: unknown = null;
}

class FakeCanvas extends FakeBus {
  requestPointerLockCalls = 0;

  requestPointerLock(): void {
    this.requestPointerLockCalls += 1;
  }
}

function mouseEvent(init: {
  button?: number;
  movementX?: number;
  movementY?: number;
  target?: unknown;
  code?: string;
}): MouseEvent {
  return {
    preventDefault(): void {
      /* fake */
    },
    ...init,
  } as unknown as MouseEvent;
}

interface Harness {
  doc: FakeDocument;
  canvas: FakeCanvas;
  panel: FakeBus;
  prevDocument: unknown;
  prevWindow: unknown;
}

function install(): Harness {
  const g = globalThis as unknown as { document?: unknown; window?: unknown };
  const prevDocument = g.document;
  const prevWindow = g.window;
  const doc = new FakeDocument();
  const canvas = new FakeCanvas();
  const panel = new FakeBus();
  g.document = doc;
  g.window = {};
  return { doc, canvas, panel, prevDocument, prevWindow };
}

afterEach(() => {
  const g = globalThis as unknown as { document?: unknown; window?: unknown };
  // Restored by each test's own finally; this is a backstop so a failure
  // cannot leak fakes into sibling test files in the same worker.
  if (g.document instanceof FakeDocument) g.document = undefined;
});

describe('canvas-locked pointer/input (config-menu clicks never fire)', () => {
  it('mousedown on the config panel never fires and never requests lock', () => {
    const h = install();
    try {
      const input = createInput();
      const bindings = attachToCanvas(h.canvas, input);
      try {
        // Panel click while unlocked: the pre-fix document-level mousedown
        // listener turned this into +attack.
        h.doc.dispatch('mousedown', mouseEvent({ button: 0, target: h.panel }));
        expect(input.buttons & BUTTON_ATTACK).toBe(0);
        h.doc.dispatch('mousedown', mouseEvent({ button: 2, target: h.panel }));
        expect(buildUserCmd(input, 16).buttons & BUTTON_ATTACK).toBe(0);
        // Right-button panel click is not a `use` either.
        expect(buildUserCmd(input, 16).buttons).toBe(0);
        // No pointer-lock request originates from the panel path.
        expect(h.canvas.requestPointerLockCalls).toBe(0);
        // Unlocked mouse motion never turns the view (no look jump).
        h.doc.dispatch('mousemove', mouseEvent({ movementX: 50, movementY: 25, target: h.panel }));
        expect(buildUserCmd(input, 16).angles).toEqual([0, 0, 0]);
      } finally {
        bindings.dispose();
      }
    } finally {
      const g = globalThis as unknown as { document?: unknown; window?: unknown };
      g.document = h.prevDocument;
      g.window = h.prevWindow;
    }
  });

  it('canvas click requests lock but the acquiring click does not fire', () => {
    const h = install();
    try {
      const input = createInput();
      const bindings = attachToCanvas(h.canvas, input);
      try {
        h.canvas.dispatch('click', mouseEvent({ target: h.canvas }));
        expect(h.canvas.requestPointerLockCalls).toBe(1);
        // Lock not yet granted: the acquiring mousedown is swallowed.
        h.doc.dispatch('mousedown', mouseEvent({ button: 0, target: h.canvas }));
        expect(input.buttons & BUTTON_ATTACK).toBe(0);
      } finally {
        bindings.dispose();
      }
    } finally {
      const g = globalThis as unknown as { document?: unknown; window?: unknown };
      g.document = h.prevDocument;
      g.window = h.prevWindow;
    }
  });

  it('locked canvas mousedown fires + looks; unlock (Esc) releases fire cleanly', () => {
    const h = install();
    try {
      const input = createInput();
      const bindings = attachToCanvas(h.canvas, input);
      try {
        // Simulate the lock grant after the canvas click.
        h.doc.pointerLockElement = h.canvas;
        h.doc.dispatch('mousedown', mouseEvent({ button: 0, target: h.canvas }));
        expect(input.buttons & BUTTON_ATTACK).toBeTruthy();
        // Locked look applies mouse deltas to the view.
        h.doc.dispatch('mousemove', mouseEvent({ movementX: 10, movementY: 0, target: h.canvas }));
        const cmd = buildUserCmd(input, 16);
        expect(cmd.angles[1]).not.toBe(0);
        // Esc: lock drops while the button is still held -> no stuck attack.
        h.doc.pointerLockElement = null;
        h.doc.dispatch('pointerlockchange', {});
        expect(input.buttons & BUTTON_ATTACK).toBe(0);
        // And post-unlock UI clicks stay inert.
        h.doc.dispatch('mousedown', mouseEvent({ button: 0, target: h.panel }));
        expect(input.buttons & BUTTON_ATTACK).toBe(0);
      } finally {
        bindings.dispose();
      }
    } finally {
      const g = globalThis as unknown as { document?: unknown; window?: unknown };
      g.document = h.prevDocument;
      g.window = h.prevWindow;
    }
  });

  it('keyboard flow is lock-independent and dispose removes listeners', () => {
    const h = install();
    try {
      const input = createInput();
      const bindings = attachToCanvas(h.canvas, input);
      try {
        // Keyboard movement works with no lock held (menu open, pre-click).
        h.doc.dispatch('keydown', mouseEvent({ code: 'KeyW' }));
        expect(buildUserCmd(input, 16).forwardmove).toBe(400);
        h.doc.dispatch('keyup', mouseEvent({ code: 'KeyW' }));
        expect(buildUserCmd(input, 16).forwardmove).toBe(0);
      } finally {
        bindings.dispose();
      }
      expect(h.doc.count('mousedown')).toBe(0);
      expect(h.doc.count('pointerlockchange')).toBe(0);
      expect(h.doc.count('keydown')).toBe(0);
    } finally {
      const g = globalThis as unknown as { document?: unknown; window?: unknown };
      g.document = h.prevDocument;
      g.window = h.prevWindow;
    }
  });
});
