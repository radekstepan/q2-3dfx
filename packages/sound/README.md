# @q2/sound

Positional audio math + WebAudio backend (`client/snd_*`).

## What it is

Pure headless core (`index.ts`): Quake attenuation curves, stereo
spatialization, and a `Mixer` that reduces channels to per-tick gains
(`mix()`). No bytes, no `AudioContext` — the shell feeds decoded PCM.
Browser backend (`browser.ts`, `@q2/sound/browser` subpath):
`createBrowserMixer` (master gain → destination) and `decodeWav`
(`decodeAudioData` of a `.wav` lump). Per-channel nodes/scheduling are not
implemented yet; the web shell plays one-shots (shots, hits, exit jingle).

## Public API

- `attenuation(dist, attn?)`, `spatialize(listener, right, src, attn, vol)`,
  `Mixer { setListener, startSound, stopSound, mix() }`.
- `createBrowserMixer(mixer): BrowserMixer { ctx, master, mixer, dispose }`,
  `decodeWav(ctx, wav): Promise<AudioBuffer>`.

## How it is used

`@q2/host` owns a headless `Mixer`. `apps/web` creates the browser mixer on
first user gesture (autoplay policy: `resume()` on pointerdown/keydown),
decodes a `weapons/blast*` lump when a pak is present, and plays shot/hit/
kill/exit cues from driver events each frame.

## Testing

`yarn workspace @q2/sound test` — attenuation/spatialize/mix math. No
browser tests (no `AudioContext` in Node/CI).

## Constraints

Library entry is DOM-free; `./browser` throws outside a browser by design.
Only depends on `@q2/config` (`s_volume`). No streaming, no loop scheduling.
