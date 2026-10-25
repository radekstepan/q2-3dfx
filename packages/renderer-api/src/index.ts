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
