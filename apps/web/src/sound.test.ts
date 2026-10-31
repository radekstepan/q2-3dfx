// Per-name pak wav decode (M7.2 follow-up): name→entry resolution, bounded
// cache, lazy decode, and syncMixerToBrowser fallback behaviour.
//
// Headless-safe: resolution/cache/decode-completion run against synthetic
// paks and a stub AudioContext, so they execute in Node. Only the real-pak
// spot check at the bottom is gated on Q2_PAK.
import { describe, expect, it, vi } from 'vitest';
import { Mixer } from '@q2/sound';
import {
  MAX_CACHED_SOUNDS,
  cacheSoundBuffer,
  decodeAndCacheSound,
  resolveChannelSound,
  syncMixerToBrowser,
} from './dom.js';
import type { BrowserSound } from './dom.js';
import { findPakSoundEntry, ingestPak } from './pak.js';
import type { WebPak } from './pak.js';
import { makePakWithEntries } from './test-helpers.js';

// --- stub WebAudio (records which node factory each channel used) ---

class StubNode {
  readonly gain: { value: number } = { value: 0 };
  readonly pan: { value: number } = { value: 0 };
  readonly frequency: { value: number } = { value: 0 };
  buffer: AudioBuffer | null = null;
  loop = false;
  readonly connected: unknown[] = [];
  started = false;
  stopped = false;
  connect(dest: unknown): void {
    this.connected.push(dest);
  }
  disconnect(): void {
    /* noop */
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

interface StubRec {
  nodes: StubNode[];
  kinds: string[];
  decodeCalls: number;
  decodeFail: boolean;
}

function fakeBuffer(): AudioBuffer {
  return { stub: true } as unknown as AudioBuffer;
}

function makeStubSound(pak: WebPak | null, shot: AudioBuffer | null): { sound: BrowserSound; rec: StubRec } {
  const rec: StubRec = { nodes: [], kinds: [], decodeCalls: 0, decodeFail: false };
  const mk = (kind: string): StubNode => {
    const n = new StubNode();
    rec.nodes.push(n);
    rec.kinds.push(kind);
    return n;
  };
  const ctx = {
    createGain: (): GainNode => mk('gain') as unknown as GainNode,
    createStereoPanner: (): StereoPannerNode => mk('pan') as unknown as StereoPannerNode,
    createBufferSource: (): AudioBufferSourceNode => mk('buffer') as unknown as AudioBufferSourceNode,
    createOscillator: (): OscillatorNode => mk('osc') as unknown as OscillatorNode,
    decodeAudioData: (wav: ArrayBuffer): Promise<AudioBuffer> => {
      rec.decodeCalls++;
      if (rec.decodeFail) return Promise.reject(new Error('stub decode failed'));
      return Promise.resolve({ stubBytes: wav.byteLength } as unknown as AudioBuffer);
    },
  } as unknown as AudioContext;
  const sound: BrowserSound = {
    ctx,
    master: new StubNode() as unknown as GainNode,
    pak,
    shot,
    sounds: new Map(),
    pending: new Set(),
    channels: new Map(),
    dispose: (): void => undefined,
  };
  return { sound, rec };
}

function startChannel(mixer: Mixer, name: string): number {
  mixer.setListener([0, 0, 0], [0, 1, 0]);
  return mixer.startSound({
    origin: [0, 0, 0],
    fixedOrigin: false,
    entnum: 1,
    attenuation: 1,
    masterVol: 1,
    loop: false,
    name,
  });
}

function nodeOf(rec: StubRec, kind: string, occurrence = 0): StubNode {
  let seen = 0;
  for (let i = 0; i < rec.kinds.length; i++) {
    if (rec.kinds[i] === kind) {
      if (seen === occurrence) return rec.nodes[i]!;
      seen++;
    }
  }
  throw new Error(`no ${kind} node #${occurrence}`);
}

function pakOf(...names: string[]): WebPak {
  return ingestPak(makePakWithEntries(names));
}

describe('findPakSoundEntry (name → pak entry)', () => {
  it('resolves channel names under sound/', () => {
    const pak = pakOf('sound/weapons/blastf1a.wav', 'sound/doors/dr1_strt.wav');
    expect(findPakSoundEntry(pak, 'weapons/blastf1a.wav')?.name).toBe('sound/weapons/blastf1a.wav');
    expect(findPakSoundEntry(pak, 'doors/dr1_strt.wav')?.name).toBe('sound/doors/dr1_strt.wav');
  });

  it('accepts names that already carry the sound/ prefix, any case', () => {
    const pak = pakOf('sound/weapons/shotgf1b.wav');
    expect(findPakSoundEntry(pak, 'sound/weapons/shotgf1b.wav')?.name).toBe('sound/weapons/shotgf1b.wav');
    expect(findPakSoundEntry(pak, 'WEAPONS/ShotGF1B.WAV')?.name).toBe('sound/weapons/shotgf1b.wav');
    expect(findPakSoundEntry(pak, '  weapons/shotgf1b.wav  ')?.name).toBe('sound/weapons/shotgf1b.wav');
  });

  it('returns null for missing names, never throws', () => {
    const pak = pakOf('sound/weapons/blastf1a.wav');
    expect(findPakSoundEntry(pak, 'doors/door.wav')).toBeNull();
    expect(findPakSoundEntry(pak, 'items/pickup.wav')).toBeNull();
    expect(findPakSoundEntry(pak, '')).toBeNull();
    expect(findPakSoundEntry(pak, 'sound/')).toBeNull();
  });
});

describe('resolveChannelSound', () => {
  it('is null without a pak or for unknown names', () => {
    const pak = pakOf('sound/weapons/blastf1a.wav');
    expect(resolveChannelSound('weapons/blastf1a.wav', null)).toBeNull();
    expect(resolveChannelSound('doors/door.wav', pak)).toBeNull();
    expect(resolveChannelSound('weapons/blastf1a.wav', pak)).toBe('sound/weapons/blastf1a.wav');
  });
});

describe('cacheSoundBuffer (bounded per-name cache)', () => {
  it('caps at MAX_CACHED_SOUNDS, evicting oldest first', () => {
    const cache = new Map<string, AudioBuffer>();
    for (let i = 0; i < MAX_CACHED_SOUNDS + 5; i++) {
      cacheSoundBuffer(cache, `sound/x${i}.wav`, fakeBuffer());
    }
    expect(cache.size).toBe(MAX_CACHED_SOUNDS);
    expect(cache.has('sound/x0.wav')).toBe(false);
    expect(cache.has('sound/x4.wav')).toBe(false);
    expect(cache.has(`sound/x${MAX_CACHED_SOUNDS + 4}.wav`)).toBe(true);
  });

  it('re-setting a name refreshes recency', () => {
    const cache = new Map<string, AudioBuffer>();
    for (let i = 0; i < MAX_CACHED_SOUNDS; i++) {
      cacheSoundBuffer(cache, `sound/x${i}.wav`, fakeBuffer());
    }
    const hot = fakeBuffer();
    cacheSoundBuffer(cache, 'sound/x0.wav', hot);
    cacheSoundBuffer(cache, 'sound/fresh.wav', fakeBuffer());
    expect(cache.size).toBe(MAX_CACHED_SOUNDS);
    expect(cache.get('sound/x0.wav')).toBe(hot);
    expect(cache.has('sound/x1.wav')).toBe(false);
  });
});

describe('decodeAndCacheSound', () => {
  it('caches the decoded buffer and clears pending', async () => {
    const { sound, rec } = makeStubSound(null, null);
    sound.pending.add('sound/weapons/blastf1a.wav');
    const buf = await decodeAndCacheSound(sound, 'sound/weapons/blastf1a.wav', new ArrayBuffer(16));
    expect(buf).not.toBeNull();
    expect(sound.sounds.get('sound/weapons/blastf1a.wav')).toBe(buf);
    expect(sound.pending.has('sound/weapons/blastf1a.wav')).toBe(false);
    expect(rec.decodeCalls).toBe(1);
  });

  it('returns null and clears pending when decode fails', async () => {
    const { sound, rec } = makeStubSound(null, null);
    rec.decodeFail = true;
    sound.pending.add('sound/weapons/blastf1a.wav');
    await expect(
      decodeAndCacheSound(sound, 'sound/weapons/blastf1a.wav', new ArrayBuffer(16)),
    ).resolves.toBeNull();
    expect(sound.sounds.has('sound/weapons/blastf1a.wav')).toBe(false);
    expect(sound.pending.has('sound/weapons/blastf1a.wav')).toBe(false);
  });
});

describe('syncMixerToBrowser with stub AudioContext', () => {
  it('cache hit plays the channel’s own wav with mixer gains/pans', () => {
    const { sound, rec } = makeStubSound(pakOf('sound/weapons/blastf1a.wav'), fakeBuffer());
    const cached = fakeBuffer();
    sound.sounds.set('sound/weapons/blastf1a.wav', cached);
    const mixer = new Mixer();
    startChannel(mixer, 'weapons/blastf1a.wav');
    const mixed = syncMixerToBrowser(sound, mixer);
    expect(mixed).toHaveLength(1);
    // Buffer path (not the synth osc), wired to the channel's own wav.
    expect(rec.kinds).toContain('buffer');
    expect(rec.kinds).not.toContain('osc');
    expect(nodeOf(rec, 'buffer').buffer).toBe(cached);
    // M7.2 positional behaviour intact: local player is full volume.
    // RELEASE-1 quiet cap: normalized full volume -> 0.05 output gain.
    expect(nodeOf(rec, 'gain').gain.value).toBeCloseTo(0.05, 6);
    expect(nodeOf(rec, 'pan').pan.value).toBeCloseTo(0, 6);
    expect(sound.pending.size).toBe(0);
  });

  it('cache miss falls back meanwhile, decodes once, later channels hit', async () => {
    const shot = fakeBuffer();
    const { sound, rec } = makeStubSound(pakOf('sound/weapons/blastf1a.wav'), shot);
    const mixer = new Mixer();
    startChannel(mixer, 'weapons/blastf1a.wav');
    syncMixerToBrowser(sound, mixer);
    // Fallback while decoding: weapon-ish name → preloaded shot buffer.
    expect(nodeOf(rec, 'buffer', 0).buffer).toBe(shot);
    expect(sound.pending.has('sound/weapons/blastf1a.wav')).toBe(true);
    await vi.waitFor(() => expect(sound.sounds.has('sound/weapons/blastf1a.wav')).toBe(true));
    expect(rec.decodeCalls).toBe(1);
    // A later channel with the same name uses the cache, no re-decode.
    startChannel(mixer, 'weapons/blastf1a.wav');
    syncMixerToBrowser(sound, mixer);
    expect(rec.decodeCalls).toBe(1);
    expect(nodeOf(rec, 'buffer', 1).buffer).toBe(sound.sounds.get('sound/weapons/blastf1a.wav'));
    expect(nodeOf(rec, 'buffer', 1).buffer).not.toBe(shot);
  });

  it('two live channels with one name share a single in-flight decode', async () => {
    const { sound, rec } = makeStubSound(pakOf('sound/weapons/machgf1b.wav'), fakeBuffer());
    const mixer = new Mixer();
    startChannel(mixer, 'weapons/machgf1b.wav');
    startChannel(mixer, 'weapons/machgf1b.wav');
    syncMixerToBrowser(sound, mixer);
    await vi.waitFor(() => expect(sound.sounds.has('sound/weapons/machgf1b.wav')).toBe(true));
    expect(rec.decodeCalls).toBe(1);
  });

  it('unknown names keep the synth fallback and never decode', () => {
    const { sound, rec } = makeStubSound(pakOf('sound/weapons/blastf1a.wav'), fakeBuffer());
    const mixer = new Mixer();
    startChannel(mixer, 'doors/door.wav');
    syncMixerToBrowser(sound, mixer);
    expect(rec.kinds).toContain('osc');
    expect(rec.kinds).not.toContain('buffer');
    // doors → 90 Hz family pitch (soundFreqFor).
    expect(nodeOf(rec, 'osc').frequency.value).toBe(90);
    expect(sound.pending.size).toBe(0);
    expect(sound.sounds.size).toBe(0);
  });

  it('drives positional gains/pans from mix() and cleans up vanished channels', () => {
    const { sound, rec } = makeStubSound(null, null);
    const mixer = new Mixer();
    mixer.setListener([0, 0, 0], [0, 1, 0]);
    const id = mixer.startSound({
      origin: [500, 0, 0],
      fixedOrigin: true,
      entnum: 0,
      attenuation: 1,
      masterVol: 1,
      loop: false,
      name: 'doors/door.wav',
    });
    const mixed = syncMixerToBrowser(sound, mixer);
    expect(mixed).toHaveLength(1);
    const level = (mixed[0]!.left + mixed[0]!.right) / 2;
    expect(level).toBeGreaterThan(0);
    expect(level).toBeLessThan(1);
    expect(nodeOf(rec, 'gain').gain.value).toBeCloseTo(level, 6);
    // Vanished channels are stopped, disconnected, and forgotten.
    mixer.stopSound(id);
    syncMixerToBrowser(sound, mixer);
    expect(sound.channels.size).toBe(0);
    expect(nodeOf(rec, 'osc').stopped).toBe(true);
  });

  it('loop channels use looping buffer sources; one-shots stay one-shot', () => {
    const { sound, rec } = makeStubSound(pakOf('sound/world/amb1.wav'), fakeBuffer());
    const cached = fakeBuffer();
    sound.sounds.set('sound/world/amb1.wav', cached);
    const mixer = new Mixer();
    mixer.setListener([0, 0, 0], [0, 1, 0]);
    // A world-fixed loop speaker (driver syncLoopChannels shape).
    const loopId = mixer.startSound({
      origin: [100, 0, 0],
      fixedOrigin: true,
      entnum: 0,
      attenuation: 1,
      masterVol: 1,
      loop: true,
      name: 'world/amb1.wav',
    });
    // A one-shot on the same cached wav for the one-shot control.
    mixer.startSound({
      origin: [100, 0, 0],
      fixedOrigin: true,
      entnum: 0,
      attenuation: 1,
      masterVol: 1,
      loop: false,
      name: 'world/amb1.wav',
    });
    syncMixerToBrowser(sound, mixer);
    expect(sound.channels.size).toBe(2);
    const srcOf = (id: number): StubNode => sound.channels.get(id)!.src as unknown as StubNode;
    // The loop channel's source loops; the one-shot's does not.
    expect(srcOf(loopId).loop).toBe(true);
    for (const [id] of sound.channels) {
      if (id !== loopId) expect(srcOf(id).loop).toBe(false);
    }
    // Live loops update gains in place (listener moved) — no node restart.
    const gainOf = (id: number): number => (sound.channels.get(id)!.gain as unknown as StubNode).gain.value;
    const gainsBefore = gainOf(loopId);
    const nodesBefore = rec.nodes.length;
    mixer.setListener([900, 0, 0], [0, 1, 0]);
    syncMixerToBrowser(sound, mixer);
    expect(sound.channels.size).toBe(2);
    expect(rec.nodes.length).toBe(nodesBefore);
    expect(gainOf(loopId)).not.toBe(gainsBefore);
  });
});

const WEB_Q2_PAK = process.env.Q2_PAK;

describe.runIf(!!WEB_Q2_PAK)('per-name resolution against real pak0.pak', () => {
  it('resolves exact weapon wavs; generic driver names stay on fallback', async () => {
    const { readFileSync } = await import('fs');
    const raw = readFileSync(WEB_Q2_PAK as string);
    const buf = new ArrayBuffer(raw.length);
    new Uint8Array(buf).set(raw);
    const pak = ingestPak(buf);
    expect(findPakSoundEntry(pak, 'weapons/blastf1a.wav')?.name).toBe('sound/weapons/blastf1a.wav');
    expect(findPakSoundEntry(pak, 'weapons/shotgf1b.wav')?.name).toBe('sound/weapons/shotgf1b.wav');
    expect(findPakSoundEntry(pak, 'weapons/machgf1b.wav')?.name).toBe('sound/weapons/machgf1b.wav');
    expect(findPakSoundEntry(pak, 'weapons/noammo.wav')?.name).toBe('sound/weapons/noammo.wav');
    // Generic driver-side names have no such lump: honest shot/synth fallback.
    for (const name of [
      'doors/door.wav',
      'buttons/button.wav',
      'monster/melee.wav',
      'gunner/gunfire.wav',
      'soldier/shot.wav',
      'player/pain.wav',
      'player/death.wav',
      'items/pickup.wav',
    ]) {
      expect(findPakSoundEntry(pak, name)).toBeNull();
    }
  }, 120000);
});
