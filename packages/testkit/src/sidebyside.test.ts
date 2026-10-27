// M4.1 side-by-side harness tests (asset-free, CI-safe: no Q2_PAK, no captures).
import { describe, expect, it } from 'vitest';
import {
  VOODOO_CAPTURE_TOLERANCE_FRACTION,
  VOODOO_CAPTURE_TOLERANCE_LSB,
  compareSideBySide,
  decodePng,
  diffStats,
  formatSideBySideReport,
  loadReferenceSlot,
  referenceSlotPaths,
  writeActualSlot,
} from './sidebyside.js';

const px = (r: number, g: number, b: number): number => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;

describe('compareSideBySide (§10.3 voodoo tolerance)', () => {
  it('identical frames pass with zero diff', () => {
    const a = new Uint32Array([px(10, 20, 30), px(40, 50, 60)]);
    const s = compareSideBySide('v', a, new Uint32Array(a));
    expect(s.reference).toBe('present');
    expect(s.diff).toBe(0);
    expect(s.fraction).toBe(0);
    expect(s.maxAbsDelta).toBe(0);
    expect(s.pass).toBe(true);
  });

  it('forgives <=1 LSB on every pixel (deterministic dither band)', () => {
    const n = 1000;
    const a = new Uint32Array(n).fill(px(100, 100, 100));
    const b = new Uint32Array(n).fill(px(101, 99, 101));
    const s = compareSideBySide('v', a, b);
    expect(s.diff).toBe(0);
    expect(s.pass).toBe(true);
  });

  it('fails past 0.5% of pixels differing by >1 LSB', () => {
    const n = 1000;
    const a = new Uint32Array(n).fill(px(100, 100, 100));
    const b = new Uint32Array(n).fill(px(100, 100, 100));
    for (let i = 0; i < 6; i++) b[i] = px(110, 100, 100); // 0.6% at Δ10
    const s = compareSideBySide('v', a, b);
    expect(s.diff).toBe(6);
    expect(s.fraction).toBeCloseTo(0.006, 9);
    expect(s.maxAbsDelta).toBe(10);
    expect(s.pass).toBe(false);
    // Exactly 0.5% still passes (boundary inclusive).
    b[5] = px(100, 100, 100);
    const edge = compareSideBySide('v', a, b);
    expect(edge.diff).toBe(5);
    expect(edge.pass).toBe(true);
  });

  it('missing reference slot is pending, not a failure', () => {
    const s = compareSideBySide('v', new Uint32Array([px(1, 2, 3)]), null);
    expect(s.reference).toBe('missing');
    expect(s.pass).toBe(false);
    expect(formatSideBySideReport(s)).toContain('pending');
  });

  it('tolerance constants match §10.3 (0.5% px, 1 LSB)', () => {
    expect(VOODOO_CAPTURE_TOLERANCE_FRACTION).toBe(0.005);
    expect(VOODOO_CAPTURE_TOLERANCE_LSB).toBe(1);
  });

  it('diffStats counts exact diffs and tracks max channel delta', () => {
    const { diff, maxAbsDelta } = diffStats(
      new Uint32Array([px(0, 0, 0), px(10, 20, 30)]),
      new Uint32Array([px(0, 0, 0), px(13, 20, 30)]),
    );
    expect(diff).toBe(1);
    expect(maxAbsDelta).toBe(3);
  });
});

describe('reference slot IO', () => {
  it('slot paths live side by side per view name', () => {
    const p = referenceSlotPaths('/tmp/opencode/q2sbs', 'devroom-north');
    expect(p.rgbaPath).toBe('/tmp/opencode/q2sbs/devroom-north.rgba');
    expect(p.jsonPath).toBe('/tmp/opencode/q2sbs/devroom-north.json');
    expect(p.pngPath).toBe('/tmp/opencode/q2sbs/devroom-north.png');
  });

  it('empty slot loads null (review pending)', async () => {
    const slot = `/tmp/opencode/q2sbs-empty-${Date.now()}`;
    await expect(loadReferenceSlot(slot, 'nope')).resolves.toBeNull();
  });

  it('writeActualSlot round-trips through loadReferenceSlot', async () => {
    const slot = `/tmp/opencode/q2sbs-${Date.now()}`;
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const paths = await writeActualSlot(slot, 'tiny', rgba, { width: 2, height: 2 });
    expect(paths).toHaveLength(2);
    const loaded = await loadReferenceSlot(slot, 'tiny');
    expect(loaded).not.toBeNull();
    expect(loaded!.width).toBe(2);
    expect(loaded!.height).toBe(2);
    expect(Array.from(new Uint8Array(loaded!.rgba.buffer))).toEqual(Array.from(rgba));
  });

  it('loadReferenceSlot prefers the .png capture over .rgba', async () => {
    const slot = `/tmp/opencode/q2sbs-png-${Date.now()}`;
    const fs = await import('fs');
    fs.mkdirSync(slot, { recursive: true });
    fs.writeFileSync(`${slot}/v.png`, new Uint8Array(TINY_PNG));
    const loaded = await loadReferenceSlot(slot, 'v');
    expect(loaded).not.toBeNull();
    expect(loaded!.width).toBe(2);
    expect(loaded!.height).toBe(2);
    // TL red, TR green, BL blue, BR white (row-major).
    expect(loaded!.rgba[0]).toBe(px(255, 0, 0));
    expect(loaded!.rgba[1]).toBe(px(0, 255, 0));
    expect(loaded!.rgba[2]).toBe(px(0, 0, 255));
    expect(loaded!.rgba[3]).toBe(px(255, 255, 255));
  });
});

// 2x2 8-bit RGB PNG, filter-0 rows: red green / blue white.
const TINY_PNG: number[] = [
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0, 253,
  212, 154, 115, 0, 0, 0, 18, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 192, 0, 194, 12, 255, 129, 0,
  0, 31, 238, 5, 251, 11, 217, 104, 139, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

describe('decodePng (reference captures)', () => {
  it('decodes 8-bit RGB with filter 0', async () => {
    const zlib = await import('zlib');
    const d = decodePng(new Uint8Array(TINY_PNG), (data) => zlib.inflateSync(data));
    expect(d.width).toBe(2);
    expect(d.height).toBe(2);
    expect(d.rgba[0]).toBe(px(255, 0, 0));
    expect(d.rgba[3]).toBe(px(255, 255, 255));
  });

  it('rejects non-PNG input with a descriptive error', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]), (d) => d)).toThrow(/bad PNG magic/);
  });
});
