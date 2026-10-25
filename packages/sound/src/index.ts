// @q2/sound — WebAudio mixer, 3D attenuation (M6.1).
//
// Q2 attenuation model (s_mix.c `S_Spatialize`): sounds inside
// SOUND_FULLVOLUME are full volume; beyond that they fall off linearly,
// scaled by the attenuation class. Stereo separation comes from the dot of
// the source direction with the listener's right vector.
//
// Pure math here is headless-testable. The WebAudio backend (`browser.ts`)
// only constructs an AudioContext in a browser.
export const SOUND_FULLVOLUME = 80;

/** id attenuation classes. */
export const ATTN_NONE = 0;
export const ATTN_NORM = 1;
export const ATTN_IDLE = 2;
export const ATTN_STATIC = 3;

export type Vec3Like = ArrayLike<number>;

/** Per-ear gains plus distance, all in 0..1 (gains) / world units. */
export interface SpatialResult {
  left: number;
  right: number;
  /** clamped 0..1 distance gain before stereo split */
  gain: number;
  /** raw distance listener -> source */
  dist: number;
}

/**
 * Q2 attenuation curve: full volume inside SOUND_FULLVOLUME, then linear
 * falloff. ATTN_NONE never attenuates. Returns 0..1.
 */
export function attenuation(dist: number, attn = ATTN_NORM): number {
  if (attn === ATTN_NONE) return 1;
  const d = dist - SOUND_FULLVOLUME;
  if (d <= 0) return 1;
  const g = 1 - (d * attn) / 1000;
  return g <= 0 ? 0 : g;
}

function dot3(a: Vec3Like, b: Vec3Like): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

/**
 * Full spatialization: distance gain via `attenuation()`, stereo split via
 * the source direction's projection on the listener right vector
 * (Q2: `lscale/rscale` around the dot; sources behind are quieter).
 */
export function spatialize(
  listenerOrigin: Vec3Like,
  listenerRight: Vec3Like,
  sourceOrigin: Vec3Like,
  attn = ATTN_NORM,
  masterVol = 1,
): SpatialResult {
  const dx = sourceOrigin[0]! - listenerOrigin[0]!;
  const dy = sourceOrigin[1]! - listenerOrigin[1]!;
  const dz = sourceOrigin[2]! - listenerOrigin[2]!;
  const dist = Math.hypot(dx, dy, dz);
  const gain = attenuation(dist, attn) * masterVol;
  let pan = 0;
  if (dist > 1e-6) {
    pan = (dx * listenerRight[0]! + dy * listenerRight[1]! + dz * listenerRight[2]!) / dist;
    pan = Math.max(-1, Math.min(1, pan));
  }
  // Constant-power-ish split matching Q2's (1-dot)/2 behaviour at extremes.
  const left = gain * 0.5 * (1 - pan);
  const right = gain * 0.5 * (1 + pan);
  return { left, right, gain, dist };
}

// --- Headless mixer -------------------------------------------------------

export interface ChannelDesc {
  id: number;
  origin: [number, number, number];
  fixedOrigin: boolean;
  entnum: number;
  attenuation: number;
  masterVol: number;
  loop: boolean;
  name: string;
}

export interface MixedChannel extends ChannelDesc {
  left: number;
  right: number;
  dist: number;
}

/**
 * Headless mixer: owns channels + listener, computes per-channel gains.
 * No AudioContext here — `browser.ts` pushes these gains into real nodes.
 */
export class Mixer {
  listenerOrigin: [number, number, number] = [0, 0, 0];
  listenerRight: [number, number, number] = [0, -1, 0];
  playerNum = 0;
  masterVol = 1;
  private nextId = 1;
  private channels = new Map<number, ChannelDesc>();

  setListener(origin: Vec3Like, right: Vec3Like): void {
    this.listenerOrigin = [origin[0]!, origin[1]!, origin[2]!];
    this.listenerRight = [right[0]!, right[1]!, right[2]!];
  }

  startSound(desc: Omit<ChannelDesc, 'id'>): number {
    const id = this.nextId++;
    this.channels.set(id, { ...desc, id });
    return id;
  }

  stopSound(id: number): void {
    this.channels.delete(id);
  }

  stopAll(): void {
    this.channels.clear();
  }

  get channelCount(): number {
    return this.channels.size;
  }

  /** Mix one tick: spatialize every channel (drops fully-silent ones). */
  mix(): MixedChannel[] {
    const out: MixedChannel[] = [];
    for (const ch of this.channels.values()) {
      // Local player's own sounds are always full volume (Q2 rule).
      if (!ch.fixedOrigin && ch.entnum === this.playerNum + 1) {
        const v = ch.masterVol * this.masterVol;
        out.push({ ...ch, left: v, right: v, dist: 0 });
        continue;
      }
      const s = spatialize(
        this.listenerOrigin,
        this.listenerRight,
        ch.origin,
        ch.attenuation,
        ch.masterVol * this.masterVol,
      );
      if (s.left <= 0.0001 && s.right <= 0.0001) continue;
      out.push({ ...ch, left: s.left, right: s.right, dist: s.dist });
    }
    return out;
  }
}
