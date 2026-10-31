// RELEASE-10 apps/web lane (boxes 2–3): the settings panel disables controls
// unsupported by the EFFECTIVE renderer (never hides, never resets), with the
// support reason as the visible + screen-reader explanation, and refreshes on
// switch/fallback/restore. Headless: real panel enablement is pinned via a
// fake DOM around `renderCvarPanel` (same pattern as pos.test.ts); GPU-live
// legs stay browser-gated, so the webgl2 mapping is exercised through the
// explicit `active` override plus the live failed-GPU fallback path.
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCVar,
  getCVarNumber,
  getCVarString,
  isCVarSupportedBy,
  RENDERER_CVAR_SUPPORT,
  resetCVars,
  setCVar,
  setCVarFromString,
  supportReason,
} from '@q2/config';
import {
  applyRendererCvar,
  bootPlay,
  getBrightness,
  readGpuAppearanceSnapshot,
  rebootPlay,
  resolveDisplay,
  resizePlay,
  setPanelRefreshHook,
} from './play.js';
import {
  cvarIsCheckbox,
  cvarOptions,
  effectivePanelRenderer,
  renderCvarPanel,
} from './dom.js';

afterEach(() => {
  resetCVars();
  setPanelRefreshHook(null);
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
  disabled = false;
  title = '';
  ariaLabel = '';
  attrs = new Map<string, string>();
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
    if (k === 'aria-label') this.ariaLabel = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
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

function renderFor(
  active: 'software' | 'webgl2-experimental',
): { container: FakeContainer; names: string[]; seen: Array<[string, string]> } {
  const container = new FakeContainer();
  const seen: Array<[string, string]> = [];
  const names = renderCvarPanel(container, '', (n, v) => seen.push([n, v]), active);
  return { container, names, seen };
}

function findRow(container: FakeContainer, name: string): { row: FakeElement; control: FakeElement } {
  const row = container.children.find((r) => r.children[0]?.textContent === name);
  expect(row, `row for ${name}`).toBeDefined();
  return { row: row!, control: row!.children[1]! };
}

function expectMatrix(active: 'software' | 'webgl2-experimental'): void {
  const { container, names } = renderFor(active);
  for (const [name, entry] of Object.entries(RENDERER_CVAR_SUPPORT)) {
    expect(names, `panel lists ${name}`).toContain(name);
    const expected = active === 'software' ? entry.software : entry.webgl2;
    const { row, control } = findRow(container, name);
    expect(control.disabled, `${name} disabled on ${active}`).toBe(!expected);
    if (expected) {
      expect(control.getAttribute('disabled'), `${name} has no disabled attribute`).toBeNull();
      expect(row.children.some((c) => c.className === 'q2-cvar-why')).toBe(false);
    } else {
      // Real `disabled` attribute + visible reason + screen-reader label.
      expect(control.getAttribute('disabled'), `${name} carries real disabled`).toBe('');
      const reason = supportReason(name, active);
      expect(reason.length).toBeGreaterThan(0);
      const why = row.children.find((c) => c.className === 'q2-cvar-why');
      expect(why, `${name} shows a visible reason`).toBeDefined();
      expect(why!.textContent).toContain(reason);
      expect((control as unknown as { ariaLabel?: string }).ariaLabel ?? '').toContain(reason);
      expect(control.title).toContain(reason);
      expect(row.title).toContain(reason);
    }
  }
  // The mapping agrees with the config source of truth on every row.
  for (const name of names) {
    if ((RENDERER_CVAR_SUPPORT as Record<string, unknown>)[name] === undefined) {
      const { control } = findRow(container, name);
      expect(control.disabled, `unknown ${name} stays shared`).toBe(false);
    }
  }
}

describe('RELEASE-10 panel enablement matrix per effective renderer', () => {
  it('software mapping: vd_* disabled, software controls + shared usable', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      expectMatrix('software');
      // Spot pins beyond the sweep: representatives of each class.
      expect(isCVarSupportedBy('vd_gamma', 'software')).toBe(false);
      expect(isCVarSupportedBy('vd_palettetex', 'software')).toBe(false);
      expect(isCVarSupportedBy('sw_workers', 'software')).toBe(true);
      expect(isCVarSupportedBy('r_translucency', 'software')).toBe(true);
      expect(isCVarSupportedBy('r_brightness', 'software')).toBe(true);
      expect(isCVarSupportedBy('cl_interp', 'software')).toBe(false);
      expect(isCVarSupportedBy('cl_predict', 'software')).toBe(true);
      expect(isCVarSupportedBy('vid_renderer', 'software')).toBe(true);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('webgl2 mapping: vd_* enabled (except palettetex), software-only + decorative disabled', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      expectMatrix('webgl2-experimental');
      expect(isCVarSupportedBy('vd_gamma', 'webgl2-experimental')).toBe(true);
      expect(isCVarSupportedBy('vd_reconmode', 'webgl2-experimental')).toBe(true);
      expect(isCVarSupportedBy('vd_palettetex', 'webgl2-experimental')).toBe(false);
      expect(isCVarSupportedBy('sw_workers', 'webgl2-experimental')).toBe(false);
      expect(isCVarSupportedBy('sw_wasm', 'webgl2-experimental')).toBe(false);
      expect(isCVarSupportedBy('r_translucency', 'webgl2-experimental')).toBe(false);
      expect(isCVarSupportedBy('r_brightness', 'webgl2-experimental')).toBe(false);
      expect(isCVarSupportedBy('cl_interp', 'webgl2-experimental')).toBe(false);
      expect(isCVarSupportedBy('sw_gamma', 'webgl2-experimental')).toBe(false);
      expect(isCVarSupportedBy('r_drawworld', 'webgl2-experimental')).toBe(false);
      expect(isCVarSupportedBy('cl_predict', 'webgl2-experimental')).toBe(true);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('decorative-everywhere cvars are disabled in BOTH renderers with reasons', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      for (const name of ['sw_gamma', 'r_drawworld', 'vd_palettetex', 'cl_interp']) {
        expect(isCVarSupportedBy(name, 'software')).toBe(false);
        expect(isCVarSupportedBy(name, 'webgl2-experimental')).toBe(false);
        for (const active of ['software', 'webgl2-experimental'] as const) {
          const { container } = renderFor(active);
          const { control } = findRow(container, name);
          expect(control.disabled, `${name} disabled on ${active}`).toBe(true);
          expect(supportReason(name, active).length).toBeGreaterThan(0);
        }
      }
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });
});

describe('RELEASE-10 panel fallback refresh + value retention', () => {
  it('failed-GPU fallback resolves to the software mapping with no stale labels', () => {
    const { doc, prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setCVarFromString('vid_renderer', 'webgl2-experimental');
      // Headless has no WebGL2 context: the request falls back to software.
      const boot = bootPlay({ width: 320, height: 240 });
      expect(boot.renderer).toBe('software');
      expect(boot.lastRendererWarning).not.toBeNull();
      expect(boot.lastRendererWarning!).toContain('webgl2');
      // Live resolution (no explicit override) keys on the EFFECTIVE
      // renderer: the panel shows the software mapping, never GPU labels.
      expect(effectivePanelRenderer()).toBe('software');
      const container = new FakeContainer();
      renderCvarPanel(container, '', () => undefined);
      const { control } = findRow(container, 'vd_gamma');
      expect(control.disabled).toBe(true);
      expect(control.getAttribute('disabled')).toBe('');
      const { control: swControl } = findRow(container, 'sw_workers');
      expect(swControl.disabled).toBe(false);
      // Switching back to software explicitly keeps the same mapping.
      setCVarFromString('vid_renderer', 'software');
      expect(applyRendererCvar(boot)).toBe('software');
      const again = new FakeContainer();
      renderCvarPanel(again, '', () => undefined);
      expect(findRow(again, 'vd_gamma').control.disabled).toBe(true);
      // No document-level listeners from any render (pointer-lock discipline).
      for (const type of ['mousedown', 'mouseup', 'click', 'pointerlockchange', 'mousemove']) {
        expect(doc.docListeners.get(type) ?? []).toHaveLength(0);
      }
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('retains saved values across switch cycles and never resets disabled cvars', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      // Saved values on both sides of the mapping (incl. currently-disabled).
      setCVarFromString('vd_gamma', '2.2');
      setCVarFromString('sw_workers', '4');
      setCVarFromString('r_brightness', '1.5');
      setCVar('cl_interp', 0);
      const before = {
        vd_gamma: getCVarString('vd_gamma'),
        sw_workers: getCVarString('sw_workers'),
        r_brightness: getCVarString('r_brightness'),
        cl_interp: getCVarString('cl_interp'),
      };
      // software → webgl2 → software: values survive every re-render, and
      // disabled controls still DISPLAY the saved value (retained, not blank).
      let rendered = renderFor('software');
      expect(findRow(rendered.container, 'vd_gamma').control.disabled).toBe(true);
      expect(findRow(rendered.container, 'vd_gamma').control.value).toBe('2.2');
      rendered = renderFor('webgl2-experimental');
      expect(findRow(rendered.container, 'vd_gamma').control.disabled).toBe(false);
      expect(findRow(rendered.container, 'vd_gamma').control.value).toBe('2.2');
      expect(findRow(rendered.container, 'sw_workers').control.disabled).toBe(true);
      expect(findRow(rendered.container, 'sw_workers').control.value).toBe('4');
      rendered = renderFor('software');
      expect(findRow(rendered.container, 'sw_workers').control.disabled).toBe(false);
      expect(findRow(rendered.container, 'sw_workers').control.value).toBe('4');
      expect(findRow(rendered.container, 'cl_interp').control.checked).toBe(false);
      for (const [name, value] of Object.entries(before)) {
        expect(getCVarString(name), `${name} retained`).toBe(value);
      }
      // Disabled rows are never dropped from the panel (still listed).
      for (const name of Object.keys(before)) {
        expect(rendered.names).toContain(name);
      }
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('disabled controls are not operable: headless dispatches never clobber', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      setCVarFromString('vd_gamma', '1.3');
      setCVar('sw_gamma', 1.0);
      const seen: Array<[string, string]> = [];
      const container = new FakeContainer();
      renderCvarPanel(container, '', (n, v) => seen.push([n, v]), 'software');
      // Disabled select: dispatch keeps the saved value, fires no onChange.
      const vd = findRow(container, 'vd_gamma').control;
      expect(vd.disabled).toBe(true);
      vd.value = '2.2';
      vd.dispatch('change');
      expect(getCVarString('vd_gamma')).toBe('1.3');
      // Disabled text input: same no-op contract.
      const swg = findRow(container, 'sw_gamma').control;
      expect(swg.disabled).toBe(true);
      swg.value = '9.9';
      swg.dispatch('change');
      expect(getCVarNumber('sw_gamma')).toBe(1.0);
      expect(seen.some(([n]) => n === 'vd_gamma' || n === 'sw_gamma')).toBe(false);
      // Enabled sibling still operates.
      const bright = findRow(container, 'r_brightness').control;
      expect(bright.disabled).toBe(false);
      bright.value = '1.5';
      bright.dispatch('change');
      expect(getCVarString('r_brightness')).toBe('1.5');
      expect(seen).toContainEqual(['r_brightness', '1.5']);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });

  it('re-render after switch/restore cycles leaves no stale labels', () => {
    const { prev } = install();
    try {
      resetCVars();
      ensurePanelCvars();
      // Switch to webgl2: previously-disabled rows enable cleanly.
      let rendered = renderFor('software');
      expect(findRow(rendered.container, 'vd_dither').control.disabled).toBe(true);
      rendered = renderFor('webgl2-experimental');
      const enabled = findRow(rendered.container, 'vd_dither');
      expect(enabled.control.disabled).toBe(false);
      expect(enabled.control.getAttribute('disabled')).toBeNull();
      expect(enabled.row.children.some((c) => c.className === 'q2-cvar-why')).toBe(false);
      // Switch back: disabled again with a fresh reason (no duplication).
      rendered = renderFor('software');
      const back = findRow(rendered.container, 'vd_dither');
      expect(back.control.disabled).toBe(true);
      expect(back.row.children.filter((c) => c.className === 'q2-cvar-why')).toHaveLength(1);
      // rebootPlay preserves the mapping (renderer unchanged headless).
      const boot = bootPlay({ width: 64, height: 64 });
      const next = rebootPlay(boot);
      expect(next.renderer).toBe(boot.renderer);
      rendered = renderFor(next.renderer);
      expect(findRow(rendered.container, 'vd_dither').control.disabled).toBe(true);
    } finally {
      (globalThis as unknown as { document?: unknown }).document = prev;
    }
  });
});

describe('RELEASE-10 setting effects gated per renderer', () => {
  it('vd_* changes move the GPU appearance snapshot; sw_* never enters it', () => {
    resetCVars();
    try {
      setCVarFromString('vd_gamma', '1.0');
      const s1 = readGpuAppearanceSnapshot();
      setCVarFromString('vd_gamma', '2.2');
      const s2 = readGpuAppearanceSnapshot();
      expect(s1['vd_gamma']).toBe('1');
      expect(s2['vd_gamma']).toBe('2.2');
      // Worker/span settings have no GPU appearance consumer.
      setCVarFromString('sw_workers', '4');
      setCVar('sw_wasm', 1);
      const s3 = readGpuAppearanceSnapshot();
      expect('sw_workers' in s3).toBe(false);
      expect('sw_wasm' in s3).toBe(false);
      expect(s3['vd_gamma']).toBe('2.2');
    } finally {
      resetCVars();
    }
  });

  it('vd_* has no software-resolve effect; r_brightness does', () => {
    resetCVars();
    try {
      const boot = bootPlay({ width: 64, height: 64 });
      const live = boot.refresh.getFramebuffer().color as Uint32Array;
      live.fill(0x00102030);
      setCVarFromString('r_brightness', '1.0');
      setCVarFromString('vd_gamma', '1.0');
      const a = [...resolveDisplay(boot)];
      setCVarFromString('vd_gamma', '2.2');
      setCVar('vd_dither', 0);
      // vd_* never touches the software path: byte-identical resolve.
      expect([...resolveDisplay(boot)]).toEqual(a);
      expect(getBrightness()).toBe(1.0);
      setCVarFromString('r_brightness', '2.0');
      // r_brightness IS the software display lift: output changes.
      expect([...resolveDisplay(boot)]).not.toEqual(a);
    } finally {
      resetCVars();
    }
  });
});

describe('RELEASE-10 panel refresh hook (single slot, no listener leak)', () => {
  it('apply/reboot/resize invoke the hook; replacing the hook replaces the target', () => {
    resetCVars();
    try {
      const first: string[] = [];
      const second: string[] = [];
      setPanelRefreshHook(() => {
        first.push('refresh');
      });
      const boot = bootPlay({ width: 64, height: 64 });
      expect(applyRendererCvar(boot)).toBe('software');
      expect(first).toHaveLength(1);
      rebootPlay(boot);
      expect(first).toHaveLength(2);
      expect(resizePlay(boot, 96, 64)).toBe(true);
      expect(first).toHaveLength(3);
      // Single slot: installing again replaces, never accumulates.
      setPanelRefreshHook(() => {
        second.push('refresh');
      });
      applyRendererCvar(boot);
      expect(first).toHaveLength(3);
      expect(second).toHaveLength(1);
    } finally {
      setPanelRefreshHook(null);
      resetCVars();
    }
  });

  it('a throwing hook never breaks the switch path', () => {
    resetCVars();
    try {
      setPanelRefreshHook(() => {
        throw new Error('panel boom (test stub)');
      });
      const boot = bootPlay({ width: 64, height: 64 });
      expect(() => applyRendererCvar(boot)).not.toThrow();
      expect(boot.renderer).toBe('software');
    } finally {
      setPanelRefreshHook(null);
      resetCVars();
    }
  });
});
