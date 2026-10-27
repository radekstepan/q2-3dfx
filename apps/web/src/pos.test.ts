// Player-position in-canvas readout (HUD lane): top-left conchars glyphs,
// gated by `cl_showpos` (default ON), checkbox in the menu panel.
// Headless-safe: DOM-light fake `document` around `renderCvarPanel` (same
// pattern as canvas-lock.test.ts); globals restored after each test. Glyph
// pixels are asserted on headless framebuffers (same pattern as the fps
// lane): no DOM overlay owns the readout anymore.
import { afterEach, describe, expect, it } from 'vitest';
import { getCVarNumber, getCVarString, resetCVars, setCVar } from '@q2/config';
import { bootPlay, drawPlayHud, formatPlayerPos, playerPosText, posHudAnchor, posVisible, POS_GREY } from './play.js';
import { CHECKBOX_CVARS, cvarControlKind, cvarDescription, cvarIsCheckbox, renderCvarPanel, showPosEnabled } from './dom.js';

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

  it('formatPlayerPos is pure: x y z at 1 decimal (no yaw)', () => {
    expect(formatPlayerPos(1.234, -2.26, 32)).toBe('pos 1.2 -2.3 32.0');
    expect(formatPlayerPos(0, 0, 0)).toBe('pos 0.0 0.0 0.0');
    expect(formatPlayerPos(-168, 0, 32)).toBe('pos -168.0 0.0 32.0');
  });

  it('playerPosText reads the live driver origin (per-frame source)', () => {
    const boot = bootPlay({ width: 64, height: 48 });
    const { driver } = boot;
    const text = playerPosText(driver);
    expect(text).toBe(
      formatPlayerPos(driver.pm.origin[0]!, driver.pm.origin[1]!, driver.pm.origin[2]!),
    );
    expect(text).toMatch(/^pos -?\d+\.\d -?\d+\.\d -?\d+\.\d$/);
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
      // Pos text starts at (8, 8); struck glyph pixels are POS_GREY.
      expect(countIn(target.color, 320, 8, 8, 320, 16, POS_GREY)).toBeGreaterThan(10);
      // Nothing grey leaks into the lower HUD rows.
      expect(countIn(target.color, 320, 0, 16, 320, 240, POS_GREY)).toBe(0);
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
      expect(target.color.some((c) => c === POS_GREY)).toBe(false);
    } finally {
      resetCVars();
    }
  });

  it('every boolean cvar renders as a checkbox (no 0/1 selects left)', () => {
    for (const name of CHECKBOX_CVARS) {
      expect(cvarIsCheckbox(name)).toBe(true);
      expect(cvarControlKind(name)).toBe('checkbox');
    }
    expect(cvarControlKind('cl_showpos')).toBe('checkbox');
    expect(cvarControlKind('cl_showfps')).toBe('checkbox');
    expect(cvarControlKind('vd_dither')).toBe('checkbox');
    expect(cvarControlKind('r_drawworld')).toBe('checkbox');
    expect(cvarControlKind('cl_predict')).toBe('checkbox');
    // Non-booleans keep their controls.
    expect(cvarControlKind('sw_workers')).toBe('select');
    expect(cvarControlKind('r_brightness')).toBe('select');
    expect(cvarControlKind('vd_gamma')).toBe('select');
  });

  it('every menu row carries an on-hover description (tooltip source: cvar docs)', () => {
    for (const name of CHECKBOX_CVARS) {
      expect(cvarDescription(name).length).toBeGreaterThan(0);
    }
    expect(cvarDescription('cl_showpos')).toContain('pos X Y Z');
    expect(cvarDescription('vd_dither')).toContain('dither');
    expect(cvarDescription('r_drawworld')).toContain('world geometry');
    expect(cvarDescription('cl_predict')).toContain('10Hz');
    expect(cvarDescription('no_such_cvar')).toBe('');
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

  it('toggling ANY checkbox fires nothing, requests no lock, leaves no listeners', () => {
    const { doc, prev } = install();
    try {
      resetCVars();
      const container = new FakeContainer();
      const seen: Array<[string, string]> = [];
      const names = renderCvarPanel(container, '', (n, v) => seen.push([n, v]));
      for (const name of CHECKBOX_CVARS) {
        if (!names.includes(name)) continue; // lazily registered: pinned statically above
        const row = container.children.find((r) => r.children[0]?.textContent === name);
        expect(row).toBeDefined();
        const box = row!.children[1]!;
        expect(box.type).toBe('checkbox');
        const initial = getCVarString(name);
        const flipped = initial === '1' ? '0' : '1';
        box.checked = flipped === '1';
        box.dispatch('change');
        expect(getCVarString(name)).toBe(flipped);
        expect(seen).toContainEqual([name, flipped]);
        // Restore the pre-test value (no resetCVars: it would unregister
        // lazily-registered span switches in this headless env).
        box.checked = initial === '1';
        box.dispatch('change');
        expect(getCVarString(name)).toBe(initial);
      }
      // Still no document-level wiring of any kind: no mousedown/click that
      // could become +attack, no pointer-lock request path from the panel.
      for (const type of ['mousedown', 'mouseup', 'click', 'pointerlockchange', 'mousemove']) {
        expect(doc.docListeners.get(type) ?? []).toHaveLength(0);
      }
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('checkbox rows expose their description as a title tooltip', () => {
    const { prev } = install();
    try {
      resetCVars();
      const container = new FakeContainer();
      renderCvarPanel(container, '', () => undefined);
      const row = container.children.find((r) => r.children[0]?.textContent === 'cl_showpos');
      expect(row).toBeDefined();
      expect((row as unknown as { title?: string }).title).toContain('pos X Y Z');
      expect((row!.children[0] as unknown as { title?: string }).title).toContain('pos X Y Z');
      expect((row!.children[1] as unknown as { title?: string }).title).toContain('pos X Y Z');
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });
});
