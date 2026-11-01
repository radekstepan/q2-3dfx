// apps/web/src/map-viewer/camera.ts — first-person free-fly camera for the map viewer.
//
// Standalone: no gameplay deps, no Host/Server imports. The owner (main.ts)
// drives update(dt, input) from its own rAF loop and renders the pose through
// renderer.ts. Angles are Quake [pitch, yaw, roll] degrees (pitch positive =
// down, matching AngleVectors in @q2/math); movement is fly/no-clip by
// default — there is intentionally no trace/collision API here.

/** Structural key/value entity dict (same shape as @q2/game EntDict, but this
 *  module must not import the game layer — entities are injected as params). */
export type EntDict = Record<string, string>;

/** Fixed 3-tuple: [x, y, z] for origins, [pitch, yaw, roll] for angles. */
export type CameraAxis = [number, number, number];

export interface CameraPose {
  origin: CameraAxis;
  angles: CameraAxis;
}

/** Map bounds for the deterministic spawn fallback (Quake units). */
export interface MapBounds {
  mins: ArrayLike<number>;
  maxs: ArrayLike<number>;
}

export interface FreeCameraOptions {
  /** Cruise speed, units/sec. Default 220 (Q2 run speed). */
  moveSpeed?: number;
  /** Shift multiplier. Default 3. */
  fastMultiplier?: number;
  /** Mouse-look gain, degrees per pixel. Default 0.2. */
  lookSensitivity?: number;
  /** Called on pointer-lock changes so the owner can show/hide the
   *  click-to-capture + Escape hint. Never required for headless use. */
  onLockChange?: (locked: boolean) => void;
}

export interface MoveInput {
  forward?: boolean;
  back?: boolean;
  left?: boolean;
  right?: boolean;
  /** World +Z (Space / E). */
  up?: boolean;
  /** World -Z (C / Q). */
  down?: boolean;
  /** Speed modifier (Shift). */
  fast?: boolean;
}

/** Minimal structural canvas: real HTMLCanvasElement in the browser, a stub in tests. */
export interface CameraCanvas {
  addEventListener(type: string, fn: (e: any) => void): void;
  removeEventListener(type: string, fn: (e: any) => void): void;
  requestPointerLock?: () => void;
}

/** Minimal structural event bus (document for lock/mouse, window for keys). */
export interface CameraEventBus {
  addEventListener(type: string, fn: (e: any) => void): void;
  removeEventListener(type: string, fn: (e: any) => void): void;
  /** Only read on the document bus: lock holder, if the host tracks one. */
  pointerLockElement?: unknown;
}

export interface SpawnSpot {
  origin: CameraAxis;
  /** Q2 `angle` key (yaw), degrees. */
  yaw: number;
}

/** Game-tuned hard fallback when no spawn entity AND no bounds exist. */
export const DEFAULT_SPAWN_ORIGIN: CameraAxis = [128, -320, 32];

/** Height lift applied to the bounds-center fallback so the eye starts
 *  slightly above the mid-plane instead of exactly inside it. */
export const BOUNDS_SPAWN_LIFT = 16;

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * id SelectSpawnPoint (SP) rule, entity-data only: the first
 * info_player_start WITHOUT a targetname. Targeted starts are level-travel
 * destinations (e.g. base1's "base2" exit-room start) and must not be spawn.
 * Returns null when no usable start exists.
 */
export function findSpawn(entities: EntDict[]): SpawnSpot | null {
  for (const d of entities) {
    if (d['classname'] !== 'info_player_start') continue;
    if (d['targetname'] !== undefined && d['targetname'] !== '') continue;
    const yaw = num(d['angle'], 0);
    const parts = (d['origin'] ?? '').trim().split(/\s+/).filter((s) => s.length > 0);
    const origin: CameraAxis = [
      parts.length > 0 ? num(parts[0], DEFAULT_SPAWN_ORIGIN[0]) : DEFAULT_SPAWN_ORIGIN[0],
      parts.length > 1 ? num(parts[1], DEFAULT_SPAWN_ORIGIN[1]) : DEFAULT_SPAWN_ORIGIN[1],
      parts.length > 2 ? num(parts[2], DEFAULT_SPAWN_ORIGIN[2]) : DEFAULT_SPAWN_ORIGIN[2],
    ];
    return { origin, yaw };
  }
  return null;
}

/** Deterministic fallback: bounds center + slight Z lift. */
export function boundsFallback(bounds: MapBounds): CameraAxis {
  return [
    ((bounds.mins[0] ?? 0) + (bounds.maxs[0] ?? 0)) / 2,
    ((bounds.mins[1] ?? 0) + (bounds.maxs[1] ?? 0)) / 2,
    ((bounds.mins[2] ?? 0) + (bounds.maxs[2] ?? 0)) / 2 + BOUNDS_SPAWN_LIFT,
  ];
}

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

function wrapYaw(yaw: number): number {
  let y = yaw % 360;
  if (y < 0) y += 360;
  // Avoid 360/-0 string noise; keep exact 0/360 out of the pose.
  if (y === 360) y = 0;
  return y;
}

function clampPitch(pitch: number): number {
  if (pitch > 89) return 89;
  if (pitch < -89) return -89;
  return pitch;
}

export interface FreeCamera {
  /** Live pose (mutated by update/addLook/reset/fromCopyable). */
  readonly pose: CameraPose;
  /** Advance position from held input. dt is seconds (frame-rate independent). */
  update(dt: number, input: MoveInput): void;
  /** Mouse-look deltas in pixels (positive dx = right, positive dy = down). */
  addLook(dxPx: number, dyPx: number): void;
  /** Live key state collected by attach(); usable as update() input. */
  readKeys(): MoveInput;
  /**
   * Wire click-to-capture pointer lock, mouse look, WASD+Space/C/Q/E keys and
   * blur/focus-lost handling. doc/win default to the globals when present;
   * pass explicit fakes in headless tests. Returns a detach function.
   */
  attach(canvas: CameraCanvas, doc?: CameraEventBus | null, win?: CameraEventBus | null): () => void;
  /**
   * Move to the first untargeted info_player_start. Falls back to the bounds
   * center + lift when bounds are given, else to DEFAULT_SPAWN_ORIGIN.
   * Returns true when a spawn entity was used.
   */
  resetToSpawn(entities: EntDict[], fallbackBounds?: MapBounds | null): boolean;
  /** Move to the bounds center + lift, facing yaw 0. */
  resetToBounds(mins: ArrayLike<number>, maxs: ArrayLike<number>): void;
  /** Copyable form: "origin x y z; angles p y r". */
  toCopyable(): string;
  /** Parse toCopyable() output; returns false (pose untouched) on garbage. */
  fromCopyable(s: string): boolean;
  /** True while pointer lock is held (after attach). */
  isLocked(): boolean;
}

export function createFreeCamera(opts: FreeCameraOptions = {}): FreeCamera {
  const moveSpeed = opts.moveSpeed ?? 220;
  const fastMultiplier = opts.fastMultiplier ?? 3;
  const sensitivity = opts.lookSensitivity ?? 0.2;
  const onLockChange = opts.onLockChange;

  const pose: CameraPose = { origin: [0, 0, 0], angles: [0, 0, 0] };
  const keys: Record<string, boolean> = {};
  let locked = false;

  function dirVectors(): { fx: number; fy: number; fz: number; rx: number; ry: number } {
    const pitch = (pose.angles[0]! * Math.PI) / 180;
    const yaw = (pose.angles[1]! * Math.PI) / 180;
    const cp = Math.cos(pitch);
    // Matches AngleVectors (@q2/math): forward = [cp*cy, cp*sy, -sp],
    // right (roll 0) = [sy, -cy, 0]. Forward follows pitch (fly), right and
    // the vertical keys stay world-aligned.
    return {
      fx: cp * Math.cos(yaw),
      fy: cp * Math.sin(yaw),
      fz: -Math.sin(pitch),
      rx: Math.sin(yaw),
      ry: -Math.cos(yaw),
    };
  }

  function update(dt: number, input: MoveInput): void {
    if (!(dt > 0)) return;
    const f = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const s = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const v = (input.up ? 1 : 0) - (input.down ? 1 : 0);
    if (f === 0 && s === 0 && v === 0) return;
    const dist = moveSpeed * (input.fast ? fastMultiplier : 1) * dt;
    const d = dirVectors();
    pose.origin[0] += (d.fx * f + d.rx * s) * dist;
    pose.origin[1] += (d.fy * f + d.ry * s) * dist;
    pose.origin[2] += (d.fz * f + v) * dist;
  }

  function addLook(dxPx: number, dyPx: number): void {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    pose.angles[1] = wrapYaw(pose.angles[1]! - dxPx * sensitivity);
    pose.angles[0] = clampPitch(pose.angles[0]! + dyPx * sensitivity);
  }

  function readKeys(): MoveInput {
    return {
      forward: !!keys['KeyW'] || !!keys['ArrowUp'],
      back: !!keys['KeyS'] || !!keys['ArrowDown'],
      left: !!keys['KeyA'] || !!keys['ArrowLeft'],
      right: !!keys['KeyD'] || !!keys['ArrowRight'],
      up: !!keys['Space'] || !!keys['KeyE'],
      down: !!keys['KeyC'] || !!keys['KeyQ'],
      fast: !!keys['ShiftLeft'] || !!keys['ShiftRight'],
    };
  }

  function clearKeys(): void {
    for (const k of Object.keys(keys)) delete keys[k];
  }

  function setLocked(next: boolean): void {
    if (next === locked) return;
    locked = next;
    // Focus/escape loss must never leave a stuck key: Escape exits pointer
    // lock without a keyup sequence the page can rely on.
    if (!locked) clearKeys();
    try {
      onLockChange?.(locked);
    } catch {
      /* hint callback must never break input */
    }
  }

  function attach(
    canvas: CameraCanvas,
    doc?: CameraEventBus | null,
    win?: CameraEventBus | null,
  ): () => void {
    const g = globalThis as {
      document?: CameraEventBus;
      window?: CameraEventBus;
      addEventListener?: (t: string, fn: (e: any) => void) => void;
      removeEventListener?: (t: string, fn: (e: any) => void) => void;
    };
    const d = doc ?? g.document ?? null;
    const w = win ?? g.window ?? null;
    const removers: Array<() => void> = [];
    const on = (
      bus: CameraEventBus | null,
      type: string,
      fn: (e: any) => void,
    ): void => {
      if (!bus) return;
      try {
        bus.addEventListener(type, fn);
      } catch {
        return;
      }
      removers.push(() => {
        try {
          bus.removeEventListener(type, fn);
        } catch {
          /* detach is best-effort */
        }
      });
    };

    const onClick = (): void => {
      try {
        canvas.requestPointerLock?.();
      } catch {
        /* pointer lock unavailable (e.g. headless): mouse look stays off */
      }
    };
    on(canvas, 'click', onClick as (e: any) => void);

    const onLockChangeEvt = (): void => {
      // Hosts that track pointerLockElement (browsers + test fakes) drive
      // state here; hosts without one never lock, which is the safe default.
      if (!d || !('pointerLockElement' in d)) return;
      setLocked((d as { pointerLockElement?: unknown }).pointerLockElement === canvas);
    };
    on(d, 'pointerlockchange', onLockChangeEvt);

    const onMouseMove = (e: any): void => {
      if (!locked) return;
      const m = e as unknown as { movementX?: unknown; movementY?: unknown };
      const dx = typeof m.movementX === 'number' ? m.movementX : 0;
      const dy = typeof m.movementY === 'number' ? m.movementY : 0;
      addLook(dx, dy);
    };
    on(d, 'mousemove', onMouseMove);

    const onKey = (down: boolean) => (e: any): void => {
      const k = e as unknown as { code?: unknown; preventDefault?: () => void };
      if (typeof k.code !== 'string') return;
      keys[k.code] = down;
      // Space scrolls the page when the canvas is not locked; swallow it
      // only while flying so devtools-style hosts keep working otherwise.
      if (down && locked && k.code === 'Space') {
        try {
          k.preventDefault?.();
        } catch {
          /* ignore */
        }
      }
      if (!down) delete keys[k.code];
    };
    const onKeyDown = onKey(true);
    const onKeyUp = onKey(false);
    on(w, 'keydown', onKeyDown);
    on(w, 'keyup', onKeyUp);

    // Stop all motion on focus loss (alt-tab during flight is the classic
    // stuck-key case). pointerlockchange already clears keys on Escape.
    const onBlur = (): void => {
      clearKeys();
    };
    on(w, 'blur', onBlur);

    return () => {
      for (const r of removers.splice(0)) r();
      clearKeys();
      setLocked(false);
    };
  }

  function resetToSpawn(entities: EntDict[], fallbackBounds?: MapBounds | null): boolean {
    const spot = findSpawn(entities);
    if (spot) {
      pose.origin[0] = spot.origin[0];
      pose.origin[1] = spot.origin[1];
      pose.origin[2] = spot.origin[2];
      pose.angles[0] = 0;
      pose.angles[1] = wrapYaw(spot.yaw);
      pose.angles[2] = 0;
      return true;
    }
    if (fallbackBounds) {
      const o = boundsFallback(fallbackBounds);
      pose.origin[0] = o[0];
      pose.origin[1] = o[1];
      pose.origin[2] = o[2];
    } else {
      pose.origin[0] = DEFAULT_SPAWN_ORIGIN[0];
      pose.origin[1] = DEFAULT_SPAWN_ORIGIN[1];
      pose.origin[2] = DEFAULT_SPAWN_ORIGIN[2];
    }
    pose.angles[0] = 0;
    pose.angles[1] = 0;
    pose.angles[2] = 0;
    return false;
  }

  function resetToBounds(mins: ArrayLike<number>, maxs: ArrayLike<number>): void {
    const o = boundsFallback({ mins, maxs });
    pose.origin[0] = o[0];
    pose.origin[1] = o[1];
    pose.origin[2] = o[2];
    pose.angles[0] = 0;
    pose.angles[1] = 0;
    pose.angles[2] = 0;
  }

  function toCopyable(): string {
    return (
      `origin ${fmt(pose.origin[0]!)} ${fmt(pose.origin[1]!)} ${fmt(pose.origin[2]!)}; ` +
      `angles ${fmt(pose.angles[0]!)} ${fmt(pose.angles[1]!)} ${fmt(pose.angles[2]!)}`
    );
  }

  function fromCopyable(s: string): boolean {
    const numRe = '-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?';
    const triple = `(${numRe})\\s+(${numRe})\\s+(${numRe})`;
    const re = new RegExp(`origin\\s+${triple}\\s*;\\s*angles\\s+${triple}`);
    const m = re.exec(s);
    if (!m) return false;
    const v = m.slice(1, 7).map(Number);
    if (v.some((n) => !Number.isFinite(n))) return false;
    pose.origin[0] = v[0]!;
    pose.origin[1] = v[1]!;
    pose.origin[2] = v[2]!;
    pose.angles[0] = clampPitch(v[3]!);
    pose.angles[1] = wrapYaw(v[4]!);
    pose.angles[2] = v[5]!;
    return true;
  }

  return {
    pose,
    update,
    addLook,
    readKeys,
    attach,
    resetToSpawn,
    resetToBounds,
    toCopyable,
    fromCopyable,
    isLocked: () => locked,
  };
}
