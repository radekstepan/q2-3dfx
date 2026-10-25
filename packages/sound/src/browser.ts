// @q2/sound/browser — WebAudio backend. Browser-only; importing from
// Node is safe (no AudioContext is constructed at module scope).
import type { Mixer } from './index.js';

export interface BrowserMixer {
  ctx: AudioContext;
  master: GainNode;
  mixer: Mixer;
  dispose(): void;
}

/** Create a live WebAudio mixer. Throws outside a browser. */
export function createBrowserMixer(mixer: Mixer): BrowserMixer {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') {
    throw new Error('createBrowserMixer requires a browser AudioContext');
  }
  const Ctor: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  const master = ctx.createGain();
  master.connect(ctx.destination);
  return {
    ctx,
    master,
    mixer,
    dispose(): void {
      void ctx.close().catch(() => undefined);
    },
  };
}

/** Decode a .wav lump into an AudioBuffer (browser only). */
export async function decodeWav(ctx: AudioContext, wav: ArrayBuffer): Promise<AudioBuffer> {
  return ctx.decodeAudioData(wav.slice(0));
}
