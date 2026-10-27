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

registerCVar('cl_showfps', 1, 'show DOM fps overlay (and in-canvas fps readout)');
registerCVar('cl_showpos', 1, 'show DOM player-position overlay top-left (pos x y z yaw)');

/** DOM overlay element ids (see index.html). FPS top-right, pos top-left. */
export const FPS_OVERLAY_ID = 'q2-fps';
export const POS_OVERLAY_ID = 'q2-pos';

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

/** Pure helper: readable fps line with ms/frame for the DOM overlay. */
export function formatFps(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return 'fps --';
  const rounded = Math.round(fps);
  const ms = 1000 / fps;
  return `fps ${rounded} · ${ms.toFixed(1)} ms`;
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

/**
 * Write the fps line into a DOM node. DOM-guarded: with no `document`
 * (Node/vitest) or a null element it just returns the text. Returns the
 * text written (or that would have been written).
 */
export function updateFpsOverlay(el: unknown, fps: number, visible = true): string {
  const text = formatFps(fps);
  const node = el as { textContent?: unknown; style?: { display?: string } } | null;
  if (!node || typeof node !== 'object') return text;
  try {
    if (visible) {
      if (typeof node.textContent === 'string' || node.textContent === undefined) {
        (node as { textContent: string }).textContent = text;
      }
      if (node.style && typeof node.style === 'object') node.style.display = '';
    } else if (node.style && typeof node.style === 'object') {
      node.style.display = 'none';
    }
  } catch {
    /* non-DOM stub */
  }
  return text;
}

/**
 * Write the position line into a DOM node. DOM-guarded like
 * `updateFpsOverlay`: null / non-DOM input just returns the text.
 */
export function updatePosOverlay(el: unknown, text: string, visible = true): string {
  const node = el as { textContent?: unknown; style?: { display?: string } } | null;
  if (!node || typeof node !== 'object') return text;
  try {
    if (visible) {
      if (typeof node.textContent === 'string' || node.textContent === undefined) {
        (node as { textContent: string }).textContent = text;
      }
      if (node.style && typeof node.style === 'object') node.style.display = '';
    } else if (node.style && typeof node.style === 'object') {
      node.style.display = 'none';
    }
  } catch {
    /* non-DOM stub */
  }
  return text;
}

/** Blit a 0xAABBGGRR framebuffer into a <canvas> via putImageData. */
export function blitToCanvas(canvas: unknown, fb: Framebuffer): boolean {
  if (typeof document === 'undefined') return false;
  const el = canvas as HTMLCanvasElement;
  if (!el || typeof el.getContext !== 'function') return false;
  if (el.width !== fb.width || el.height !== fb.height) {
    el.width = fb.width;
    el.height = fb.height;
  }
  const ctx = el.getContext('2d');
  if (!ctx) return false;
  const img = ctx.createImageData(fb.width, fb.height);
  const dst = img.data;
  const src = new Uint8Array(fb.color.buffer, fb.color.byteOffset, fb.color.length * 4);
  // 0xAABBGGRR -> RGBA bytes.
  for (let i = 0, j = 0; i < src.length; i += 4, j += 4) {
    dst[j] = src[i]!;
    dst[j + 1] = src[i + 1]!;
    dst[j + 2] = src[i + 2]!;
    dst[j + 3] = src[i + 3]!;
  }
  ctx.putImageData(img, 0, 0);
  return true;
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
  cl_showfps: ['0', '1'],
  r_brightness: ['0.75', '1.0', '1.25', '1.5', '2.0'],
  vd_gamma: ['1.0', '1.3', '2.2'],
  vd_16bit: ['0', '1'],
  vd_dither: ['0', '1'],
  vd_postfilter: ['0', '1'],
  vd_bilinear: ['0', '1'],
  vd_mipdither: ['0', '1'],
  vd_fog: ['0', '1'],
  vd_palettetex: ['0', '1'],
  vd_overbright: ['0', '1'],
  r_drawworld: ['0', '1'],
  cl_predict: ['0', '1'],
  cl_interp: ['0', '1'],
};

/** Re-register HUD overlay cvars if a test `resetCVars()` wiped them, so the
 * menu panel keeps listing them and headless boots stay deterministic. */
function ensureHudCvars(): void {
  if (getCVar('cl_showfps') === undefined) {
    registerCVar('cl_showfps', 1, 'show DOM fps overlay (and in-canvas fps readout)');
  }
  if (getCVar('cl_showpos') === undefined) {
    registerCVar('cl_showpos', 1, 'show DOM player-position overlay top-left (pos x y z yaw)');
  }
}

/**
 * Boolean cvars rendered as checkboxes (element-local `change` listeners,
 * never document-level mouse wiring — so toggling them can never produce
 * game input under the canvas pointer-lock discipline).
 */
export const CHECKBOX_CVARS: ReadonlySet<string> = new Set(['cl_showpos']);

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
 * Display labels for a cvar's options (currently skill + resolution).
 */
export function cvarOptionLabels(name: string): readonly string[] | null {
  if (name === 'skill') return SKILL_LABELS;
  if (name === 'vid_resolution') return RESOLUTION_LABELS;
  if (name === 'map_source') return MAP_SOURCE_LABELS;
  return null;
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

/** Render a cvar editor panel into a container. Returns bound cvar names. */
export function renderCvarPanel(
  container: unknown,
  filter = '',
  onChange: (name: string, value: string) => void = () => undefined,
): string[] {  ensureHudCvars();
  const names = listCVars()
    .map((c) => c.name)
    .filter((n) => !filter || n.includes(filter));
  if (typeof document === 'undefined' || !container) return names;
  const node = container as HTMLElement;
  node.innerHTML = '';
  for (const name of names) {
    const row = document.createElement('div');
    row.className = 'q2-cvar-row';
    const label = document.createElement('label');
    label.textContent = name;
    const options = cvarOptions(name);
    const current = getCVarString(name);
    if (cvarIsCheckbox(name)) {
      // Boolean checkbox: element-local `change` only, no document-level
      // mouse wiring, so toggling never produces game input (canvas
      // pointer-lock discipline holds — UI clicks never fire).
      const box = document.createElement('input') as HTMLInputElement;
      box.type = 'checkbox';
      box.checked = getCVarNumber(name) !== 0;
      box.addEventListener('change', () => {
        try {
          setCVarFromString(name, box.checked ? '1' : '0');
          onChange(name, box.checked ? '1' : '0');
        } catch {
          box.checked = getCVarNumber(name) !== 0;
        }
      });
      row.appendChild(label);
      row.appendChild(box);
    } else if (options !== null) {
      const select = document.createElement('select');
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
        select.appendChild(el);
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
      row.appendChild(select);
    } else {
      const input = document.createElement('input');
      input.value = current;
      input.addEventListener('change', () => {
        try {
          setCVarFromString(name, input.value);
          onChange(name, input.value);
        } catch {
          input.value = getCVarString(name);
        }
      });
      row.appendChild(label);
      row.appendChild(input);
    }
    node.appendChild(row);
  }
  return names;
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
import { drawPlayHud, playerPosText, pumpExplosionLights, pumpMuzzleLight, pumpTracers, resolveDisplay } from './play.js';
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
  // Display-only DOM readouts (never touch renderer output): fps top-right,
  // player position top-left. Queried once; per-frame updates below.
  const fpsEl = document.querySelector(`#${FPS_OVERLAY_ID}`);
  const posEl = document.querySelector(`#${POS_OVERLAY_ID}`);
  const tick = (nowMs: number): void => {
    if (stopped) return;
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
    const target = resolveDisplay(boot);
    drawPlayHud(
      { width: host.fb.width, height: host.fb.height, color: target },
      boot,
      { fps, frame: frame++ },
    );
    blitToCanvas(el, { ...host.fb, color: target });
    // DOM overlays, post-resolve: the canvas pixels are already blitted, so
    // these readouts can never alter renderer output. Gated by
    // cl_showfps (fps) / cl_showpos (position, default ON).
    updateFpsOverlay(fpsEl, fps, showFpsEnabled());
    updatePosOverlay(posEl, playerPosText(driver), showPosEnabled());
    // Per-channel positional audio: Mixer.mix() gains drive real nodes.
    // The driver already set the listener + started channels in step().
    if (sound) syncMixerToBrowser(sound, driver.mixer);
    for (const ev of driver.events.splice(0)) {
      if (!sound) continue;
      if (ev === 'kill') blip(sound.ctx, sound.master, 660, 0.12);
      else if (ev === 'hit') blip(sound.ctx, sound.master, 440, 0.06);
      else if (ev === 'exit') {
        blip(sound.ctx, sound.master, 523, 0.15);
        blip(sound.ctx, sound.master, 784, 0.25, 0.15);
      }
    }
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
