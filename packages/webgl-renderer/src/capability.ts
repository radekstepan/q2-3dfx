// @q2/webgl-renderer capability — explicit GPU availability report.
//
// Never throws, never touches the DOM: the caller (browser glue in
// apps/web) owns canvas/context acquisition and hands the context in.
// Only this package and browser integration may name browser graphics
// types (BRAIN.md §4); nothing here leaks DOM/GL types outward — the
// report itself is plain data in @q2/renderer-api.

import type { GpuCapability } from '@q2/renderer-api';

/**
 * Describe WebGL2 availability for one (possibly missing) context.
 * null -> unavailable + blocking reason; live context -> available +
 * the GL VERSION string; a context whose getParameter throws ->
 * unavailable + the error reason. Never throws.
 */
export function describeGpuCapability(gl: WebGL2RenderingContext | null): GpuCapability {
  if (gl === null) {
    return {
      backend: 'webgl2-experimental',
      available: false,
      reason: 'no WebGL2 context (canvas acquisition failed or unsupported device)',
    };
  }
  try {
    const version = gl.getParameter(gl.VERSION);
    return {
      backend: 'webgl2-experimental',
      available: true,
      reason: `WebGL2 ${String(version)}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      backend: 'webgl2-experimental',
      available: false,
      reason: `WebGL2 context unusable: ${detail}`,
    };
  }
}
