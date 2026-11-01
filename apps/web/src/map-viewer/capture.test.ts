// apps/web/src/map-viewer/capture.test.ts — screenshot metadata helpers (plan §5).
// No real canvas or clipboard: injected fakes. No proprietary assets.
import { describe, expect, it } from 'vitest';
import {
  canvasToBlob,
  captureFilename,
  captureMetadataText,
  captureViewerCanvas,
  formatPoseText,
  parsePoseText,
  sanitizeMapName,
} from './capture.js';

describe('formatPoseText / parsePoseText', () => {
  it('round-trips a deterministic pose', () => {
    const pose = { origin: [0, -64, 8] as [number, number, number], angles: [0, 90, 0] as [number, number, number] };
    expect(formatPoseText(pose)).toBe('origin (0 -64 8) angles (0 90 0)');
    expect(parsePoseText(formatPoseText(pose))).toEqual(pose);
  });
  it('rejects malformed pose text without throwing', () => {
    for (const bad of [
      '',
      'hello',
      'origin (0 0) angles (0 0 0)',
      'origin (0 0 0 0) angles (0 0 0)',
      'origin (a b c) angles (0 0 0)',
      'origin (0 0 0)',
      'origin (0 0 NaN) angles (0 0 0)',
      'origin (0 0 Infinity) angles (0 0 0)',
    ]) {
      expect(parsePoseText(bad), bad).toBeNull();
    }
    expect(() => parsePoseText('')).not.toThrow();
  });
  it('also reads the viewer shell camera spelling', () => {
    expect(parsePoseText('origin 0 -64 32; angles 0 90 0')).toEqual({
      origin: [0, -64, 32],
      angles: [0, 90, 0],
    });
    expect(parsePoseText('origin (0 -64 32) angles (0 90 0)')).toEqual({
      origin: [0, -64, 32],
      angles: [0, 90, 0],
    });
  });
  it('coerces non-finite components to zero when formatting', () => {
    expect(formatPoseText({ origin: [NaN, 1, 2], angles: [0, 0, 0] })).toBe('origin (0 1 2) angles (0 0 0)');
  });
});

describe('captureFilename', () => {
  const when = new Date(Date.UTC(2026, 10, 1, 12, 30, 45));
  it('is deterministic for a fixed timestamp and sanitizes the map name', () => {
    expect(captureFilename('maps/base1.bsp', when)).toBe('q2ts-mapview-base1-20261101-123045.png');
    expect(captureFilename('maps/fixture.bsp', when)).toBe('q2ts-mapview-fixture-20261101-123045.png');
  });
  it('falls back to "map" for empty or hostile names', () => {
    expect(captureFilename('', when)).toBe('q2ts-mapview-map-20261101-123045.png');
    expect(sanitizeMapName('..\\..\\evil..bsp')).not.toContain('.');
    expect(sanitizeMapName('My Map v2')).toBe('my-map-v2');
  });
});

describe('captureMetadataText', () => {
  it('pairs map name with the reproducing pose', () => {
    expect(captureMetadataText('maps/base1.bsp', 'origin (0 0 0) angles (0 0 0)')).toBe(
      'map: maps/base1.bsp\npose: origin (0 0 0) angles (0 0 0)',
    );
  });
});

describe('canvasToBlob', () => {
  it('resolves the blob from the canvas callback', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const canvas = { toBlob: (cb: (b: Blob | null) => void) => cb(blob) };
    await expect(canvasToBlob(canvas)).resolves.toBe(blob);
  });
  it('resolves null when the canvas throws or is absent', async () => {
    const throwing = {
      toBlob: (_cb: (b: Blob | null) => void) => {
        throw new Error('no canvas');
      },
    };
    await expect(canvasToBlob(throwing)).resolves.toBeNull();
    await expect(canvasToBlob(null)).resolves.toBeNull();
    await expect(canvasToBlob(undefined)).resolves.toBeNull();
  });
});

describe('captureViewerCanvas', () => {
  const meta = { mapName: 'maps/fixture.bsp', poseText: 'origin (0 -64 8) angles (0 90 0)' };
  const when = new Date(Date.UTC(2026, 10, 1, 12, 30, 45));
  const blobOf = (): Blob => new Blob(['png'], { type: 'image/png' });
  const canvasOf = (blob: Blob | null) => ({ toBlob: (cb: (b: Blob | null) => void) => cb(blob) });

  it('downloads the PNG and copies map + pose metadata', async () => {
    const downloads: Array<{ filename: string; size: number }> = [];
    const copied: string[] = [];
    const res = await captureViewerCanvas(canvasOf(blobOf()), meta, {
      download: (blob, filename) => void downloads.push({ filename, size: blob.size }),
      clipboard: { writeText: async (t: string) => void copied.push(t) },
    }, when);
    expect(res.blob).not.toBeNull();
    expect(res.filename).toBe('q2ts-mapview-fixture-20261101-123045.png');
    expect(res.metadata).toBe('map: maps/fixture.bsp\npose: origin (0 -64 8) angles (0 90 0)');
    expect(res.downloaded).toBe(true);
    expect(res.copied).toBe(true);
    expect(downloads).toHaveLength(1);
    expect(copied).toEqual([res.metadata]);
  });

  it('never throws when clipboard or download are unavailable (browser fallback)', async () => {
    const failingClipboard = {
      writeText: (_t: string): Promise<void> => Promise.reject(new Error('denied')),
    };
    const res = await captureViewerCanvas(canvasOf(blobOf()), meta, {
      download: null,
      clipboard: failingClipboard,
    }, when);
    expect(res.downloaded).toBe(false);
    expect(res.copied).toBe(false);
    // Metadata is still returned so the caller can show it for manual copy.
    expect(res.metadata).toContain('maps/fixture.bsp');

    const noCanvas = await captureViewerCanvas(null, meta, { download: null, clipboard: null }, when);
    expect(noCanvas.blob).toBeNull();
    expect(noCanvas.downloaded).toBe(false);
    expect(noCanvas.copied).toBe(false);
  });
});
