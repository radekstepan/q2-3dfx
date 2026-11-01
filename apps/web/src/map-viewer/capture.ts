// apps/web/src/map-viewer/capture.ts — screenshot + reproducible-view metadata (plan §5).
//
// Standalone helpers for the map viewer: deterministic pose text (the CI
// fixture format), PNG download of the viewer canvas, and clipboard copy of
// the map + pose metadata that reproduces a view. No dependency on the viewer
// shell (loader/renderer/camera); the shell's canonical toCopyable() format
// wins at runtime when available, this text format is the documented fallback
// and the fixture/CI interchange.
//
// Browser fallback: canvas.toBlob, anchor download, and navigator.clipboard
// may all be unavailable (headless CI, permissions). Every helper degrades to
// a returned value so the caller can always display the metadata manually.

/** Camera pose in Quake coordinates: +X forward, +Y left, +Z up (BRAIN.md §4). */
export interface ViewPose {
  origin: [number, number, number];
  angles: [number, number, number]; // [pitch, yaw, roll], degrees, pitch positive = down
}

function finiteOrZero(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/**
 * Deterministic pose text, e.g. `origin (0 -64 8) angles (0 90 0)`.
 * Used for clipboard metadata, screenshot sidecars, and CI fixtures.
 */
export function formatPoseText(pose: ViewPose): string {
  const o = pose.origin.map(finiteOrZero).join(' ');
  const a = pose.angles.map(finiteOrZero).join(' ');
  return `origin (${o}) angles (${a})`;
}

function parseTriple(text: string): [number, number, number] | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  if (nums.some((v) => !Number.isFinite(v))) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

/** Parse pose text; null on any malformed input (never throws).
 *
 * Accepts both spellings: the canonical fixture format
 * `origin (x y z) angles (p y r)` and the viewer shell camera format
 * `origin x y z; angles p y r` (see map-viewer/camera.ts toCopyable).
 * The shell spelling is read-only compatibility: formatPoseText always
 * emits the canonical parenthesized form.
 */
export function parsePoseText(text: string): ViewPose | null {
  if (typeof text !== 'string') return null;
  const m = /origin\s*\(?\s*([^);]+?)\)?\s*[;]?\s*angles\s*\(?\s*([^);]+?)\)?\s*$/i.exec(text.trim());
  if (!m) return null;
  const origin = parseTriple(m[1]!);
  const angles = parseTriple(m[2]!);
  if (!origin || !angles) return null;
  return { origin, angles };
}

/** Sanitized stem for screenshot filenames; falls back to 'map'. */
export function sanitizeMapName(name: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.(bsp|map)$/i, '');
  const clean = stem
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return clean === '' ? 'map' : clean;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Deterministic screenshot filename: `q2ts-mapview-<map>-<yyyymmdd-hhmmss>.png`.
 * Pass an explicit `when` in CI for byte-stable names.
 */
export function captureFilename(mapName: string, when?: Date): string {
  const d = when ?? new Date();
  const stamp =
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `-${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
  return `q2ts-mapview-${sanitizeMapName(mapName)}-${stamp}.png`;
}

/** Clipboard/sidecar text pairing a map with the pose that reproduces the view. */
export function captureMetadataText(mapName: string, poseText: string): string {
  return `map: ${mapName}\npose: ${poseText}`;
}

/** Minimal canvas surface: real HTMLCanvasElement in the browser, a stub in tests. */
export interface CanvasLike {
  toBlob(callback: (blob: Blob | null) => void): void;
}

/** Promise wrapper around the callback-based canvas.toBlob (null canvas → null). */
export function canvasToBlob(canvas: CanvasLike | null | undefined): Promise<Blob | null> {
  if (!canvas) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob));
    } catch {
      resolve(null);
    }
  });
}

/** Clipboard sink: real navigator.clipboard in the browser, a spy/null in tests. */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

function ambientClipboard(): ClipboardLike | null {
  try {
    const nav = (globalThis as unknown as { navigator?: { clipboard?: ClipboardLike } }).navigator;
    return nav?.clipboard ?? null;
  } catch {
    return null;
  }
}

function ambientDownload(blob: Blob, filename: string): boolean {
  try {
    const doc = (globalThis as unknown as { document?: Document }).document;
    if (!doc) return false;
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', filename);
    doc.body?.appendChild(a);
    a.click();
    a.remove();
    // Defer revocation so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

export interface CaptureMeta {
  mapName: string;
  poseText: string;
}

export interface CaptureDeps {
  /** Override the browser anchor download (tests inject a spy). */
  download?: ((blob: Blob, filename: string) => void) | null;
  /** Clipboard sink; null disables clipboard. Defaults to navigator.clipboard. */
  clipboard?: ClipboardLike | null;
}

export interface CaptureResult {
  blob: Blob | null;
  filename: string;
  metadata: string;
  copied: boolean;
  downloaded: boolean;
}

/**
 * Capture the viewer canvas as a PNG download and copy the reproducing
 * metadata to the clipboard. Never throws: every unavailable browser API is
 * reported as a false flag and the metadata is always returned so the caller
 * can show it for manual copy (documented browser fallback).
 */
export async function captureViewerCanvas(
  canvas: CanvasLike | null | undefined,
  meta: CaptureMeta,
  deps?: CaptureDeps,
  when?: Date,
): Promise<CaptureResult> {
  const filename = captureFilename(meta.mapName, when);
  const metadata = captureMetadataText(meta.mapName, meta.poseText);
  const blob = await canvasToBlob(canvas);

  let downloaded = false;
  if (blob) {
    if (deps?.download !== undefined) {
      if (deps.download) {
        try {
          deps.download(blob, filename);
          downloaded = true;
        } catch {
          downloaded = false;
        }
      }
    } else {
      downloaded = ambientDownload(blob, filename);
    }
  }

  let copied = false;
  const sink = deps?.clipboard !== undefined ? deps.clipboard : ambientClipboard();
  if (sink) {
    try {
      await sink.writeText(metadata);
      copied = true;
    } catch {
      copied = false;
    }
  }

  return { blob, filename, metadata, copied, downloaded };
}
