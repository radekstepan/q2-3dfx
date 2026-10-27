// Player-position in-canvas readout (HUD lane): top-left conchars glyphs,
// gated by `cl_showpos` (default ON), checkbox in the menu panel.
// Headless-safe: DOM-light fake `document` around `renderCvarPanel` (same
// pattern as canvas-lock.test.ts); globals restored after each test. Glyph
// pixels are asserted on headless framebuffers (same pattern as the fps
// lane): no DOM overlay owns the readout anymore.
import { afterEach, describe, expect, it } from 'vitest';
import { getCVarNumber, resetCVars, setCVar } from '@q2/config';
import { bootPlay, drawPlayHud, formatPlayerPos, playerPosText, posHudAnchor, posVisible, POS_YELLOW } from './play.js';
import { cvarControlKind, cvarIsCheckbox, renderCvarPanel, showPosEnabled } from './dom.js';

afterEach(() => {
  resetCVars();
  const g = globalThis as unknown as { document?: unknown };
  if (g.document instanceof FakeDocument) g.document = undefined;
});

type Listener = (e?: unknown) => void;

class FakeElement {
  children: FakeElement[] = [];
  listeners = new Map<string, Listener[]>();
  className = '';
  textContent = '';
  value = '';
  type = '';
  checked = false;
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  appendChild(child: FakeElement): void {
    this.children.push(child);
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  set innerHTML(_v: string) {
    this.children = [];
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({});
  }
}

class FakeContainer extends FakeElement {
  constructor() {
    super('div');
  }
}

class FakeDocument {
  docListeners = new Map<string, Listener[]>();
  created: FakeElement[] = [];
  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag);
    this.created.push(el);
    return el;
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.docListeners.get(type) ?? [];
    list.push(fn);
    this.docListeners.set(type, list);
  }
  querySelector(_sel: string): null {
    return null;
  }
}

function install(): { doc: FakeDocument; prev: unknown } {
  const g = globalThis as unknown as { document?: unknown };
  const prev = g.document;
  const doc = new FakeDocument();
  g.document = doc;
  return { doc, prev };
}

/** Count pixels of one colour inside a rectangle (headless glyph assertion). */
function countIn(
  color: Uint32Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgba: number,
): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (color[y * width + x] === rgba) n++;
    }
  }
  return n;
}

describe('player position readout (in-canvas conchars, top-left, cl_showpos)', () => {
  it('posHudAnchor pins the top-left slot (8px margins)', () => {
    expect(posHudAnchor()).toEqual({ x: 8, y: 8 });
  });

  it('formatPlayerPos is pure: x y z + yaw at 1 decimal', () => {
    expect(formatPlayerPos(1.234, -2.26, 32, 90)).toBe('pos 1.2 -2.3 32.0 yaw 90.0');
    expect(formatPlayerPos(0, 0, 0, 0)).toBe('pos 0.0 0.0 0.0 yaw 0.0');
    expect(formatPlayerPos(-168, 0, 32, -0.04)).toBe('pos -168.0 0.0 32.0 yaw 0.0');
  });

  it('playerPosText reads the live driver origin + yaw (per-frame source)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    const text = playerPosText(driver);
    expect(text).toBe(
      formatPlayerPos(driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]!, driver.pm.viewAngles[1]!),
    );
    expect(text).toMatch(/^pos -?\d+\.\d -?\d+\.\d -?\d+\.\d yaw -?\d+\.\d$/);
  });

  it('cl_showpos gates the readout (default ON)', () => {
    resetCVars();
    // Registered by dom.ts import with default 1.
    expect(showPosEnabled()).toBe(true);
    expect(posVisible()).toBe(true);
    setCVar('cl_showpos', 0);
    expect(showPosEnabled()).toBe(false);
    expect(posVisible()).toBe(false);
    setCVar('cl_showpos', 1);
    expect(showPosEnabled()).toBe(true);
    expect(posVisible()).toBe(true);
  });

  it('drawPlayHud paints yellow conchars glyphs top-left when enabled', () => {
    resetCVars();
    try {
      const boot = bootPlay({ width: 320, height: 240 });
      setCVar('cl_showpos', 1);
      const target = { width: 320, height: 240, color: new Uint32Array(320 * 240) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      // Pos text starts at (8, 8); struck glyph pixels are POS_YELLOW.
      expect(countIn(target.color, 320, 8, 8, 320, 16, POS_YELLOW)).toBeGreaterThan(10);
      // Nothing yellow leaks into the lower HUD rows.
      expect(countIn(target.color, 320, 0, 16, 320, 240, POS_YELLOW)).toBe(0);
    } finally {
      resetCVars();
    }
  });

  it('drawPlayHud paints no pos pixels when gated', () => {
    resetCVars();
    try {
      const boot = bootPlay({ width: 320, height: 240 });
      setCVar('cl_showpos', 0);
      const target = { width: 320, height: 240, color: new Uint32Array(320 * 240) };
      drawPlayHud(target, boot, { fps: 60, frame: 1 });
      expect(target.color.some((c) => c === POS_YELLOW)).toBe(false);
    } finally {
      resetCVars();
    }
  });

  it('cl_showpos renders as a checkbox (cl_showfps keeps its select)', () => {
    expect(cvarIsCheckbox('cl_showpos')).toBe(true);
    expect(cvarControlKind('cl_showpos')).toBe('checkbox');
    expect(cvarControlKind('cl_showfps')).toBe('select');
  });

  it('checkbox toggles the cvar via element-local change (never document mouse)', () => {
    const { doc, prev } = install();
    try {
      resetCVars();
      const container = new FakeContainer();
      const seen: Array<[string, string]> = [];
      const names = renderCvarPanel(container, '', (n, v) => seen.push([n, v]));
      expect(names).toContain('cl_showpos');
      // No document-level mouse wiring: UI clicks can never become game
      // input (canvas pointer-lock discipline holds).
      expect(doc.docListeners.get('mousedown') ?? []).toHaveLength(0);
      // Find the cl_showpos row (label + checkbox control).
      const rows = container.children;
      const row = rows.find((r) => r.children[0]?.textContent === 'cl_showpos');
      expect(row).toBeDefined();
      const box = row!.children[1]!;
      expect(box.type).toBe('checkbox');
      expect(box.checked).toBe(true); // default ON
      // Uncheck -> cvar 0 + onChange fires with the bare value.
      box.checked = false;
      box.dispatch('change');
      expect(getCVarNumber('cl_showpos')).toBe(0);
      expect(seen).toContainEqual(['cl_showpos', '0']);
      expect(showPosEnabled()).toBe(false);
      expect(posVisible()).toBe(false);
      // Re-check -> cvar 1.
      box.checked = true;
      box.dispatch('change');
      expect(getCVarNumber('cl_showpos')).toBe(1);
      expect(seen).toContainEqual(['cl_showpos', '1']);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });
});
