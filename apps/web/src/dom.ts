// q2ts-web DOM layer: drop zone, canvas blit, cvar panel, progress (M7.1).
//
// Browser-only. All functions no-op / return null without a DOM so Node
// tests can import this module safely. Canvas code is isolated here —
// `index.ts` and `devroom.ts` never touch `document`.
import { getCVar, getCVarNumber, getCVarString, listCVars, registerCVar, setCVarFromString } from '@q2/config';
import type { Framebuffer } from '@q2/renderer-api';
import { ingestPak } from './pak.js';
import type { WebPak } from './pak.js';

registerCVar('cl_showfps', 1, 'show DOM fps overlay (and in-canvas fps readout)');

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

/** Option list for a cvar, or null when it takes free-text input. */
export function cvarOptions(name: string): readonly string[] | null {
  return CVAR_OPTIONS[name] ?? null;
}

/** Control kind for a cvar row: 'select' for known domains, else 'text'. */
export function cvarControlKind(name: string): 'select' | 'text' {
  return cvarOptions(name) === null ? 'text' : 'select';
}

/** Render a cvar editor panel into a container. Returns bound cvar names. */
export function renderCvarPanel(container: unknown, filter = ''): string[] {  const names = listCVars()
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
    if (options !== null) {
      const select = document.createElement('select');
      // Reflect out-of-list values (e.g. sw_workers=8, r_brightness=1.1)
      // instead of silently showing the wrong preset.
      const choices = options.includes(current) ? options : [current, ...options];
      for (const opt of choices) {
        const el = document.createElement('option');
        el.value = opt;
        el.textContent = opt;
        select.appendChild(el);
      }
      select.value = current;
      select.addEventListener('change', () => {
        try {
          setCVarFromString(name, select.value);
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
import { drawPlayHud, pumpExplosionLights, pumpMuzzleLight, pumpTracers, resolveDisplay } from './play.js';
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
  let lastOverlayMs = -Infinity;
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
    // DOM overlay mirror of the in-canvas `fps N` (throttled to ~4Hz so
    // text updates never cause layout thrash). Gated by `cl_showfps`.
    if (nowMs - lastOverlayMs >= 250) {
      lastOverlayMs = nowMs;
      try {
        updateFpsOverlay(document.getElementById('q2-fps'), fps, showFpsEnabled());
      } catch {
        /* DOM unavailable mid-teardown */
      }
    }
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
