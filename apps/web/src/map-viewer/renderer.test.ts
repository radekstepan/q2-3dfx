// map-viewer renderer headless smoke tests (no DOM, no assets).
//
// @q2/bsp's internal buildTestMap is not exported from the package, so this
// suite carries its own tiny synthetic fixture: an empty-but-valid world
// (zero faces, one empty leaf). It exercises the viewer contract — setMap,
// textured vs fallback mode, render, resize, dispose — not BSP parsing
// (covered in @q2/bsp) or pixels (covered by sw-renderer goldens).
import { describe, expect, it } from 'vitest';
import type { BspMap } from '@q2/bsp';
import {
  VIEWER_BRIGHTNESS_DEFAULT,
  applyViewerBrightness,
  createViewerRenderer,
} from './renderer.js';

/** Minimal valid BspMap: no faces/nodes, one empty leaf, no clusters. */
function buildEmptyTestMap(): BspMap {
  const leafs = new Int32Array(13);
  leafs[0] = 0; // contents: empty
  leafs[1] = -1; // cluster: none (always visible)
  return {
    planes: new Float32Array(0),
    planeTypes: new Int32Array(0),
    vertexes: new Float32Array(0),
    visibility: new Uint8Array(0),
    numClusters: 0,
    visBitofs: new Int32Array(0),
    nodes: new Int32Array(0),
    nodeMins: new Int16Array(0),
    nodeMaxs: new Int16Array(0),
    texinfoVecs: new Float32Array(0),
    texinfoFlags: new Int32Array(0),
    texinfoValue: new Int32Array(0),
    texinfoNext: new Int32Array(0),
    texinfoNames: [],
    faces: new Int32Array(0),
    lighting: new Uint8Array(0),
    leafs,
    leaffaces: new Uint16Array(0),
    leafbrushes: new Uint16Array(0),
    edges: new Uint16Array(0),
    surfedges: new Int32Array(0),
    modelsMins: new Float32Array(0),
    modelsMaxs: new Float32Array(0),
    modelsOrigin: new Float32Array(0),
    modelsExtra: new Int32Array(0),
    brushes: new Int32Array(0),
    brushsides: new Int32Array(0),
    entities: '',
    pop: new Uint8Array(0),
    areas: new Int32Array(0),
    areaportals: new Int32Array(0),
    raw: new ArrayBuffer(0),
  } as unknown as BspMap;
}

interface FakeCtx {
  calls: string[];
  createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray };
  putImageData(): void;
  fillRect(): void;
  fillStyle: string;
}

function makeCtx(): FakeCtx {
  return {
    calls: [],
    createImageData(w: number, h: number): { width: number; height: number; data: Uint8ClampedArray } {
      this.calls.push(`createImageData ${w}x${h}`);
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(): void {
      this.calls.push('putImageData');
    },
    fillRect(): void {
      this.calls.push('fillRect');
    },
    fillStyle: '#000',
  };
}

function makeCanvas(w = 128, h = 96): {
  canvas: HTMLCanvasElement;
  ctx: FakeCtx;
  listeners: Map<string, Array<(e: unknown) => void>>;
} {
  const ctx = makeCtx();
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const canvas = {
    width: w,
    height: h,
    clientWidth: w,
    clientHeight: h,
    parentNode: null,
    getContext(kind: string): unknown {
      return kind === '2d' ? ctx : null;
    },
    addEventListener(type: string, fn: (e: unknown) => void): void {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type: string, fn: (e: unknown) => void): void {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, ctx, listeners };
}

const VIEW = { origin: [0, 0, 32] as const, angles: [0, 0, 0] as const };

describe('viewer renderer (headless smoke)', () => {
  it('setMap + render does not throw and presents to canvas', () => {
    const { canvas, ctx } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      expect(r.getStatus().hasMap).toBe(false);
      r.setMap(buildEmptyTestMap());
      const st = r.getStatus();
      expect(st.hasMap).toBe(true);
      expect(st.surfaces).toBe(0);
      expect(st.mode).toBe('fallback-checker');
      const stats = r.render(
        { origin: [0, 0, 32], angles: [0, 0, 0] },
        1000,
      );
      // Empty world draws no spans (pixels counts drawn spans, not the
      // framebuffer area); the contract is "renders + presents".
      expect(stats.spans).toBe(0);
      expect(ctx.calls).toContain('putImageData');
      expect(r.getStatus().lastError).toBeNull();
    } finally {
      r.dispose();
    }
  });

  it('renders before any setMap (empty placeholder world)', () => {
    const { canvas } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      const stats = r.render({ origin: VIEW.origin, angles: VIEW.angles }, 0);
      // Devroom placeholder has real geometry: it must draw something.
      expect(stats.spans).toBeGreaterThan(0);
      expect(stats.pixels).toBeGreaterThan(0);
      expect(r.getStatus().mode).toBe('empty');
    } finally {
      r.dispose();
    }
  });

  it('texelFor selects the textured-lit path', () => {
    const { canvas } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      r.setMap(buildEmptyTestMap(), () => ({
        texels: new Uint8Array(16 * 16).fill(7),
        width: 16,
        height: 16,
      }));
      expect(r.getStatus().mode).toBe('textured-lit');
      const stats = r.render({ origin: [0, 0, 32], angles: [0, 0, 0] }, 16);
      expect(stats.spans).toBe(0);
    } finally {
      r.dispose();
    }
  });

  it('resize + repeated setMap are safe; generation bumps and old refs release', () => {
    const { canvas } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      r.setMap(buildEmptyTestMap());
      const g0 = r.getStatus().generation;
      r.resize(64, 48);
      expect(r.getStatus().width).toBe(64);
      expect(r.getStatus().height).toBe(48);
      const stats = r.render({ origin: [1, 2, 3], angles: [0, 90, 0], fovX: 75 }, 33);
      expect(stats.spans).toBe(0);
      // Degenerate resizes clamp instead of throwing.
      r.resize(0, -5);
      expect(r.getStatus().width).toBeGreaterThanOrEqual(1);
      // Repeated setMap invalidates + bumps generation; status stays sane.
      r.setMap(buildEmptyTestMap());
      r.setMap(buildEmptyTestMap(), null);
      expect(r.getStatus().generation).toBeGreaterThan(g0);
      expect(r.getStatus().hasMap).toBe(true);
      expect(r.getStatus().lastError).toBeNull();
    } finally {
      r.dispose();
    }
  });

  it('dispose is safe and idempotent; render after dispose is a no-op', () => {
    const { canvas, listeners } = makeCanvas();
    const r = createViewerRenderer(canvas);
    r.setMap(buildEmptyTestMap());
    r.dispose();
    r.dispose();
    const stats = r.render({ origin: [0, 0, 0], angles: [0, 0, 0] }, 0);
    expect(stats).toEqual({ spans: 0, pixels: 0, overdraw: 0, ms: 0 });
    r.resize(64, 64); // no-op, must not throw
    r.setMap(buildEmptyTestMap()); // no-op, must not throw
    expect(listeners.get('contextlost') ?? []).toEqual([]);
  });

  it('context loss shows an actionable overlay message', () => {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    const withParent = {
      width: 64,
      height: 48,
      clientWidth: 64,
      clientHeight: 48,
      parentNode: {
        insertBefore(): void {
          /* stub */
        },
      },
      getContext(): unknown {
        return makeCtx();
      },
      addEventListener(type: string, fn: (e: unknown) => void): void {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      removeEventListener(type: string, fn: (e: unknown) => void): void {
        listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
      },
    } as unknown as HTMLCanvasElement;
    // Stub document so the overlay can be created headlessly.
    const g = globalThis as { document?: unknown };
    const prevDoc = g.document;
    const created: Array<{ textContent: string | null }> = [];
    g.document = {
      createElement(): unknown {
        const node = {
          textContent: null as string | null,
          style: { cssText: '' },
          setAttribute(): void { /* stub */ },
          remove(): void { /* stub */ },
        };
        created.push(node);
        return node;
      },
    };
    try {
      const r = createViewerRenderer(withParent);
      try {
        for (const fn of listeners.get('contextlost') ?? []) {
          fn({ preventDefault(): void { /* stub */ } });
        }
        const st = r.getStatus();
        expect(st.lastError).toMatch(/context lost/i);
        expect(created.length).toBe(1);
        expect(created[0]!.textContent).toMatch(/reload/i);
      } finally {
        r.dispose();
      }
    } finally {
      if (prevDoc === undefined) delete g.document;
      else g.document = prevDoc;
    }
  });
});

describe('viewer brightness + palette (dark-map fix)', () => {
  it('brightness 1.0 is a byte-identical no-op; 2.0 doubles and clamps; alpha preserved', () => {
    // 0xAABBGGRR: alpha 0xFF, b=200, g=100, r=50.
    const px = 0xffc86432;
    const same = new Uint32Array([px]);
    applyViewerBrightness(same, 1);
    expect(same[0]).toBe(px);
    const lifted = new Uint32Array([px]);
    applyViewerBrightness(lifted, 2);
    // r 50->100, g 100->200, b 200->255 (clamped), alpha untouched.
    expect(lifted[0]).toBe(0xffffc864);
    expect((lifted[0]! & 0xff000000) >>> 0).toBe(0xff000000);
  });

  it('setBrightness clamps to range and defaults to the game value', () => {
    const { canvas } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      expect(r.getStatus().brightness).toBe(VIEWER_BRIGHTNESS_DEFAULT);
      expect(VIEWER_BRIGHTNESS_DEFAULT).toBe(2.0);
      r.setBrightness(99);
      expect(r.getStatus().brightness).toBeLessThanOrEqual(3.0);
      r.setBrightness(-1);
      expect(r.getStatus().brightness).toBeGreaterThanOrEqual(0.5);
      r.setBrightness(NaN);
      expect(r.getStatus().brightness).toBeGreaterThanOrEqual(0.5);
    } finally {
      r.dispose();
    }
  });

  it('setColormap installs a PAK palette; null keeps the fallback', () => {
    const { canvas } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      expect(r.getStatus().palette).toBe('procedural');
      r.setColormap(null);
      expect(r.getStatus().palette).toBe('procedural');
      r.setColormap(new Uint8Array(100)); // too short: ignored, never throws
      expect(r.getStatus().palette).toBe('procedural');
      const pal = new Uint8Array(768);
      for (let i = 0; i < 768; i++) pal[i] = i & 255;
      r.setColormap(pal, null);
      expect(r.getStatus().palette).toBe('pak');
      expect(r.getStatus().lastError).toBeNull();
    } finally {
      r.dispose();
    }
  });
});

describe('viewer enemies (static spawn MD2s)', () => {
  it('setEnemies installs fallback spawns and renders without assets', () => {
    const { canvas } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      r.setMap(buildEmptyTestMap());
      expect(r.getStatus().enemies).toBe(0);
      r.setEnemies([
        { index: 1, classname: 'monster_soldier', kind: 'soldier', origin: [0, 0, 8], yaw: 90 },
        { index: 2, classname: 'monster_infantry', kind: 'infantry', origin: [64, 0, 8], yaw: 0 },
      ]);
      expect(r.getStatus().enemies).toBe(2);
      expect(r.getStatus().enemiesVisible).toBe(true);
      // Procedural fallback meshes must not break the frame.
      const stats = r.render({ origin: [0, -64, 32], angles: [0, 90, 0] }, 16);
      expect(r.getStatus().lastError).toBeNull();
      expect(stats.spans).toBeGreaterThanOrEqual(0);
    } finally {
      r.dispose();
    }
  });

  it('hides enemies without dropping them; setMap clears the list', () => {
    const { canvas } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      r.setMap(buildEmptyTestMap());
      r.setEnemies([
        { index: 0, classname: 'monster_gunner', kind: 'gunner', origin: [0, 0, 8], yaw: 0 },
      ]);
      r.setEnemiesVisible(false);
      expect(r.getStatus().enemiesVisible).toBe(false);
      expect(r.getStatus().enemies).toBe(1);
      r.render({ origin: [0, -64, 32], angles: [0, 90, 0] }, 16);
      expect(r.getStatus().lastError).toBeNull();
      r.setEnemiesVisible(true);
      r.render({ origin: [0, -64, 32], angles: [0, 90, 0] }, 16);
      // A new world drops the previous map's spawns until reinstalled.
      r.setMap(buildEmptyTestMap());
      expect(r.getStatus().enemies).toBe(0);
    } finally {
      r.dispose();
    }
  });

  it('uses supplied MD2/skin resolvers when present, nulls fall back', () => {
    const { canvas } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      r.setMap(buildEmptyTestMap());
      // Null resolvers = asset-free fallback path (never throws).
      r.setEnemies(
        [{ index: 0, classname: 'monster_berserk', kind: null, origin: [0, 0, 8], yaw: 45 }],
        { md2For: () => null, skinFor: () => null },
      );
      expect(r.getStatus().enemies).toBe(1);
      r.render({ origin: [0, -64, 32], angles: [0, 90, 0] }, 16);
      expect(r.getStatus().lastError).toBeNull();
      // Throwing resolvers degrade to the fallback instead of breaking setEnemies.
      r.setEnemies(
        [{ index: 0, classname: 'monster_soldier', kind: 'soldier', origin: [0, 0, 8], yaw: 0 }],
        {
          md2For: () => {
            throw new Error('pak missing');
          },
          skinFor: () => {
            throw new Error('pak missing');
          },
        },
      );
      expect(r.getStatus().enemies).toBe(1);
    } finally {
      r.dispose();
    }
  });
});

describe('viewer sky install', () => {
  it('setSkyTexture installs a valid strip, clears on null/invalid; never throws', () => {
    const { canvas } = makeCanvas();
    const r = createViewerRenderer(canvas);
    try {
      expect(r.getStatus().sky).toBe('flat-fallback');
      r.setSkyTexture(null);
      expect(r.getStatus().sky).toBe('flat-fallback');
      r.setSkyTexture({ texels: new Uint8Array(10), width: 3, height: 7 });
      expect(r.getStatus().sky).toBe('flat-fallback'); // non-POT width rejected
      // 16x48 warm-fallback shape: POT width, height % 6 == 0.
      r.setSkyTexture({ texels: new Uint8Array(16 * 48).fill(40), width: 16, height: 48 });
      expect(r.getStatus().sky).toBe('textured');
      // Still renders with a textured sky installed.
      r.setMap(buildEmptyTestMap());
      const stats = r.render({ origin: [0, 0, 32], angles: [0, 0, 0] }, 16);
      expect(stats.spans).toBe(0);
      expect(r.getStatus().lastError).toBeNull();
    } finally {
      r.dispose();
    }
  });
});
