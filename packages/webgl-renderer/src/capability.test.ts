// @q2/webgl-renderer capability tests — structural GL stub only, no real GL.

import { describe, expect, it } from 'vitest';
import { describeGpuCapability } from './capability.js';

describe('describeGpuCapability', () => {
  it('null context -> unavailable + blocking reason', () => {
    const cap = describeGpuCapability(null);
    expect(cap.backend).toBe('webgl2-experimental');
    expect(cap.available).toBe(false);
    expect(cap.reason.length).toBeGreaterThan(0);
  });

  it('live stub -> available + GL VERSION string', () => {
    const gl = {
      VERSION: 0x1f02,
      getParameter(): unknown {
        return 'WebGL 2.0 (stub)';
      },
    } as unknown as WebGL2RenderingContext;
    const cap = describeGpuCapability(gl);
    expect(cap.available).toBe(true);
    expect(cap.reason).toContain('WebGL 2.0 (stub)');
  });

  it('throwing getParameter -> unavailable + error reason, never throws', () => {
    const gl = {
      VERSION: 0x1f02,
      getParameter(): unknown {
        throw new Error('stub context boom');
      },
    } as unknown as WebGL2RenderingContext;
    const cap = describeGpuCapability(gl);
    expect(cap.available).toBe(false);
    expect(cap.reason).toContain('stub context boom');
  });
});
