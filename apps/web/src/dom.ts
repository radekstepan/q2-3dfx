// q2ts-web DOM layer: drop zone, canvas blit, cvar panel, progress (M7.1).
//
// Browser-only. All functions no-op / return null without a DOM so Node
// tests can import this module safely. Canvas code is isolated here —
// `index.ts` and `devroom.ts` never touch `document`.
import { getCVarString, listCVars, setCVarFromString } from '@q2/config';
import type { Framebuffer } from '@q2/renderer-api';
import { ingestPak } from './pak.js';
import type { WebPak } from './pak.js';

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

/** Render a cvar editor panel into a container. Returns bound cvar names. */
export function renderCvarPanel(container: unknown, filter = ''): string[] {
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
    const input = document.createElement('input');
    input.value = getCVarString(name);
    input.addEventListener('change', () => {
      try {
        setCVarFromString(name, input.value);
      } catch {
        input.value = getCVarString(name);
      }
    });
    row.appendChild(label);
    row.appendChild(input);
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
import { drawPlayHud, resolveDisplay } from './play.js';
import { attachToCanvas } from '@q2/input/dom';
import { readPakEntry } from './pak.js';

export interface PlayLoop {
  readonly host: Host;
  readonly driver: LocalDriver;
  stop(): void;
}

interface BrowserSound {
  ctx: AudioContext;
  master: GainNode;
  shot: AudioBuffer | null;
  dispose(): void;
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
          sound = { ...created, shot: null };
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

  const playShot = (): void => {
    if (!sound) return;
    const s = sound;
    try {
      if (s.shot) {
        const src = s.ctx.createBufferSource();
        src.buffer = s.shot;
        src.connect(s.master);
        src.start();
      } else {
        blip(s.ctx, s.master, 220, 0.08);
      }
    } catch {
      /* ignore */
    }
  };

  let raf = 0;
  let stopped = false;
  let lastT = -1;
  let fps = 60;
  let frame = 0;
  const tick = (nowMs: number): void => {
    if (stopped) return;
    if (lastT >= 0) {
      const dt = nowMs - lastT;
      if (dt > 0) fps += (1000 / dt - fps) * 0.05;
    }
    lastT = nowMs;
    host.frame(nowMs);
    const target = resolveDisplay(boot);
    drawPlayHud(
      { width: host.fb.width, height: host.fb.height, color: target },
      boot,
      { fps, frame: frame++ },
    );
    blitToCanvas(el, { ...host.fb, color: target });
    for (const ev of driver.events.splice(0)) {
      if (ev === 'shot') playShot();
      else if (ev === 'kill' && sound) blip(sound.ctx, sound.master, 660, 0.12);
      else if (ev === 'hit' && sound) blip(sound.ctx, sound.master, 440, 0.06);
      else if (ev === 'exit' && sound) {
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
      sound?.dispose();
      sound = null;
    },
  };
}
