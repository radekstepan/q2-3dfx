// q2ts-web DOM layer: drop zone, canvas blit, cvar panel, progress (M7.1).
//
// Browser-only. All functions no-op / return null without a DOM so Node
// tests can import this module safely. Canvas code is isolated here —
// `index.ts` and `devroom.ts` never touch `document`.
import { getCVar, getCVarNumber, getCVarString, listCVars, registerCVar, setCVarFromString } from '@q2/config';
import { availableMapSources } from './play.js';
import type { Framebuffer } from '@q2/renderer-api';
import { ingestPak } from './pak.js';
import type { WebPak } from './pak.js';

registerCVar('cl_showfps', 1, 'show in-canvas fps readout top-right (conchars glyphs)');
registerCVar('cl_showpos', 1, 'show in-canvas player-position readout top-left (pos X Y Z)');

/** Cvar gate for the fps readout (`cl_showfps`, default 1). */

export interface ProgressState {
  fraction: number;
  label: string;
}

/** Update a progress element if present; always returns the state. */
export function setProgress(el: unknown, fraction: number, label: string): ProgressState {
  const state = { fraction, label };
  const node = el as { textContent?: string; style?: { width?: string } } | null;
  if (node && typeof node === 'object') {
    if (typeof node.textContent === 'string' || node.textContent === undefined) {
      try {
        (node as { textContent: string }).textContent = `${label} ${(fraction * 100).toFixed(0)}%`;
      } catch {
        /* non-DOM stub */
      }
    }
  }
  return state;
}

/** Cvar gate for the fps readout (`cl_showfps`, default 1). */
export function showFpsEnabled(): boolean {
  // resetCVars() restores only compiled-in defaults; an absent cl_showfps
  // (e.g. after a reset in tests) means the default-on state.
  if (getCVar('cl_showfps') === undefined) return true;
  return getCVarNumber('cl_showfps') !== 0;
}

/** Cvar gate for the position readout (`cl_showpos`, default 1 = ON). */
export function showPosEnabled(): boolean {
  // Absent (e.g. after a reset in tests) means the default-on state.
  if (getCVar('cl_showpos') === undefined) return true;
  return getCVarNumber('cl_showpos') !== 0;
}

/** Blit a 0xAABBGGRR framebuffer into a <canvas> via putImageData.
 *
 * Fast path: one bulk u32 copy into a cached ImageData (no per-frame
 * createImageData, no per-pixel loop). On little-endian runtimes
 * (x86/ARM/wasm32 — every real browser) 0xAABBGGRR bytes already sit in
 * R,G,B,A order, exactly ImageData's RGBA layout, so the copy is a memcpy.
 * Big-endian falls back to the legacy per-byte loop. The ImageData (and its
 * u32 view) is cached per canvas in a WeakMap and only recreated on canvas
 * or size change — zero allocation on the steady-state frame.
 */
export function blitToCanvas(canvas: unknown, fb: Framebuffer): boolean {
  if (typeof document === 'undefined') return false;
  const el = canvas as HTMLCanvasElement;
  if (!el || typeof el.getContext !== 'function') return false;
  if (el.width !== fb.width || el.height !== fb.height) {
    el.width = fb.width;
    el.height = fb.height;
  }
  let cached = blitCaches.get(el);
  if (!cached || cached.w !== fb.width || cached.h !== fb.height) {
    const ctx = el.getContext('2d');
    if (!ctx) return false;
    let img: ImageData;
    try {
      img = ctx.createImageData(fb.width, fb.height);
    } catch {
      return false;
    }
    // u32 view over the RGBA bytes (ImageData buffers are fresh +
    // 4-aligned): the steady-state copy below allocates nothing.
    const u32 = img.data.byteOffset % 4 === 0 && img.data.length === fb.width * fb.height * 4
      ? new Uint32Array(img.data.buffer, img.data.byteOffset, fb.width * fb.height)
      : null;
    cached = { ctx: ctx as CanvasRenderingContext2D, img, w: fb.width, h: fb.height, u32 };
    blitCaches.set(el, cached);
  }
  // Steady state: one bulk u32 copy into the cached ImageData (the bytes
  // already sit in RGBA order on little-endian — see blitCopyRGBA). Length
  // drift (never happens at a fixed resolution) falls back to the loop.
  if (cached.u32 && cached.u32.length === fb.color.length) {
    cached.u32.set(fb.color);
  } else {
    blitCopyRGBA(cached.img.data, fb.color);
  }
  cached.ctx.putImageData(cached.img, 0, 0);
  return true;
}

/** Per-canvas blit scratch (cached ImageData + u32 view, see blitToCanvas). */
interface BlitCache {
  ctx: CanvasRenderingContext2D;
  img: ImageData;
  w: number;
  h: number;
  /** u32 view over img.data, built lazily (byteOffset must be 4-aligned). */
  u32: Uint32Array | null;
}

const blitCaches = new WeakMap<object, BlitCache>();

/** True on little-endian runtimes (x86/ARM/wasm32): 0xAABBGGRR bytes ARE RGBA order. */
let blitLE: boolean | null = null;

/** Runtime endianness probe (memoized, no DOM needed — unit-testable). */
export function blitIsLittleEndian(): boolean {
  if (blitLE === null) {
    const u32 = new Uint32Array([0x0a0b0c0d]);
    blitLE = new Uint8Array(u32.buffer)[0] === 0x0d;
  }
  return blitLE;
}

/**
 * Copy a 0xAABBGGRR buffer into an RGBA byte buffer (the blitToCanvas core,
 * extracted pure + headless-testable). Little-endian with an exactly-sized,
 * 4-aligned destination: one bulk u32 copy. Anything else (big-endian,
 * odd-sized scratch): the legacy per-pixel loop over the source pixels.
 * Never throws on length mismatch — fills the min prefix.
 */
export function blitCopyRGBA(dst: Uint8Array | Uint8ClampedArray, src: Uint32Array): void {
  const n = Math.min(src.length, Math.floor(dst.length / 4));
  if (n <= 0) return;
  if (blitIsLittleEndian() && dst.length === src.length * 4 && dst.byteOffset % 4 === 0) {
    new Uint32Array(dst.buffer, dst.byteOffset, src.length).set(src);
    return;
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const px = src[i]!;
    dst[j] = px & 255;
    dst[j + 1] = (px >> 8) & 255;
    dst[j + 2] = (px >> 16) & 255;
    dst[j + 3] = (px >>> 24);
  }
}

/** Attach pak drop + file-picker ingest to an element. No-op without DOM. */
export function attachDropZone(
  el: unknown,
  onPak: (pak: WebPak, fileName: string) => void,
  onError?: (err: Error) => void,
): () => void {
  if (typeof document === 'undefined' || !el) return () => undefined;
  const node = el as HTMLElement;
  const handleBuffer = (buf: ArrayBuffer, name: string): void => {
    try {
      onPak(ingestPak(buf), name);
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    void file.arrayBuffer().then((buf) => handleBuffer(buf, file.name));
  };
  const onDragOver = (e: DragEvent): void => e.preventDefault();
  node.addEventListener('drop', onDrop);
  node.addEventListener('dragover', onDragOver);
  return () => {
    node.removeEventListener('drop', onDrop);
    node.removeEventListener('dragover', onDragOver);
  };
}

/**
 * Known option lists for cvars with a fixed value domain. Cvars absent here
 * get a free-text input. Pure data + pure helpers so Node tests can pin the
 * select-vs-input logic without a DOM.
 */
export const CVAR_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  vid_renderer: ['software', 'voodoo'],
  vid_resolution: ['320x240', '640x480', '800x600', '1024x768'],
  skill: ['0', '1', '2', '3'],
  map_source: ['devroom', 'pak'],
  sw_workers: ['0', '2', '4'],
  r_brightness: ['0.75', '1.0', '1.25', '1.5', '2.0'],
  vd_gamma: ['1.0', '1.3', '2.2'],
  vd_dithermode: ['2x2', '4x4'],
  vd_reconmode: ['2x2sub+2x2box', '4x4sub+4x1', 'legacy'],
  vd_maxtexsize: ['64', '128', '256'],
  vd_zbits: ['8', '16'],
};

/** Re-register HUD cvars if a test `resetCVars()` wiped them, so the
 * menu panel keeps listing them and headless boots stay deterministic. */
function ensureHudCvars(): void {
  if (getCVar('cl_showfps') === undefined) {
    registerCVar('cl_showfps', 1, 'show in-canvas fps readout top-right (conchars glyphs)');
  }
  if (getCVar('cl_showpos') === undefined) {
    registerCVar('cl_showpos', 1, 'show in-canvas player-position readout top-left (pos X Y Z)');
  }
}

/**
 * Boolean cvars rendered as checkboxes (element-local `change` listeners,
 * never document-level mouse wiring — so toggling them can never produce
 * game input under the canvas pointer-lock discipline).
 *
 * Every 0/1 cvar the panel can list lives here: the HUD gates (`cl_showfps`,
 * `cl_showpos`), the Voodoo fidelity switches (`vd_*`, BRAIN.md §7.2), the
 * client/world toggles (`cl_predict`, `cl_interp`, `r_drawworld`), the
 * span-backend switches (`sw_wasm`, `sw_accum` — registered lazily by
 * `@q2/sw-renderer`, so they are pinned here even before first registration),
 * and the translucency pair (`r_translucency`, `sw_stipplealpha` — also
 * lazily registered by `@q2/sw-renderer`'s spans backend).
 * `sw_workers` stays a select (0/2/4 band count, not boolean).
 */
export const CHECKBOX_CVARS: ReadonlySet<string> = new Set([
  'cl_showfps',
  'cl_showpos',
  'vd_16bit',
  'vd_dither',
  'vd_postfilter',
  'vd_bilinear',
  'vd_mipdither',
  'vd_fog',
  'vd_palettetex',
  'vd_overbright',
  'r_drawworld',
  'r_translucency',
  'sw_stipplealpha',
  'cl_predict',
  'cl_interp',
  'sw_wasm',
  'sw_accum',
]);

/** True when this cvar renders as a checkbox (boolean 0/1 cvar). */
export function cvarIsCheckbox(name: string): boolean {
  return CHECKBOX_CVARS.has(name);
}

/**
 * Option list for a cvar, or null when it takes free-text input.
 * map_source is pak-aware: the cached pak appears in the dropdown only after
 * a drop (see setMapSourceHasPak); with no pak only devroom is listed.
 */
export function cvarOptions(name: string): readonly string[] | null {
  if (name === 'map_source') return availableMapSources(mapSourceHasPak);
  return CVAR_OPTIONS[name] ?? null;
}

/**
 * Difficulty labels for the skill dropdown (M7.1 menu): skill 0-3 maps to
 * Easy/Medium/Hard/Nightmare, Q2 default Medium(1). Persisted as numbers
 * via setCVar; the labels are display-only.
 */
export const SKILL_LABELS = ['Easy', 'Medium', 'Hard', 'Nightmare'] as const;

/**
 * Display labels for a cvar's options (skill + resolution are labeled).
 */
export const RESOLUTION_LABELS = ['320×240', '640×480', '800×600', '1024×768'] as const;

/**
 * Display labels for the map_source dropdown (M7.1 config menu): the cached
 * pak boots the game map (base1), the built-in devroom is the asset-free
 * demomap. Persisted as bare values via setCVar; labels are display-only.
 */
export const MAP_SOURCE_LABELS = ['Built-in devroom (demomap)', 'Cached pak0.pak (game)'] as const;

/**
 * Display labels for the vd_reconmode dropdown (the raw values are
 * MiniGL-flavoured profile names, so the menu shows what each mode does).
 */
export const RECON_LABELS = ['2×2 matched (default)', '4×4 horizontal', 'Legacy (compat)'] as const;

/** Display labels for the vd_zbits dropdown (depth precision profile). */
export const ZBITS_LABELS = ['8-bit (banded)', '16-bit (Voodoo3)'] as const;

/**
 * Whether a pak is available for the map_source dropdown. Set by the boot
 * layer (index.ts) on cache load / drop / clear; the dropdown lists the pak
 * only afterwards. Defaults to false (devroom only) so headless/Node boots
 * stay deterministic.
 */
let mapSourceHasPak = false;

/** Record pak availability for the map_source dropdown (test hook too). */
export function setMapSourceHasPak(v: boolean): void {
  mapSourceHasPak = v;
}

/** Current pak availability behind the map_source dropdown. */
export function getMapSourceHasPak(): boolean {
  return mapSourceHasPak;
}

/**
 * Display labels for a cvar's options (skill + resolution + map_source +
 * recon + zbits are labeled; other domains show their bare values).
 */
export function cvarOptionLabels(name: string): readonly string[] | null {
  if (name === 'skill') return SKILL_LABELS;
  if (name === 'vid_resolution') return RESOLUTION_LABELS;
  if (name === 'map_source') return MAP_SOURCE_LABELS;
  if (name === 'vd_reconmode') return RECON_LABELS;
  if (name === 'vd_zbits') return ZBITS_LABELS;
  return null;
}

/** Sidebar section order for the settings panel (Quake II menu groups). */
export const GROUP_ORDER = [
  'VIDEO',
  'VOODOO 3DFX',
  'SOFTWARE SPANS',
  'GAME',
  'HUD',
  'SOUND + INPUT',
  'OTHER',
] as const;

/** Sidebar section for a cvar row (unknown cvars fall into OTHER). */
export function cvarGroup(name: string): (typeof GROUP_ORDER)[number] {
  if (name.startsWith('vd_')) return 'VOODOO 3DFX';
  if (name === 'vid_renderer' || name === 'vid_resolution' || name === 'r_brightness' || name === 'r_drawworld' || name === 'r_translucency') return 'VIDEO';
  if (name.startsWith('sw_')) return 'SOFTWARE SPANS';
  if (name === 'skill' || name === 'map_source' || name === 'cl_predict' || name === 'cl_interp') return 'GAME';
  if (name === 'cl_showfps' || name === 'cl_showpos') return 'HUD';
  if (name === 's_volume' || name === 'sensitivity' || name === 'm_yaw' || name === 'm_pitch') return 'SOUND + INPUT';
  return 'OTHER';
}

/**
 * On-hover descriptions for every menu row, copied verbatim from the cvar
 * definitions (`@q2/config` defaults, the `registerCVar` docs in
 * `play.ts`/`dom.ts`, `bands.ts`/`wasmSpans.ts` for the span switches).
 * `cvarDescription` prefers the live registry doc and falls back here, so
 * lazily-registered cvars (`sw_wasm`, `sw_accum`) still get tooltips before
 * their first registration.
 */
export const CVAR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  cl_showfps: 'show in-canvas fps readout top-right (conchars glyphs)',
  cl_showpos: 'show in-canvas player-position readout top-left (pos X Y Z)',
  r_brightness: 'display-only post-resolve brightness lift 0.5..2.0',
  skill: 'difficulty 0 easy 1 medium 2 hard 3 nightmare (latched at boot)',
  map_source: 'map source: cached pak0.pak game (pak) or built-in devroom (devroom); changing it reboots the level',
  vid_resolution: 'internal framebuffer WxH (latched: changing it reboots the level)',
  vid_renderer: 'active refresh backend: software | voodoo',
  vd_16bit: 'quantise 8:8:8 to RGB565 at resolve',
  vd_dither: '4x4 ordered dither before quantise',
  vd_postfilter: '2x2 "22-bit" RAMDAC post filter',
  vd_bilinear: 'bilinear filtering',
  vd_mipdither: 'single-TMU trilinear via mip dithering',
  vd_dithermode: 'ordered-dither matrix at target writes: 2x2 | 4x4 (default 4x4)',
  vd_reconmode: 'scanout reconstruction: matched 2x2 (default) | 4x4 horizontal | legacy compat',
  vd_rgbmaxdelta: 'per-component recon rejection thresholds r,g,b (default 8,8,8)',
  vd_lodbias: 'Glide LOD bias',
  vd_fog: '64-entry table fog',
  vd_gamma: 'Glide gamma lift',
  vd_maxtexsize: '256x256 texture cap',
  vd_zbits: '16-bit depth buffer',
  vd_palettetex: '8-bit palettised textures',
  vd_overbright: 'lightmap modulate x2 with clamp',
  sw_gamma: 'software gamma',
  sw_workers: 'banded SAB spanfill: N horizontal bands (M8.1, default 0 = single-threaded)',
  sw_accum: 'coalesce frame span batches into one pool kick (M8.1, default 1 = on)',
  sw_wasm: 'use the WASM spanfill backend (M9.1, default 0 = TS)',
  r_drawworld: 'draw world geometry',
  r_translucency: 'translucent surfaces: 0 = opaque fallback, 1 = alphamap blend (ref_soft default)',
  sw_stipplealpha: 'screen-door stipple for translucency (ref_soft sw_stipplealpha, default 0 = blend)',
  cl_predict: 'predict local player between 10Hz snapshots',
  cl_interp: 'interpolate remote entities between snapshots',
  s_volume: 'master sound volume 0..1',
  sensitivity: 'mouse sensitivity',
  m_yaw: 'mouse yaw scale',
  m_pitch: 'mouse pitch scale',
};

/** On-hover description for a menu row (live registry doc wins, static map fallback). */
export function cvarDescription(name: string): string {
  for (const c of listCVars()) {
    if (c.name === name && c.doc) return c.doc;
  }
  return CVAR_DESCRIPTIONS[name] ?? '';
}

/**
 * Cvars that reboot the level when changed (latched in id, immediate here):
 * skill re-calls the boot path with SV_SetSkill applied before spawning,
 * vid_resolution reboots at the new framebuffer size. vid_renderer is NOT
 * here: it hot-swaps in place (applyRendererCvar) without rebuilding
 * Host/LocalDriver/server state. The browser boot listens via
 * renderCvarPanel's onChange and calls rebootPlay.
 */
export const REBOOT_CVARS: ReadonlySet<string> = new Set(['skill', 'vid_resolution', 'map_source']);

/** True when changing this cvar reboots the level (skill, vid_resolution). */
export function cvarNeedsReboot(name: string): boolean {
  return REBOOT_CVARS.has(name);
}

/** UI cvars persisted across page reloads (localStorage, DOM-guarded). */
const PERSISTED_CVARS = ['vid_renderer', 'skill', 'vid_resolution', 'map_source', 'r_brightness'] as const;
const PERSIST_KEY = 'q2ts.cvars.v1';

/** Save menu cvars to localStorage. No-op without DOM. */
export function savePersistedCVars(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const obj: Record<string, string> = {};
    for (const name of PERSISTED_CVARS) obj[name] = getCVarString(name);
    localStorage.setItem(PERSIST_KEY, JSON.stringify(obj));
  } catch {
    /* storage full/blocked: session cvars still work */
  }
}

/** Restore menu cvars from localStorage. No-op without DOM. */
export function restorePersistedCVars(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, string>;
    for (const name of PERSISTED_CVARS) {
      if (typeof obj[name] === 'string') {
        try {
          setCVarFromString(name, obj[name]!);
        } catch {
          /* stale value: keep registered default */
        }
      }
    }
  } catch {
    /* corrupt JSON: keep defaults */
  }
}

/** Canonical label for a skill value (clamped to 0..3, default Medium). */
export function skillLabel(value: number | string): string {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Math.floor(value);
  const i = Number.isFinite(n) ? Math.min(3, Math.max(0, n)) : 1;
  return SKILL_LABELS[i]!;
}

/** Parse a difficulty label (or bare number) back to its skill value. */
export function skillValueForLabel(label: string): number {
  const i = SKILL_LABELS.findIndex((l) => l.toLowerCase() === label.trim().toLowerCase());
  if (i >= 0) return i;
  const n = Number.parseInt(label, 10);
  return n >= 0 && n <= 3 ? n : 1;
}

/** Control kind for a cvar row: 'checkbox' for booleans, 'select' for known domains, else 'text'. */
export function cvarControlKind(name: string): 'select' | 'text' | 'checkbox' {
  if (cvarIsCheckbox(name)) return 'checkbox';
  return cvarOptions(name) === null ? 'text' : 'select';
}

// --- custom elements (settings panel controls) ---
//
// The whole settings UI is custom elements with light-DOM children, styled
// by the page CSS (see apps/web/index.html): <q2-settings-panel> is the
// sidebar container, <q2-group> a stencil section header, <q2-cvar-row> one
// labeled row, and <q2-checkbox> / <q2-select> / <q2-text> the controls.
// Each control hosts exactly one native input/select (keyboard-focusable,
// label-linked via `bindControlId`) and proxies its state (`checked` /
// `value`) so panel code treats the wrapper like the native control it
// wraps. Native `change` events bubble out of the light-DOM child, so
// element-local `change` listeners on the wrapper just work — no
// document-level mouse wiring, so toggling can never produce game input
// under the canvas pointer-lock discipline.
//
// Headless/fake-DOM safe: definitions are skipped without a real DOM, and
// `document.createElement('q2-...')` on a fake just yields a plain stub node
// carrying the same fields (type/checked/value/title/children).

/** Minimal structural contract renderCvarPanel relies on (real or fake node). */
interface Q2BoxNode {
  type: string;
  checked: boolean;
  title: string;
  addEventListener(type: string, fn: () => void): void;
}

/** Minimal structural contract for select/text wrappers. */
interface Q2ValueNode {
  value: string;
  title: string;
  addEventListener(type: string, fn: () => void): void;
}

/** Append an <option> to a select wrapper (real element or fake node). */
function appendOption(host: unknown, opt: unknown): void {
  const h = host as { addOption?: (o: unknown) => void; appendChild?: (o: never) => void };
  if (typeof h.addOption === 'function') h.addOption(opt);
  else h.appendChild?.(opt as never);
}

/** Link a control wrapper's inner native control to a label id (no-op on fakes). */
function bindControlId(host: unknown, id: string): void {
  const h = host as { bindControlId?: (id: string) => void };
  if (typeof h.bindControlId === 'function') h.bindControlId(id);
}

/** Define the q2-* custom elements once (no-op without a real DOM). */
function defineQ2Elements(): void {
  const g = globalThis as unknown as {
    HTMLElement?: typeof HTMLElement;
    customElements?: CustomElementRegistry;
  };
  const H = g.HTMLElement;
  const registry = g.customElements;
  if (!H || !registry || registry.get('q2-cvar-row')) return;

  class Q2SettingsPanel extends H {}
  class Q2Group extends H {}
  class Q2CvarRow extends H {}

  /** Checkbox wrapper: hosts one native checkbox, proxies its state. */
  class Q2Checkbox extends H {
    private boxEl: HTMLInputElement | null = null;
    private pendingChecked = false;
    private pendingTitle: string | null = null;
    private ensureBox(): HTMLInputElement {
      let box = this.boxEl;
      if (!box) {
        box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = this.pendingChecked;
        if (this.pendingTitle !== null) box.title = this.pendingTitle;
        this.boxEl = box;
        this.appendChild(box);
      }
      return box;
    }
    override get title(): string {
      return super.title;
    }
    override set title(v: string) {
      super.title = v;
      const box = this.boxEl;
      if (box) box.title = v;
      else this.pendingTitle = v;
    }
    get checked(): boolean {
      const box = this.boxEl;
      return box ? box.checked : this.pendingChecked;
    }
    set checked(v: boolean) {
      const box = this.boxEl;
      if (box) box.checked = v;
      else this.pendingChecked = v;
    }
    bindControlId(id: string): void {
      this.ensureBox().id = id;
    }
    connectedCallback(): void {
      this.ensureBox();
    }
  }

  /** Select wrapper: hosts one native select, proxies its value. */
  class Q2Select extends H {
    private selEl: HTMLSelectElement | null = null;
    private pendingValue: string | null = null;
    private pendingTitle: string | null = null;
    private ensureSel(): HTMLSelectElement {
      let sel = this.selEl;
      if (!sel) {
        sel = document.createElement('select');
        if (this.pendingValue !== null) sel.value = this.pendingValue;
        if (this.pendingTitle !== null) sel.title = this.pendingTitle;
        this.selEl = sel;
        this.appendChild(sel);
      }
      return sel;
    }
    override get title(): string {
      return super.title;
    }
    override set title(v: string) {
      super.title = v;
      const sel = this.selEl;
      if (sel) sel.title = v;
      else this.pendingTitle = v;
    }
    get value(): string {
      const sel = this.selEl;
      return sel ? sel.value : (this.pendingValue ?? '');
    }
    set value(v: string) {
      const sel = this.selEl;
      if (sel) sel.value = v;
      else this.pendingValue = v;
    }
    addOption(opt: HTMLOptionElement): void {
      this.ensureSel().appendChild(opt);
    }
    bindControlId(id: string): void {
      this.ensureSel().id = id;
    }
    connectedCallback(): void {
      const sel = this.ensureSel();
      if (this.pendingValue !== null) sel.value = this.pendingValue;
    }
  }

  /** Text wrapper: hosts one native text input, proxies its value. */
  class Q2Text extends H {
    private inputEl: HTMLInputElement | null = null;
    private pendingValue = '';
    private pendingTitle: string | null = null;
    private ensureInput(): HTMLInputElement {
      let input = this.inputEl;
      if (!input) {
        input = document.createElement('input');
        input.type = 'text';
        input.value = this.pendingValue;
        if (this.pendingTitle !== null) input.title = this.pendingTitle;
        this.inputEl = input;
        this.appendChild(input);
      }
      return input;
    }
    override get title(): string {
      return super.title;
    }
    override set title(v: string) {
      super.title = v;
      const input = this.inputEl;
      if (input) input.title = v;
      else this.pendingTitle = v;
    }
    get value(): string {
      const input = this.inputEl;
      return input ? input.value : this.pendingValue;
    }
    set value(v: string) {
      const input = this.inputEl;
      if (input) input.value = v;
      else this.pendingValue = v;
    }
    bindControlId(id: string): void {
      this.ensureInput().id = id;
    }
    connectedCallback(): void {
      this.ensureInput();
    }
  }

  registry.define('q2-settings-panel', Q2SettingsPanel);
  registry.define('q2-group', Q2Group);
  registry.define('q2-cvar-row', Q2CvarRow);
  registry.define('q2-checkbox', Q2Checkbox);
  registry.define('q2-select', Q2Select);
  registry.define('q2-text', Q2Text);
}

defineQ2Elements();

/** Render a cvar editor panel into a container. Returns bound cvar names. */
export function renderCvarPanel(
  container: unknown,
  filter = '',
  onChange: (name: string, value: string) => void = () => undefined,
): string[] {
  ensureHudCvars();
  const all = listCVars()
    .map((c) => c.name)
    .filter((n) => !filter || n.includes(filter));
  if (typeof document === 'undefined' || !container) return all;
  const node = container as HTMLElement;
  node.innerHTML = '';
  const names: string[] = [];
  for (const group of GROUP_ORDER) {
    const grouped = all.filter((n) => cvarGroup(n) === group).sort();
    if (grouped.length === 0) continue;
    const head = document.createElement('q2-group');
    head.className = 'q2-cvar-group';
    head.textContent = group;
    node.appendChild(head);
    for (const name of grouped) {
      renderCvarRow(node, name, onChange);
      names.push(name);
    }
  }
  return names;
}

/** Render one labeled cvar row (<q2-cvar-row>) into the panel. */
function renderCvarRow(
  node: HTMLElement,
  name: string,
  onChange: (n: string, v: string) => void,
): void {
  const row = document.createElement('q2-cvar-row');
  row.className = 'q2-cvar-row';
  // On-hover description for the row (tooltip source: the cvar registry
  // doc, static fallback in CVAR_DESCRIPTIONS — see cvarDescription).
  const tip = cvarDescription(name);
  if (tip) row.title = tip;
  const label = document.createElement('label');
  label.textContent = name;
  if (tip) label.title = tip;
  // Keyboard access: label linked to the inner native control (real DOM
  // forwards via bindControlId; fakes keep the expando harmlessly).
  const controlId = `q2c-${name}`;
  (label as unknown as { htmlFor?: string }).htmlFor = controlId;
  const options = cvarOptions(name);
  const current = getCVarString(name);
  if (cvarIsCheckbox(name)) {
    // Boolean checkbox: element-local `change` only, no document-level
    // mouse wiring, so toggling never produces game input (canvas
    // pointer-lock discipline holds — UI clicks never fire).
    const box = document.createElement('q2-checkbox') as unknown as Q2BoxNode;
    box.type = 'checkbox';
    box.checked = getCVarNumber(name) !== 0;
    if (tip) box.title = tip;
    bindControlId(box, controlId);
    box.addEventListener('change', () => {
      try {
        const next = box.checked ? '1' : '0';
        setCVarFromString(name, next);
        onChange(name, next);
      } catch {
        box.checked = getCVarNumber(name) !== 0;
      }
    });
    row.appendChild(label);
    row.appendChild(box as unknown as HTMLElement);
  } else if (options !== null) {
    const select = document.createElement('q2-select') as unknown as Q2ValueNode;
    if (tip) select.title = tip;
    bindControlId(select, controlId);
    // Reflect out-of-list values (e.g. sw_workers=8, r_brightness=1.1)
    // instead of silently showing the wrong preset.
    const choices = options.includes(current) ? options : [current, ...options];
    // Labeled domains (skill 0-3 → Easy/Medium/Hard/Nightmare, resolution
    // WxH → 320×240…) persist the bare value; the label is display-only.
    const labels = cvarOptionLabels(name);
    for (const opt of choices) {
      const el = document.createElement('option');
      el.value = opt;
      const li = labels ? options.indexOf(opt) : -1;
      el.textContent = li >= 0 ? labels![li]! : opt;
      appendOption(select, el);
    }
    select.value = current;
    select.addEventListener('change', () => {
      try {
        setCVarFromString(name, select.value);
        onChange(name, select.value);
      } catch {
        select.value = getCVarString(name);
      }
    });
    row.appendChild(label);
    row.appendChild(select as unknown as HTMLElement);
  } else {
    const input = document.createElement('q2-text') as unknown as Q2ValueNode;
    input.value = current;
    if (tip) input.title = tip;
    bindControlId(input, controlId);
    input.addEventListener('change', () => {
      try {
        setCVarFromString(name, input.value);
        onChange(name, input.value);
      } catch {
        input.value = getCVarString(name);
      }
    });
    row.appendChild(label);
    row.appendChild(input as unknown as HTMLElement);
  }
  node.appendChild(row);
}

/** Renderer switcher state (software/voodoo), persisted to cvar. */
export function getRendererChoice(): string {
  return getCVarString('vid_renderer') || 'software';
}

export function setRendererChoice(kind: string): void {
  setCVarFromString('vid_renderer', kind === 'voodoo' ? 'voodoo' : 'software');
}

// --- play loop (rAF driver for a booted game; DOM-guarded) ---

import type { Host } from '@q2/host';
import type { LocalDriver, PlayBoot } from './play.js';
import {
  applyVoodooPresentation,
  attachBrowserPool,
  createAsyncLoopState,
  drawPlayHud,
  frameAsync,
  hudComposedPreScanout,
  pumpExplosionLights,
  pumpMuzzleLight,
  pumpTracers,
  resolveDisplay,
} from './play.js';
import type { AsyncLoopState } from './play.js';
import { browserPoolAvailable, defaultBrowserWorkers } from './render-workers.js';
import type { BrowserBandPool } from './render-workers.js';
import { attachToCanvas } from '@q2/input/dom';
import { readPakEntry, findPakSoundEntry } from './pak.js';
import type { Mixer, MixedChannel } from '@q2/sound';

export interface PlayLoop {
  readonly host: Host;
  readonly driver: LocalDriver;
  stop(): void;
}

/** Cap for the per-name decoded pak wav cache (insertion-order eviction). */
export const MAX_CACHED_SOUNDS = 24;

/** Weapon-ish channel names keep the old preloaded-shot fallback. */
const SHOT_FALLBACK_RE = /blast|shotg|machin|gunfire|shot/;

export interface BrowserSound {
  ctx: AudioContext;
  master: GainNode;
  /** The dropped pak (null in devroom): source for per-name wav decodes. */
  pak: WebPak | null;
  /** Preloaded preferred weapon wav: instant first shots + fallback. */
  shot: AudioBuffer | null;
  /** Decoded pak wavs by resolved entry name (see findPakSoundEntry). */
  sounds: Map<string, AudioBuffer>;
  /** Entry names with a decode currently in flight (no duplicate work). */
  pending: Set<string>;
  channels: Map<number, ChannelNodes>;
  dispose(): void;
}

interface ChannelNodes {
  gain: GainNode;
  pan: StereoPannerNode | null;
  src: AudioBufferSourceNode | OscillatorNode;
}

async function decodeShotSound(ctx: AudioContext, pak: WebPak): Promise<AudioBuffer | null> {
  const { decodeWav } = await import('@q2/sound/browser');
  const names = pak.entries.map((e) => e.name).filter((n) => n.endsWith('.wav'));
  const pick =
    names.find((n) => n.includes('blast')) ??
    names.find((n) => n.includes('shotg')) ??
    names.find((n) => n.includes('machin')) ??
    names.find((n) => n.includes('gun')) ??
    null;
  if (!pick) return null;
  try {
    return await decodeWav(ctx, readPakEntry(pak, pick));
  } catch {
    return null;
  }
}

/**
 * Resolve a mixer channel name to its pak entry name (`readPakEntry` terms),
 * or null when the pak is absent or lacks the lump (→ shot/synth fallback).
 * Pure and headless-safe.
 */
export function resolveChannelSound(name: string, pak: WebPak | null): string | null {
  if (!pak) return null;
  return findPakSoundEntry(pak, name)?.name ?? null;
}

/**
 * Insert a decoded wav into the per-name cache, evicting the oldest entries
 * past MAX_CACHED_SOUNDS. Re-setting an existing name refreshes recency.
 * Pure Map operation, headless-safe.
 */
export function cacheSoundBuffer(
  sounds: Map<string, AudioBuffer>,
  key: string,
  buf: AudioBuffer,
): void {
  if (sounds.has(key)) sounds.delete(key);
  sounds.set(key, buf);
  while (sounds.size > MAX_CACHED_SOUNDS) {
    const oldest = sounds.keys().next();
    if (oldest.done) break;
    sounds.delete(oldest.value);
  }
}

/**
 * Decode one pak lump and cache it under its entry name. Never throws:
 * decode failures resolve to null and just clear the pending mark so a
 * later channel retries. Works with a stub ctx (tests) or real AudioContext.
 */
export async function decodeAndCacheSound(
  sound: BrowserSound,
  entryName: string,
  wav: ArrayBuffer,
): Promise<AudioBuffer | null> {
  try {
    const { decodeWav } = await import('@q2/sound/browser');
    const buf = await decodeWav(sound.ctx, wav);
    cacheSoundBuffer(sound.sounds, entryName, buf);
    return buf;
  } catch {
    return null;
  } finally {
    sound.pending.delete(entryName);
  }
}

function blip(ctx: AudioContext, master: GainNode, freq: number, dur: number, when = 0): void {
  try {
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch {
    /* audio unavailable */
  }
}

/**
 * Drive a booted game on a canvas: pointer-lock input, rAF frames,
 * voodoo resolve, HUD, blit, and gesture-unlocked sound. No-op without DOM.
 */
export function startPlayLoop(
  canvas: unknown,
  boot: PlayBoot,
  opts: { pak?: WebPak | null } = {},
): PlayLoop {
  const { host, driver } = boot;
  const noop = { host, driver, stop(): void { /* noop */ } };
  if (typeof document === 'undefined' || typeof window === 'undefined' || !canvas) return noop;
  const el = canvas as HTMLCanvasElement;
  const bindings = attachToCanvas(el, host.input);
  el.style.imageRendering = 'pixelated';
  el.style.width = `${host.fb.width * 2}px`;
  el.style.height = `${host.fb.height * 2}px`;

  let sound: BrowserSound | null = null;
  let shotLoading = false;
  const unlock = (): void => {
    void import('@q2/sound/browser')
      .then((mod) => {
        if (!sound) {
          const created = mod.createBrowserMixer(host.mixer);
          sound = {
            ...created,
            pak: opts.pak ?? null,
            shot: null,
            sounds: new Map(),
            pending: new Set(),
            channels: new Map(),
          };
        }
        const s = sound;
        if (s.ctx.state === 'suspended') void s.ctx.resume().catch(() => undefined);
        if (!s.shot && !shotLoading && opts.pak) {
          shotLoading = true;
          void decodeShotSound(s.ctx, opts.pak)
            .then((buf) => {
              s.shot = buf;
            })
            .catch(() => undefined)
            .finally(() => {
              shotLoading = false;
            });
        }
      })
      .catch(() => undefined);
  };

  const onWeaponKeys = (e: KeyboardEvent): void => {
    if (e.code === 'Digit1') driver.selectWeapon('weapon_blaster');
    if (e.code === 'Digit2') driver.selectWeapon('weapon_shotgun');
    if (e.code === 'Digit3') driver.selectWeapon('weapon_machinegun');
  };

  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);
  document.addEventListener('keydown', onWeaponKeys);

  let raf = 0;
  let stopped = false;
  let lastT = -1;
  let fps = 60;
  let frame = 0;

  // Worker pool warm-up (M7.1 perf lane): pre-spawn ONCE per loop, never per
  // frame. When the browser can run workers and the operator left sw_workers
  // at its default 0, latch a hardwareConcurrency-capped count so the live
  // loop runs pooled with no manual tuning; an explicit nonzero sw_workers
  // is honored as-is. Headless/Node (no DOM/SAB/isolation) skips all of this
  // and stays on the classic single-threaded path.
  let pool: BrowserBandPool | null = null;
  try {
    if (browserPoolAvailable() && !(getCVarNumber('sw_workers') > 0)) {
      setCVarFromString('sw_workers', String(defaultBrowserWorkers()));
    }
    pool = attachBrowserPool(boot);
  } catch {
    pool = null;
  }
  // Async-loop state (frameAsync's mirror of Host privates). Null pool →
  // classic sync path below, pixel-identical (frameAsync ≡ host.frame).
  const asyncSt: AsyncLoopState = createAsyncLoopState();
  let useAsync = pool !== null;
  let busy = false;

  // Reused blit wrapper: points at the resolved display buffer every frame
  // (avoids the old per-frame `{...host.fb, color: target}` spread garbage).
  const blitFb: Framebuffer = {
    width: host.fb.width,
    height: host.fb.height,
    color: host.fb.color,
    index: host.fb.index,
    depth: host.fb.depth,
  };

  /** Shared post-render tail (HUD + blit + sound/event cues), both paths. */
  const finishFrame = (target: Uint32Array, hud: { fps: number; frame: number }): void => {
    // V2d strict voodoo: HUD was already composed into the emulated target
    // BEFORE scanout (paintHudPreScanout via resolveDisplay/frameAsync) —
    // painting again here would double-paint and defeat the strict ordering.
    // Legacy/software paths paint HUD after resolve as before.
    if (!hudComposedPreScanout(boot)) {
      drawPlayHud(
        { width: host.fb.width, height: host.fb.height, color: target },
        boot,
        hud,
      );
    } else {
      // Strict presentation: controlled upscale only (pixelated, no second
      // smoothing pass); debug controls stay DOM-side, outside the image.
      applyVoodooPresentation(el);
    }
    blitFb.color = target;
    blitToCanvas(el, blitFb);
    // Headless/browser-soak observability (no behavior change): publish the
    // loop's fps EMA + frame counter for CDP-driven measurement (the
    // in-canvas glyphs are not machine-readable). Single reused record, one
    // store per frame, never allocated in steady state.
    try {
      const g = globalThis as unknown as { __q2stats?: { fps: number; frame: number } };
      const rec = g.__q2stats ?? (g.__q2stats = { fps: 0, frame: 0 });
      rec.fps = fps;
      rec.frame = frame;
    } catch {
      /* non-DOM/shimmed runtimes stay silent */
    }
    // The fps (`cl_showfps`) and position (`cl_showpos`, default ON)
    // readouts are in-canvas conchars glyphs painted by drawPlayHud above
    // (top-right / top-left of the framebuffer itself) — no DOM overlay.
    // Per-channel positional audio: Mixer.mix() gains drive real nodes.
    // The driver already set the listener + started channels in step().
    if (sound) syncMixerToBrowser(sound, driver.mixer);
    for (const ev of driver.events.splice(0)) {
      if (!sound) continue;
      if (ev === 'kill') blip(sound.ctx, sound.master, 660, 0.12);
      else if (ev === 'hit') blip(sound.ctx, sound.master, 440, 0.06);
      else if (ev === 'exit' || ev === 'finished') {
        blip(sound.ctx, sound.master, 523, 0.15);
        blip(sound.ctx, sound.master, 784, 0.25, 0.15);
      }
    }
  };

  const tickSync = (nowMs: number): void => {
    if (lastT >= 0) {
      const dt = nowMs - lastT;
      if (dt > 0) fps += (1000 / dt - fps) * 0.05;
    }
    lastT = nowMs;
    // Muzzle dlight + tracer beams must be registered before the renderer draws the frame.
    pumpMuzzleLight(boot);
    pumpExplosionLights(boot);
    pumpTracers(boot);
    host.frame(nowMs);
    // V2d: hud threads into resolveDisplay so strict voodoo composes it
    // pre-scanout; finishFrame skips the post pass in that case (no double).
    const hud = { fps, frame: frame++ };
    const target = resolveDisplay(boot, hud);
    finishFrame(target, hud);
  };

  const tick = (nowMs: number): void => {
    if (stopped) return;
    if (useAsync) {
      // Pooled async render (frameAsync owns pumps + sim + async kick +
      // resolve — do NOT pre-pump here: a second drain would clear the
      // just-added muzzle flash). Never block the main thread and never
      // overlap frames (the renderer stash is non-reentrant and the sim must
      // not double-pump): a still-running frame drops this rAF tick, and the
      // next tick's dt covers the gap via AsyncLoopState (dt clamps at 0.25).
      if (busy) {
        raf = requestAnimationFrame(tick);
        return;
      }
      busy = true;
      void (async (): Promise<void> => {
        try {
          if (lastT >= 0) {
            const dt = nowMs - lastT;
            if (dt > 0) fps += (1000 / dt - fps) * 0.05;
          }
          lastT = nowMs;
          const hud = { fps, frame: frame++ };
          const target = await frameAsync(boot, asyncSt, nowMs, hud);
          finishFrame(target, hud);
        } catch {
          // One bad frame (worker timeout, torn-down pool) falls back to the
          // classic sync path from the next tick — inline replay converges to
          // identical pixels, so the loop never wedges and never tears.
          useAsync = false;
          try {
            boot.refresh.syncWorkersFromCvar();
          } catch {
            /* classic single-threaded path stays active */
          }
        } finally {
          busy = false;
          if (!stopped) raf = requestAnimationFrame(tick);
        }
      })();
      return;
    }
    tickSync(nowMs);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    host,
    driver,
    stop(): void {
      stopped = true;
      cancelAnimationFrame(raf);
      bindings.dispose();
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
      document.removeEventListener('keydown', onWeaponKeys);
      const p = pool;
      pool = null;
      useAsync = false;
      if (p) void p.dispose().catch(() => undefined);
      if (sound) {
        for (const ch of sound.channels.values()) {
          try {
            ch.src.stop();
          } catch {
            /* already stopped */
          }
          try {
            ch.gain.disconnect();
          } catch {
            /* already disconnected */
          }
        }
        sound.channels.clear();
      }
      sound?.dispose();
      sound = null;
    },
  };
}

/** Pick a synth fallback pitch per sound family (used when no pak wav decoded). */
function soundFreqFor(name: string): number {
  if (name.includes('blast')) return 220;
  if (name.includes('shotg')) return 180;
  if (name.includes('machin')) return 260;
  if (name.includes('door')) return 90;
  if (name.includes('button')) return 140;
  if (name.includes('pickup')) return 520;
  if (name.includes('pain')) return 330;
  if (name.includes('death')) return 110;
  if (name.includes('melee')) return 150;
  if (name.includes('noammo')) return 700;
  return 440;
}

/**
 * Wire per-channel mixer gains to real WebAudio nodes (M7.2 + per-name pak
 * decode follow-up).
 *
 * The driver owns a headless Mixer: step() sets the listener from the player
 * and startSound()s positional channels (shots, doors, pickups, monster
 * fire). Here mix() spatializes them and each live channel drives a
 * GainNode (+StereoPannerNode when available). New channels play their OWN
 * named pak wav when it has been decoded and cached (decoded lazily on
 * first use, one in-flight decode per name, capped at MAX_CACHED_SOUNDS);
 * while the decode runs — or when the pak lacks the name — they fall back
 * to the preloaded shot buffer (weapon-ish names) or a short synth blip,
 * exactly the M7.2 behaviour. Vanished channels are stopped and
 * disconnected. Positional shots/door moves/pickups therefore come through
 * the mixer — no fixed one-shot cue path remains for them.
 */
export function syncMixerToBrowser(sound: BrowserSound, mixer: Mixer): MixedChannel[] {
  const mixed = mixer.mix();
  const live = new Set<number>();
  for (const ch of mixed) {
    live.add(ch.id);
    const level = Math.max(0, Math.min(1, (ch.left + ch.right) / 2));
    const denom = ch.left + ch.right;
    const pan = denom > 1e-6 ? Math.max(-1, Math.min(1, (ch.right - ch.left) / denom)) : 0;
    let nodes = sound.channels.get(ch.id);
    if (!nodes) {
      try {
        const gain = sound.ctx.createGain();
        let panNode: StereoPannerNode | null = null;
        try {
          if (typeof sound.ctx.createStereoPanner === 'function') {
            panNode = sound.ctx.createStereoPanner();
            gain.connect(panNode);
            panNode.connect(sound.master);
          } else {
            gain.connect(sound.master);
          }
        } catch {
          try {
            gain.connect(sound.master);
          } catch {
            /* no destination */
          }
        }
        let src: AudioBufferSourceNode | OscillatorNode;
        const entryName = resolveChannelSound(ch.name, sound.pak);
        const cached = entryName !== null ? sound.sounds.get(entryName) : undefined;
        if (entryName !== null && cached !== undefined) {
          // Per-name cache hit: this channel's own decoded pak wav. Refresh
          // recency so hot sounds survive eviction.
          sound.sounds.delete(entryName);
          sound.sounds.set(entryName, cached);
          const buf = sound.ctx.createBufferSource();
          buf.buffer = cached;
          buf.connect(gain);
          src = buf;
        } else {
          if (entryName !== null && sound.pak && !sound.pending.has(entryName)) {
            // Lazy per-name decode: this shot still uses the fallback below
            // while the decode runs; later channels with this name hit the
            // cache. One in-flight decode per name; failures clear `pending`
            // so a later channel retries.
            sound.pending.add(entryName);
            let wav: ArrayBuffer | null = null;
            try {
              wav = readPakEntry(sound.pak, entryName);
            } catch {
              wav = null;
            }
            if (wav) void decodeAndCacheSound(sound, entryName, wav);
            else sound.pending.delete(entryName);
          }
          if (sound.shot && SHOT_FALLBACK_RE.test(ch.name)) {
            const buf = sound.ctx.createBufferSource();
            buf.buffer = sound.shot;
            buf.connect(gain);
            src = buf;
          } else {
            const osc = sound.ctx.createOscillator();
            osc.frequency.value = soundFreqFor(ch.name);
            osc.connect(gain);
            src = osc;
          }
        }
        gain.gain.value = level;
        if (panNode) panNode.pan.value = pan;
        try {
          src.start();
        } catch {
          /* already started */
        }
        nodes = { gain, pan: panNode, src };
        sound.channels.set(ch.id, nodes);
      } catch {
        continue;
      }
    } else {
      try {
        nodes.gain.gain.value = level;
      } catch {
        /* node gone */
      }
      try {
        if (nodes.pan) nodes.pan.pan.value = pan;
      } catch {
        /* node gone */
      }
    }
  }
  for (const [id, nodes] of [...sound.channels]) {
    if (live.has(id)) continue;
    try {
      nodes.src.stop();
    } catch {
      /* already stopped */
    }
    try {
      nodes.gain.disconnect();
    } catch {
      /* already disconnected */
    }
    sound.channels.delete(id);
  }
  return mixed;
}
