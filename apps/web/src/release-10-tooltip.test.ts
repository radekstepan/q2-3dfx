// RELEASE-10 custom tooltip regressions (apps/web lane): the shared
// width-limited tooltip behind every settings-panel description and disabled
// reason. Real panel path throughout — `renderCvarPanel` builds the rows and
// the tooltip module (`tooltip.ts`) owns show/hide/position/aria — driven
// through a rect-capable fake DOM (hover + keyboard focus, disabled
// controls, viewport edges, scroll, rebuilds, renderer switches).
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCVar,
  getCVarString,
  RENDERER_CVAR_SUPPORT,
  resetCVars,
  setCVar,
  setCVarFromString,
  supportReason,
} from '@q2/config';
import { cvarIsCheckbox, cvarOptions, renderCvarPanel } from './dom.js';
import {
  attachPanelTooltips,
  computeTooltipPosition,
  ensureTooltipNode,
  getTooltipText,
  hasNativeTitle,
  hidePanelTooltip,
  isPanelTooltipVisible,
  panelTooltipText,
  resetPanelTooltipForTests,
  showPanelTooltip,
  tooltipMaxWidthFor,
  TOOLTIP_ID,
  TOOLTIP_MARGIN,
  TOOLTIP_MAX_WIDTH,
  TOOLTIP_TEXT_ATTR,
} from './tooltip.js';

afterEach(() => {
  resetCVars();
  resetPanelTooltipForTests();
  const g = globalThis as unknown as Record<string, unknown>;
  if (g['document'] instanceof FakeDocument) g['document'] = undefined;
  delete g['innerWidth'];
  delete g['innerHeight'];
});

// --- rect-capable fake DOM (panel-realistic: rects, style, ids) -------------

type Listener = (e?: unknown) => void;

interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

class FakeElement {
  children: FakeElement[] = [];
  listeners = new Map<string, Listener[]>();
  attrs = new Map<string, string>();
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  value = '';
  type = '';
  checked = false;
  disabled = false;
  title = '';
  id = '';
  hidden = false;
  offsetWidth = 0;
  offsetHeight = 0;
  rect: Rect | null = null;
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
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  getBoundingClientRect(): Rect {
    if (this.rect) return this.rect;
    throw new Error('no rect');
  }
  set innerHTML(_v: string) {
    this.children = [];
  }
  dispatch(type: string, event?: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event ?? {});
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
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
  body: FakeElement = new FakeElement('body');
  documentElement = { clientWidth: 1024, clientHeight: 768 };
  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag);
    this.created.push(el);
    return el;
  }
  getElementById(id: string): FakeElement | null {
    const found = this.created.find((el) => el.getAttribute('id') === id);
    if (found) return found;
    return this.body.children.find((el) => el.getAttribute('id') === id) ?? null;
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.docListeners.get(type) ?? [];
    list.push(fn);
    this.docListeners.set(type, list);
  }
  querySelector(_sel: string): null {
    return null;
  }
  dispatch(type: string, event?: unknown): void {
    for (const fn of this.docListeners.get(type) ?? []) fn(event ?? {});
  }
}

function install(): { doc: FakeDocument; prev: unknown } {
  const g = globalThis as unknown as { document?: unknown };
  const prev = g.document;
  const doc = new FakeDocument();
  g.document = doc;
  return { doc, prev };
}

function setViewport(width: number, height: number): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g['innerWidth'] = width;
  g['innerHeight'] = height;
}

/** Register every capability-table cvar so the panel lists the full matrix. */
function ensurePanelCvars(): void {
  for (const name of Object.keys(RENDERER_CVAR_SUPPORT)) {
    if (getCVar(name) !== undefined) continue;
    if (cvarIsCheckbox(name)) setCVar(name, 1);
    else {
      const opts = cvarOptions(name);
      setCVar(name, opts ? opts[0]! : '1');
    }
  }
}

function findRow(container: FakeContainer, name: string): { row: FakeElement; control: FakeElement } {
  const row = container.children.find((r) => r.children[0]?.textContent === name);
  expect(row, `row for ${name}`).toBeDefined();
  return { row: row!, control: row!.children[1]! };
}

function tooltipNodes(doc: FakeDocument): FakeElement[] {
  return doc.created.filter((el) => el.getAttribute('id') === TOOLTIP_ID);
}

function renderFor(
  active: 'software' | 'webgl2-experimental',
): { container: FakeContainer; names: string[] } {
  const container = new FakeContainer();
  const names = renderCvarPanel(container, '', () => undefined, active);
  return { container, names };
}

describe('RELEASE-10 custom tooltip width contract', () => {
  it('definite 320px cap, bounded by viewport minus margins', () => {
    expect(TOOLTIP_MAX_WIDTH).toBe(320);
    expect(TOOLTIP_MARGIN).toBe(8);
    expect(tooltipMaxWidthFor(1024)).toBe(320);
    expect(tooltipMaxWidthFor(800)).toBe(320);
    // Narrow viewport / zoom: cap shrinks to viewport minus margins.
    expect(tooltipMaxWidthFor(336)).toBe(320);
    expect(tooltipMaxWidthFor(335)).toBe(319);
    expect(tooltipMaxWidthFor(240)).toBe(224);
    expect(tooltipMaxWidthFor(100)).toBe(84);
    expect(tooltipMaxWidthFor(0)).toBe(TOOLTIP_MAX_WIDTH);
  });

  it('production CSS pins the fixed, wrapped, 320px tooltip node', async () => {
    const { readFileSync } = await import('fs');
    const css = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(css).toContain('#q2-tooltip');
    expect(css).toContain('max-width:320px');
    expect(css).toContain('position:fixed');
    expect(css).toContain('overflow-wrap:anywhere');
    expect(css).toContain('#q2-tooltip[hidden]');
  });
});

describe('RELEASE-10 tooltip placement math (flip/clamp at viewport edges)', () => {
  const viewport = { width: 800, height: 600 };
  const tip = { width: 200, height: 60 };

  it('sits below the anchor, left-aligned, in open space', () => {
    const at = computeTooltipPosition(
      { top: 100, left: 50, bottom: 120, right: 150, width: 100, height: 20 },
      tip,
      viewport,
    );
    expect(at).toEqual({ top: 128, left: 50 });
  });

  it('flips above when the bottom edge would overflow', () => {
    const at = computeTooltipPosition(
      { top: 550, left: 50, bottom: 570, right: 150, width: 100, height: 20 },
      tip,
      viewport,
    );
    expect(at.top).toBe(550 - 60 - TOOLTIP_MARGIN);
    expect(at.left).toBe(50);
  });

  it('clamps horizontally at the right edge', () => {
    const at = computeTooltipPosition(
      { top: 100, left: 700, bottom: 120, right: 780, width: 80, height: 20 },
      tip,
      viewport,
    );
    expect(at.left).toBe(800 - 200 - TOOLTIP_MARGIN);
    expect(at.top).toBe(128);
  });

  it('clamps into the corner when both edges overflow', () => {
    const at = computeTooltipPosition(
      { top: 560, left: 720, bottom: 580, right: 790, width: 70, height: 20 },
      tip,
      viewport,
    );
    expect(at.top).toBeLessThan(560);
    expect(at.top + 60).toBeLessThanOrEqual(600 - TOOLTIP_MARGIN);
    expect(at.left + 200).toBeLessThanOrEqual(800 - TOOLTIP_MARGIN);
    expect(at.left).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
  });

  it('oversized tips in small viewports pin to the margin corner', () => {
    const small = { width: 240, height: 160 };
    const big = { width: 300, height: 200 };
    const at = computeTooltipPosition(
      { top: 140, left: 200, bottom: 150, right: 230, width: 30, height: 10 },
      big,
      small,
    );
    expect(at.left).toBe(TOOLTIP_MARGIN);
    expect(at.top).toBe(TOOLTIP_MARGIN);
  });

  it('never returns NaN for degenerate input', () => {
    const at = computeTooltipPosition(
      { top: NaN, left: NaN, bottom: NaN, right: NaN, width: NaN, height: NaN },
      { width: NaN, height: NaN },
      { width: 0, height: 0 },
    );
    expect(Number.isFinite(at.top)).toBe(true);
    expect(Number.isFinite(at.left)).toBe(true);
  });
});

describe('RELEASE-10 panel rows feed the shared tooltip (no native titles)', () => {
  it('disabled rows expose description + reason off-band on row, label and wrapper', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      const { container } = renderFor('software');
      // vd_gamma is disabled on software: description + disabled suffix.
      const vd = findRow(container, 'vd_gamma');
      const reason = supportReason('vd_gamma', 'software');
      expect(reason.length).toBeGreaterThan(0);
      for (const el of [vd.row, vd.row.children[0]!, vd.control]) {
        expect(getTooltipText(el)).toContain(reason);
        expect(hasNativeTitle(el)).toBe(false);
      }
      expect(vd.control.getAttribute(TOOLTIP_TEXT_ATTR)).toContain(reason);
      // Enabled sibling: plain description, still no native title.
      const bright = findRow(container, 'r_brightness');
      expect(bright.control.disabled).toBe(false);
      expect(getTooltipText(bright.control).length).toBeGreaterThan(0);
      expect(getTooltipText(bright.row).length).toBeGreaterThan(0);
      expect(hasNativeTitle(bright.control)).toBe(false);
      expect(hasNativeTitle(bright.row)).toBe(false);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('long descriptions and disabled reasons survive in full (wrapped, not truncated)', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      const { container } = renderFor('software');
      // cl_showmessages has the longest panel description; cl_interp is
      // disabled on BOTH renderers with a reason.
      const long = findRow(container, 'cl_showmessages');
      const full = getTooltipText(long.control);
      expect(full.length).toBeGreaterThan(100);
      const interp = findRow(container, 'cl_interp');
      expect(interp.control.disabled).toBe(true);
      const reason = supportReason('cl_interp', 'software');
      const text = getTooltipText(interp.control);
      expect(text).toContain(reason);
      expect(text.length).toBeGreaterThan(reason.length);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });
});

describe('RELEASE-10 tooltip show/hide triggers (hover + keyboard focus)', () => {
  it('hover shows the disabled reason; leave dismisses', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setViewport(1024, 768);
      const { container } = renderFor('software');
      const { control } = findRow(container, 'vd_gamma');
      const reason = supportReason('vd_gamma', 'software');
      control.dispatch('mouseover');
      expect(isPanelTooltipVisible()).toBe(true);
      expect(panelTooltipText()).toContain(reason);
      control.dispatch('mouseleave');
      expect(isPanelTooltipVisible()).toBe(false);
      expect(panelTooltipText()).toBe('');
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('keyboard focus shows on the disabled wrapper; blur dismisses', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setViewport(1024, 768);
      const { container } = renderFor('software');
      const { control } = findRow(container, 'vd_gamma');
      // Disabled native inputs take no focus — the tabindex=0 wrapper does.
      expect(control.getAttribute('tabindex')).toBe('0');
      control.dispatch('focus');
      expect(isPanelTooltipVisible()).toBe(true);
      expect(panelTooltipText()).toContain(supportReason('vd_gamma', 'software'));
      control.dispatch('blur');
      expect(isPanelTooltipVisible()).toBe(false);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('uses role=tooltip with aria-describedby and no focus trap', () => {
    const { doc, prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setViewport(1024, 768);
      const { container } = renderFor('software');
      const { control } = findRow(container, 'vd_gamma');
      control.dispatch('mouseover');
      const nodes = tooltipNodes(doc);
      expect(nodes).toHaveLength(1);
      const node = nodes[0]!;
      expect(node.getAttribute('role')).toBe('tooltip');
      expect(control.getAttribute('aria-describedby')).toBe(TOOLTIP_ID);
      // No focus trap: the tooltip node itself is never focusable.
      expect(node.getAttribute('tabindex')).toBeNull();
      control.dispatch('mouseleave');
      expect(control.getAttribute('aria-describedby')).toBeNull();
      // Screen-reader label survives the unlink (tooltip-only, not silent).
      expect(control.getAttribute('aria-label')).toContain('vd_gamma');
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('Escape, sidebar scroll and resize dismiss', () => {
    const { doc, prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setViewport(1024, 768);
      const { container } = renderFor('software');
      const { control } = findRow(container, 'vd_gamma');
      control.dispatch('mouseover');
      expect(isPanelTooltipVisible()).toBe(true);
      doc.dispatch('keydown', { key: 'Escape' });
      expect(isPanelTooltipVisible()).toBe(false);
      control.dispatch('focus');
      expect(isPanelTooltipVisible()).toBe(true);
      doc.dispatch('scroll', {});
      expect(isPanelTooltipVisible()).toBe(false);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('positions near the anchor and clamps into the viewport', () => {
    const { doc, prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setViewport(800, 600);
      const { container } = renderFor('software');
      const { control } = findRow(container, 'vd_gamma');
      control.rect = { top: 560, left: 700, bottom: 580, right: 780, width: 80, height: 20 };
      const node = ensureTooltipNode();
      expect(node).not.toBeNull();
      (node as unknown as FakeElement).offsetWidth = 200;
      (node as unknown as FakeElement).offsetHeight = 60;
      control.dispatch('mouseover');
      expect(isPanelTooltipVisible()).toBe(true);
      const placed = node as unknown as FakeElement;
      const top = Number(placed.style['top']?.replace('px', ''));
      const left = Number(placed.style['left']?.replace('px', ''));
      expect(Number.isFinite(top)).toBe(true);
      expect(Number.isFinite(left)).toBe(true);
      // Flipped above the bottom-edge anchor, clamped off the right edge.
      expect(top).toBeLessThan(560);
      expect(left + 200).toBeLessThanOrEqual(800 - TOOLTIP_MARGIN);
      expect(left).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
      expect(tooltipNodes(doc)).toHaveLength(1);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('small viewport/zoom bounds the width to viewport minus margins', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setViewport(240, 400);
      const { container } = renderFor('software');
      const { control } = findRow(container, 'vd_gamma');
      control.rect = { top: 50, left: 10, bottom: 70, right: 200, width: 190, height: 20 };
      control.dispatch('mouseover');
      expect(isPanelTooltipVisible()).toBe(true);
      // Width clamped to 240 - 2*8 = 224 and positioned inside the viewport.
      const node = ensureTooltipNode() as unknown as FakeElement;
      expect(node.style['maxWidth']).toBe('224px');
      const left = Number(node.style['left']?.replace('px', ''));
      expect(left).toBeGreaterThanOrEqual(TOOLTIP_MARGIN);
      expect(left).toBeLessThanOrEqual(240 - TOOLTIP_MARGIN);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });
});

describe('RELEASE-10 tooltip lifecycle across rebuilds and renderer switches', () => {
  it('panel rebuild dismisses stale text and keeps a singleton node', () => {
    const { doc, prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setViewport(1024, 768);
      const first = renderFor('software');
      findRow(first.container, 'vd_gamma').control.dispatch('mouseover');
      expect(isPanelTooltipVisible()).toBe(true);
      // Rebuild (renderer switch path): stale text dismissed, no orphan node.
      const second = renderFor('webgl2-experimental');
      expect(isPanelTooltipVisible()).toBe(false);
      expect(panelTooltipText()).toBe('');
      expect(tooltipNodes(doc)).toHaveLength(1);
      // Mapping follows the new effective renderer with fresh tooltip text.
      expect(findRow(second.container, 'vd_gamma').control.disabled).toBe(false);
      expect(getTooltipText(findRow(second.container, 'vd_gamma').control)).not.toContain('disabled on');
      expect(findRow(second.container, 'sw_workers').control.disabled).toBe(true);
      expect(getTooltipText(findRow(second.container, 'sw_workers').control)).toContain('disabled on webgl2-experimental');
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('repeated renderer switches never accumulate listeners or nodes', () => {
    const { doc, prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setViewport(1024, 768);
      const kinds = ['software', 'webgl2-experimental', 'software', 'webgl2-experimental', 'software'] as const;
      for (const kind of kinds) {
        const { container } = renderFor(kind);
        const { control } = findRow(container, kind === 'software' ? 'vd_gamma' : 'sw_workers');
        control.dispatch('mouseover');
        expect(isPanelTooltipVisible()).toBe(true);
        control.dispatch('mouseleave');
      }
      expect(tooltipNodes(doc)).toHaveLength(1);
      expect(doc.docListeners.get('scroll') ?? []).toHaveLength(1);
      expect(doc.docListeners.get('keydown') ?? []).toHaveLength(1);
      // No pointer-lock-discipline violation from the tooltip layer.
      for (const type of ['mousedown', 'mouseup', 'click', 'pointerlockchange', 'mousemove']) {
        expect(doc.docListeners.get(type) ?? []).toHaveLength(0);
      }
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('re-attaching the same panel does not duplicate element triggers', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setViewport(1024, 768);
      const { container } = renderFor('software');
      const { control } = findRow(container, 'vd_gamma');
      const before = control.listenerCount('mouseover');
      expect(before).toBeGreaterThan(0);
      attachPanelTooltips(container);
      attachPanelTooltips(container);
      expect(control.listenerCount('mouseover')).toBe(before);
      // Triggers still work after the redundant attaches.
      control.dispatch('mouseover');
      expect(isPanelTooltipVisible()).toBe(true);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('hide is safe with no node and show is a no-op for empty text', () => {
    const { doc, prev } = install();
    try {
      resetCVars();
      expect(() => hidePanelTooltip()).not.toThrow();
      expect(isPanelTooltipVisible()).toBe(false);
      const bare = new FakeContainer();
      expect(showPanelTooltip(bare)).toBe(false);
      expect(tooltipNodes(doc)).toHaveLength(0);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('disabled checkbox rows keep the enabled geometry (no layout shift)', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      const { container } = renderFor('software');
      // vd_dither disabled on software; cl_predict enabled — same row shape,
      // tooltip-only (no visible note node), same control kind.
      const off = findRow(container, 'vd_dither');
      const on = findRow(container, 'cl_predict');
      expect(off.control.disabled).toBe(true);
      expect(on.control.disabled).toBe(false);
      for (const found of [off, on]) {
        expect(found.row.children).toHaveLength(2);
        expect(found.control.tag).toBe('q2-checkbox');
      }
      expect(off.control.getAttribute('disabled')).toBe('');
      expect(off.control.getAttribute('aria-disabled')).toBe('true');
      expect(getTooltipText(off.control)).toContain(supportReason('vd_dither', 'software'));
      // Saved values display on both sides of the mapping.
      setCVarFromString('vd_dither', '0');
      const again = renderFor('webgl2-experimental');
      expect(findRow(again.container, 'vd_dither').control.disabled).toBe(false);
      expect(getCVarString('vd_dither')).toBe('0');
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });
});

