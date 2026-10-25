// @q2/client/prediction — client-side prediction + interpolation (M6.1).
//
// The server ticks at 10Hz (BRAIN.md §5). The client renders uncapped:
// remote entities are lerped between the last two snapshots, and the local
// player is extrapolated forward from the newest snapshot so input feels
// immediate. All math is pure (headless-testable); time is seconds.

export type Origin3 = [number, number, number];

export interface EntityState {
  id: number;
  origin: Origin3;
  velocity: Origin3;
  angles?: Origin3;
}

/** One 10Hz server sample. */
export interface Snapshot {
  serverTime: number;
  entities: EntityState[];
}

/** Constant-velocity extrapolation: origin + velocity * dt. */
export function extrapolateOrigin(origin: Origin3, velocity: Origin3, dt: number): Origin3 {
  return [origin[0] + velocity[0] * dt, origin[1] + velocity[1] * dt, origin[2] + velocity[2] * dt];
}

/** Lerp helper shared by prediction smoothing and interpolation. */
export function lerpOrigin(a: Origin3, b: Origin3, f: number): Origin3 {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Clamp helper. */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Interpolation fraction for `renderTime` between two snapshots.
 * Degenerate (equal timestamps) yields 0. Result is clamped 0..1 so
 * render times outside the window hold the nearest sample (no jitter,
 * no extrapolation of remote entities).
 */
export function interpFraction(prevTime: number, nextTime: number, renderTime: number): number {
  if (!(nextTime > prevTime)) return 0;
  return clamp01((renderTime - prevTime) / (nextTime - prevTime));
}

/** Render time for a snapshot stream: newest server time minus delay. */
export function renderTimeFor(newestServerTime: number, delay = 0.1): number {
  return newestServerTime - delay;
}

export interface InterpolatedEntity {
  id: number;
  origin: Origin3;
}

/**
 * `CL_Interpolate`: lerp every entity present in both snapshots.
 * Entities missing from one side are held at the available sample.
 */
export function CL_Interpolate(prev: Snapshot, next: Snapshot, renderTime: number): InterpolatedEntity[] {
  const f = interpFraction(prev.serverTime, next.serverTime, renderTime);
  const bById = new Map<number, EntityState>();
  for (const e of next.entities) bById.set(e.id, e);
  const out: InterpolatedEntity[] = [];
  const seen = new Set<number>();
  for (const a of prev.entities) {
    const b = bById.get(a.id);
    seen.add(a.id);
    out.push({ id: a.id, origin: b ? lerpOrigin(a.origin, b.origin, f) : [...a.origin] as Origin3 });
  }
  for (const b of next.entities) {
    if (!seen.has(b.id)) out.push({ id: b.id, origin: [...b.origin] as Origin3 });
  }
  out.sort((x, y) => x.id - y.id);
  return out;
}

/**
 * `CL_Predict`: extrapolate the local player forward from the newest
 * snapshot by `dt` seconds (constant velocity; pmove accel is applied by
 * @q2/game when available). Returns the predicted origin.
 */
export function CL_Predict(newest: Snapshot, localId: number, dt: number): Origin3 | null {
  const ent = newest.entities.find((e) => e.id === localId);
  if (!ent) return null;
  return extrapolateOrigin(ent.origin, ent.velocity, dt);
}

/** Stateful helper used by Host: keeps the last two snapshots. */
export class Predictor {
  prev: Snapshot | null = null;
  next: Snapshot | null = null;
  interpDelay = 0.1;

  pushSnapshot(snap: Snapshot): void {
    if (this.next && snap.serverTime < this.next.serverTime) return; // out of order
    this.prev = this.next;
    this.next = snap;
  }

  /** Entities to render at `now` (server-time domain). */
  renderEntities(now: number, localId: number): InterpolatedEntity[] {
    if (!this.next) return [];
    if (!this.prev) {
      return this.next.entities.map((e) => ({ id: e.id, origin: [...e.origin] as Origin3 }));
    }
    const renderTime = now - this.interpDelay;
    const ents = CL_Interpolate(this.prev, this.next, renderTime);
    // Override the local player with the prediction (no interp lag on self).
    if (this.next) {
      const dt = Math.max(0, now - this.next.serverTime);
      const predicted = CL_Predict(this.next, localId, dt);
      if (predicted) {
        const slot = ents.find((e) => e.id === localId);
        if (slot) slot.origin = predicted;
        else ents.push({ id: localId, origin: predicted });
      }
    }
    return ents;
  }
}
