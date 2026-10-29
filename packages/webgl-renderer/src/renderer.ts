// @q2/webgl-renderer renderer — GPU-PROOF-2 resource ownership boundary.
//
// Owns: the injected GL context handle, the DEFAULT framebuffer target
// (viewport + clear color state), and per-generation upload bookkeeping.
// Real scene buffers/textures/programs/targets land in PROOF-3 —
// `uploadedGeneration`/`uploadCount` already track the persistent-upload
// contract (upload once per staticGeneration) so PROOF-3 wires real GL
// uploads into setScene without changing the interface.
//
// Normal rendering never reads pixels back (no readPixels anywhere in
// src/); capture for tests is a backend-specific hook, never this class.
//
// Error convention: wrong-state use (renderFrame before init / after
// dispose) records lastError AND throws Com_Error — never silent, per the
// engine convention in @q2/config. Context loss is NOT thrown: renderFrame
// records lastError and submits nothing until handleContextRestored.

import { Com_Error } from '@q2/config';
import type {
  GpuFrameInput,
  GpuRenderer,
  GpuRendererStatus,
  GpuSceneInput,
} from '@q2/renderer-api';

/** Observability for the persistent-upload contract (test hook). */
export interface WebGLUploadStats {
  uploads: number;
}

const CLEAR_R = 0;
const CLEAR_G = 0;
const CLEAR_B = 0;
const CLEAR_A = 1;

export class WebGLRenderer implements GpuRenderer<WebGL2RenderingContext> {
  private gl: WebGL2RenderingContext | null = null;
  private width = 0;
  private height = 0;
  private ready = false;
  private lost = false;
  private submitted = 0;
  private error: string | null = null;
  private scene: GpuSceneInput | null = null;
  private uploadedGeneration: number | null = null;
  private uploadCount = 0;

  init(gl: WebGL2RenderingContext, width: number, height: number): void {
    this.gl = gl;
    this.width = width;
    this.height = height;
    gl.viewport(0, 0, width, height);
    gl.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A);
    this.ready = true;
    this.lost = false;
    this.error = null;
    // Fresh context => fresh targets: drop previous upload bookkeeping.
    this.scene = null;
    this.uploadedGeneration = null;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return; // no-op
    this.width = width;
    this.height = height;
    if (this.gl !== null) this.gl.viewport(0, 0, width, height);
  }

  setScene(scene: GpuSceneInput): void {
    this.scene = scene;
    // Persistent upload: re-upload if and only if the static generation
    // changed (PROOF-2 counts the upload; PROOF-3 performs the GL work).
    if (this.uploadedGeneration !== scene.staticGeneration) {
      this.uploadedGeneration = scene.staticGeneration;
      this.uploadCount++;
    }
  }

  renderFrame(_input: GpuFrameInput): void {
    if (!this.ready || this.gl === null) {
      this.fail('WebGLRenderer.renderFrame: not initialized (init first)');
    }
    if (this.lost) {
      this.error = 'WebGLRenderer.renderFrame: context lost (no submit)';
      return;
    }
    // PROOF-2 scope: clear-only submit proving context/target ownership.
    // Scene drawing from this.scene lands in PROOF-3.
    const gl = this.gl as WebGL2RenderingContext;
    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.submitted++;
    this.error = null;
  }

  dispose(): void {
    // Idempotent: releasing twice is safe and never throws.
    this.gl = null;
    this.ready = false;
    this.scene = null;
  }

  getStatus(): GpuRendererStatus {
    return {
      initialized: this.ready,
      width: this.width,
      height: this.height,
      contextLost: this.lost,
      framesSubmitted: this.submitted,
      lastError: this.error,
    };
  }

  handleContextLost(): void {
    this.lost = true;
  }

  handleContextRestored(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.lost = false;
    // Re-create owned targets: re-apply viewport + clear state. Upload
    // bookkeeping is kept (PROOF-3 re-uploads from the stored scene).
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, CLEAR_A);
    this.error = null;
  }

  /** Upload bookkeeping (test hook): persistent uploads so far. */
  testUploadStats(): WebGLUploadStats {
    return { uploads: this.uploadCount };
  }

  private fail(message: string): never {
    this.error = message;
    Com_Error('error', message);
  }
}
