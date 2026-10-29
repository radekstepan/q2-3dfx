// @q2/webgl-renderer renderer tests — lifecycle with a structural WebGL2
// stub (records calls, never draws). No real GL, no DOM, no readPixels.

import { describe, expect, it } from 'vitest';
import { ComError } from '@q2/config';
import type { GpuFrameInput, GpuSceneInput, RefDef } from '@q2/renderer-api';
import { WebGLRenderer } from './renderer.js';

function stubGL(version: unknown = 'WebGL 2.0 (stub)', throwing = false): {
  calls: string[];
  gl: WebGL2RenderingContext;
} {
  const calls: string[] = [];
  const gl = {
    VERSION: 0x1f02,
    COLOR_BUFFER_BIT: 0x4000,
    viewport(x: number, y: number, w: number, h: number): void {
      calls.push(`viewport ${x} ${y} ${w} ${h}`);
    },
    clearColor(r: number, g: number, b: number, a: number): void {
      calls.push(`clearColor ${r} ${g} ${b} ${a}`);
    },
    clear(mask: number): void {
      calls.push(`clear ${mask}`);
    },
    getParameter(p: number): unknown {
      if (throwing) throw new Error('stub getParameter boom');
      calls.push(`getParameter ${p}`);
      return version;
    },
  } as unknown as WebGL2RenderingContext;
  return { calls, gl };
}

function testScene(generation: number): GpuSceneInput {
  return {
    surfaces: [],
    transforms: [new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])],
    staticGeneration: generation,
  };
}

function testView(): RefDef {
  return {
    origin: new Float32Array([128, -320, 54]),
    angles: new Float32Array([0, 90, 0]),
    fovX: 90,
    time: 0,
    lightStyles: new Float32Array(256).fill(1),
  };
}

function frameInput(scene: GpuSceneInput): GpuFrameInput {
  return { view: testView(), scene, time: 0 };
}

describe('WebGLRenderer lifecycle (stub GL)', () => {
  it('renderFrame before init records lastError AND throws Com_Error', () => {
    const r = new WebGLRenderer();
    expect(() => r.renderFrame(frameInput(testScene(1)))).toThrow(ComError);
    expect(r.getStatus().lastError).toMatch(/not initialized/);
    expect(r.getStatus().framesSubmitted).toBe(0);
  });

  it('init -> setScene -> renderFrame x2 -> same-gen -> bumped-gen -> resize -> lost -> restored -> dispose', () => {
    const { calls, gl } = stubGL();
    const r = new WebGLRenderer();
    r.init(gl, 320, 240);
    expect(r.getStatus()).toMatchObject({ initialized: true, width: 320, height: 240 });
    expect(calls).toContain('viewport 0 0 320 240');

    const gen1 = testScene(1);
    r.setScene(gen1);
    r.renderFrame(frameInput(gen1));
    r.renderFrame(frameInput(gen1));
    expect(r.getStatus().framesSubmitted).toBe(2);
    expect(r.testUploadStats()).toEqual({ uploads: 1 });

    // Same generation: no re-upload.
    r.setScene(testScene(1));
    expect(r.testUploadStats()).toEqual({ uploads: 1 });

    // Bumped generation: re-upload once.
    r.setScene(testScene(2));
    expect(r.testUploadStats()).toEqual({ uploads: 2 });

    // Resize updates dims + viewport; unchanged dims are a no-op.
    const before = calls.length;
    r.resize(640, 480);
    expect(r.getStatus()).toMatchObject({ width: 640, height: 480 });
    expect(calls.length).toBeGreaterThan(before);
    const afterResize = calls.length;
    r.resize(640, 480);
    expect(calls.length).toBe(afterResize);

    // Context lost: renderFrame records lastError, submits nothing.
    r.handleContextLost();
    expect(r.getStatus().contextLost).toBe(true);
    const submitted = r.getStatus().framesSubmitted;
    r.renderFrame(frameInput(gen1));
    expect(r.getStatus().framesSubmitted).toBe(submitted);
    expect(r.getStatus().lastError).toMatch(/context lost/);

    // Restored: re-applies viewport/clear state, submits again.
    r.handleContextRestored(gl);
    expect(r.getStatus().contextLost).toBe(false);
    r.renderFrame(frameInput(gen1));
    expect(r.getStatus().framesSubmitted).toBe(submitted + 1);

    // Dispose: renderFrame throws; dispose is idempotent.
    r.dispose();
    expect(r.getStatus().initialized).toBe(false);
    expect(() => r.renderFrame(frameInput(gen1))).toThrow(ComError);
    expect(r.getStatus().lastError).toMatch(/not initialized/);
    expect(() => r.dispose()).not.toThrow();
  });

  it('re-init after dispose starts clean', () => {
    const { gl } = stubGL();
    const r = new WebGLRenderer();
    r.init(gl, 64, 48);
    r.dispose();
    r.init(gl, 64, 48);
    expect(r.getStatus()).toMatchObject({ initialized: true, lastError: null });
  });
});
