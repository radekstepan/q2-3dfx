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
