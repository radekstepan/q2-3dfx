// @q2/renderer-api — frozen Refresh/Framebuffer/RefDef contracts (BRAIN.md §6).
import type { Vec3 } from '@q2/math';

export interface Framebuffer {
  width: number; height: number;
  /** 0xAABBGGRR, what gets blitted */
  color: Uint32Array;
  /** present only for the software path */
  index?: Uint8Array;
  /** 1/z */
  depth: Float32Array;
}

export interface RefDef {
  origin: Vec3; angles: Vec3; fovX: number; time: number;
  /** 256 styles, 0..2 */
  lightStyles: Float32Array;
}

export interface Model { name: string; kind: 'bsp' | 'md2' | 'sp2'; data: unknown }
export type ModelHandle = number;
export type TextureHandle = number;

export interface Entity {
  model: ModelHandle;
  origin: Vec3; angles: Vec3;
  frame: number; skin: TextureHandle;
  /** RF_DEPTHHACK: alias backend scales stored 1/z by 3 (eye-anchored viewmodel). */
  depthHack?: boolean;
  /**
   * RF_FRAMELERP previous frame (cl_tent.c explosion smoothing): the alias
   * backend interpolates verts oldframe -> frame by backlerp. Optional,
   * defaults to frame (no lerp); out-of-range values wrap like frame.
   */
  oldframe?: number;
  /**
   * RF_FRAMELERP blend 0..1 (1 = fully oldframe, 0 = fully frame).
   * Optional, defaults to 0; clamped. Ignored unless oldframe is set.
   */
  backlerp?: number;
  /**
   * Translucency 0..1 (1 = opaque). The alias backend applies deterministic
   * screen-door skip so fading explosions read as translucent on the 8-bit
   * path. Optional, defaults to 1 (opaque); clamped.
   */
  alpha?: number;
}

export interface WorldModel {
  name: string;
  data: unknown;
}

export interface FrameStats {
  spans: number; pixels: number; overdraw: number; ms: number;
}

export interface Refresh {
  init(fb: Framebuffer): void;
  beginFrame(): void;
  renderView(view: RefDef, world: WorldModel, entities: Entity[]): FrameStats;
  /** resolve: palette expand, or dither+postfilter */
  endFrame(): void;
  setPalette(p: Uint8Array): void;
  registerModel(m: Model): ModelHandle;
  registerSkin(name: string): TextureHandle;
}

export function createFramebuffer(width: number, height: number, indexed: boolean): Framebuffer {
  const n = width * height;
  return {
    width, height,
    color: new Uint32Array(n),
    index: indexed ? new Uint8Array(n) : undefined,
    depth: new Float32Array(n),
  };
}

// --- Additive glue (M6.1/M7.1 own this file; §6 interfaces above are frozen) ---

/**
 * Headless null renderer: implements Refresh without any engine internals.
 * Fills a deterministic vertical gradient + view-dependent checker so the
 * web shell, host loop and golden harness boot even before ref_soft lands.
 * Used as the `devroom` fallback and in Node tests.
 */
export class NullRefresh implements Refresh {
  private fb: Framebuffer | null = null;
  private palette: Uint8Array | null = null;
  private models = new Map<number, Model>();
  private skins = new Map<number, string>();
  private nextHandle = 1;

  init(fb: Framebuffer): void {
    this.fb = fb;
  }

  /** Exposed for the headless golden harness (testkit). */
  getFramebuffer(): Framebuffer {
    if (!this.fb) throw new Error('NullRefresh: init() not called');
    return this.fb;
  }

  beginFrame(): void {
    const fb = this.fb;
    if (!fb) return;
    fb.color.fill(0xff101010);
    fb.depth.fill(1e30);
    if (fb.index) fb.index.fill(0);
  }

  renderView(view: RefDef, world: WorldModel, entities: Entity[]): FrameStats {
    const fb = this.fb;
    const t0 = Date.now();
    if (!fb) return { spans: 0, pixels: 0, overdraw: 1, ms: 0 };
    const { width, height } = fb;
    // Deterministic gradient keyed by view origin so camera moves change
    // the frame (golden harness can tell views apart).
    const ox = ((view.origin[0]! * 0.7) | 0) & 255;
    const oy = ((view.origin[1]! * 0.7) | 0) & 255;
    const oz = ((view.origin[2]! * 0.7) | 0) & 255;
    void world;
    for (let y = 0; y < height; y++) {
      const g = (y * 255) / Math.max(1, height - 1);
      for (let x = 0; x < width; x++) {
        const check = ((x >> 4) + (y >> 4)) & 1;
        const r = (x * 255 / Math.max(1, width - 1) + ox + (check ? 12 : 0)) & 255;
        const gg = (g + oy) & 255;
        const b = ((x + y + oz) & 255) ^ (check ? 24 : 0);
        fb.color[y * width + x] = (255 << 24) | (b << 16) | (gg << 8) | r;
        if (fb.index) fb.index[y * width + x] = (x + y + ox) & 255;
      }
    }
    // Entity markers: 5x5 squares so entity interpolation is visible.
    for (const e of entities) {
      const ex = ((e.origin[0]! | 0) % width + width) % width;
      const ey = ((e.origin[1]! | 0) % height + height) % height;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const px = ex + dx;
          const py = ey + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          fb.color[py * width + px] = 0xff00ffff;
        }
      }
    }
    const pixels = width * height;
    void t0;
    return { spans: entities.length, pixels, overdraw: 1, ms: 0 };
  }

  endFrame(): void {
    /* nothing to resolve */
  }

  setPalette(p: Uint8Array): void {
    this.palette = p;
  }

  registerModel(m: Model): ModelHandle {
    const h = this.nextHandle++;
    this.models.set(h, m);
    return h;
  }

  registerSkin(name: string): TextureHandle {
    const h = this.nextHandle++;
    this.skins.set(h, name);
    return h;
  }
}

/** Devroom world descriptor used when no pak is present (BRAIN.md §8). */
export function devroomWorld(): WorldModel {
  return { name: 'maps/devroom', data: null };
}

/** Default devroom camera. */
export function devroomView(time = 0): RefDef {
  return {
    origin: new Float32Array([0, 0, 48]) as Vec3,
    angles: new Float32Array([0, 0, 0]) as Vec3,
    fovX: 90,
    time,
    lightStyles: new Float32Array(256).fill(1),
  };
}
