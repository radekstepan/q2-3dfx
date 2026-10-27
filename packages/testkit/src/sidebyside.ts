// @q2/testkit — M4.1 side-by-side harness: our voodoo resolve output vs a
// reference Voodoo3 capture slot.
//
// Slot layout (per view `<name>`, all Node-only IO isolated here so the
// browser bundle stays DOM-free):
//   <slotDir>/<name>.rgba  raw 8-bit RGBA bytes, width*height*4 (our render)
//   <slotDir>/<name>.json  `{ width, height }` sidecar (as writeGoldenFiles)
//   <slotDir>/<name>.png   reference capture (real Voodoo3 / Glide wrapper)
// The harness decodes the reference PNG (8-bit RGB/RGBA, non-interlaced —
// what every screenshot tool writes), compares it against our display buffer
// with the §10.3 voodoo tolerance (<=0.5% of pixels differing by <=1 LSB),
// and reports stats. A missing reference slot is NOT a failure: it reports
// `reference: 'missing'` so the human review stays visibly pending (the
// M4.1 done-when checkbox must not be ticked until a real capture lands).

export const VOODOO_CAPTURE_TOLERANCE_FRACTION = 0.005;
export const VOODOO_CAPTURE_TOLERANCE_LSB = 1;

export type ReferencePresence = 'present' | 'missing';

export interface SideBySideStats {
  name: string;
  pixels: number;
  /** Pixels differing by more than VOODOO_CAPTURE_TOLERANCE_LSB per channel. */
  diff: number;
  /** diff / pixels (0 when the reference slot is missing). */
  fraction: number;
  /** Largest single-channel |actual - reference| over the frame. */
  maxAbsDelta: number;
  /** diff/pixels <= 0.005 with the reference present. */
  pass: boolean;
  reference: ReferencePresence;
}

/** Exact per-pixel diff + largest channel delta (lsb forgiveness applied by callers). */
export function diffStats(actual: Uint32Array, reference: Uint32Array): { diff: number; maxAbsDelta: number } {
  if (actual.length !== reference.length) {
    return { diff: Math.max(actual.length, reference.length), maxAbsDelta: 255 };
  }
  let diff = 0;
  let maxAbsDelta = 0;
  for (let i = 0; i < actual.length; i++) {
    const x = actual[i]!;
    const y = reference[i]!;
    if (x === y) continue;
    diff++;
    const dr = Math.abs((x & 255) - (y & 255));
    const dg = Math.abs(((x >> 8) & 255) - ((y >> 8) & 255));
    const db = Math.abs(((x >> 16) & 255) - ((y >> 16) & 255));
    const m = Math.max(dr, dg, db);
    if (m > maxAbsDelta) maxAbsDelta = m;
  }
  return { diff, maxAbsDelta };
}

/**
 * Compare our display buffer against a reference capture with the §10.3
 * voodoo tolerance. `reference === null` means no capture was provided yet:
 * reported as missing (pass false), never thrown.
 */
export function compareSideBySide(
  name: string,
  actual: Uint32Array,
  reference: Uint32Array | null,
): SideBySideStats {
  if (reference === null) {
    return { name, pixels: actual.length, diff: 0, fraction: 0, maxAbsDelta: 0, pass: false, reference: 'missing' };
  }
  const lsb = VOODOO_CAPTURE_TOLERANCE_LSB;
  let diff = 0;
  let maxAbsDelta = 0;
  const n = Math.max(actual.length, reference.length);
  for (let i = 0; i < n; i++) {
    const x = actual[i] ?? 0;
    const y = reference[i] ?? 0;
    if (x === y) continue;
    const dr = Math.abs((x & 255) - (y & 255));
    const dg = Math.abs(((x >> 8) & 255) - ((y >> 8) & 255));
    const db = Math.abs(((x >> 16) & 255) - ((y >> 16) & 255));
    const m = Math.max(dr, dg, db);
    if (m > maxAbsDelta) maxAbsDelta = m;
    if (dr <= lsb && dg <= lsb && db <= lsb) continue;
    diff++;
  }
  const pixels = actual.length;
  const fraction = pixels === 0 ? 0 : diff / pixels;
  return {
    name,
    pixels,
    diff,
    fraction,
    maxAbsDelta,
    pass: fraction <= VOODOO_CAPTURE_TOLERANCE_FRACTION,
    reference: 'present',
  };
}

/** One-line human report, e.g. `devroom-north: 1536/307200 px (0.500%) maxΔ3 PASS`. */
export function formatSideBySideReport(s: SideBySideStats): string {
  if (s.reference === 'missing') return `${s.name}: reference capture missing — human review pending`;
  const pct = (s.fraction * 100).toFixed(3);
  return `${s.name}: ${s.diff}/${s.pixels} px (${pct}%) maxΔ${s.maxAbsDelta} ${s.pass ? 'PASS' : 'FAIL'}`;
}

export function referenceSlotPaths(slotDir: string, name: string): { rgbaPath: string; jsonPath: string; pngPath: string } {
  return {
    rgbaPath: `${slotDir}/${name}.rgba`,
    jsonPath: `${slotDir}/${name}.json`,
    pngPath: `${slotDir}/${name}.png`,
  };
}

/**
 * Load a reference capture: `<name>.png` (real Voodoo3 screenshot) when
 * present, else `<name>.rgba` + `<name>.json` (harness-written). Returns
 * null when the slot is empty (review pending). Node only.
 */
export async function loadReferenceSlot(
  slotDir: string,
  name: string,
): Promise<{ rgba: Uint32Array; width: number; height: number } | null> {
  const fs = await import('fs');
  const { rgbaPath, jsonPath, pngPath } = referenceSlotPaths(slotDir, name);
  try {
    const png = fs.readFileSync(pngPath);
    const zlib = await import('zlib');
    const decoded = decodePng(png, (data) => zlib.inflateSync(data));
    return { rgba: decoded.rgba, width: decoded.width, height: decoded.height };
  } catch {
    /* no PNG slot — fall through to raw RGBA */
  }
  try {
    const raw = fs.readFileSync(rgbaPath);
    const meta = JSON.parse(new TextDecoder().decode(fs.readFileSync(jsonPath))) as { width: number; height: number };
    const rgba = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    return { rgba, width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

/** Write our render into the slot (`<name>.rgba` + `<name>.json`). Node only. */
export async function writeActualSlot(
  slotDir: string,
  name: string,
  rgba: Uint8Array,
  meta: { width: number; height: number },
): Promise<string[]> {
  const fs = await import('fs');
  const { rgbaPath, jsonPath } = referenceSlotPaths(slotDir, name);
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(rgbaPath, rgba);
  fs.writeFileSync(jsonPath, JSON.stringify({ name, ...meta }));
  return [rgbaPath, jsonPath];
}

// --- Minimal PNG decoder (reference captures) --------------------------------
// 8-bit RGB (color type 2) or RGBA (6), non-interlaced, filters 0-4. Anything
// else throws a descriptive error (re-save the screenshot as 8-bit RGB PNG).

const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

export interface DecodedPng {
  width: number;
  height: number;
  /** Packed 0xFFBBGGRR (alpha forced opaque), row-major. */
  rgba: Uint32Array;
}

function readU32(bytes: Uint8Array, off: number): number {
  return ((bytes[off]! * 16777216 + (bytes[off + 1]! << 16) + (bytes[off + 2]! << 8) + bytes[off + 3]!) >>> 0);
}

/** Pure PNG decode; `inflate` is zlib.inflateSync in production, injected for tests. */
export function decodePng(
  bytes: Uint8Array,
  inflate: (data: Uint8Array) => Uint8Array,
): DecodedPng {
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) throw new Error('[testkit] decodePng: bad PNG magic (not a PNG file)');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 1;
  const idat: number[] = [];
  for (;;) {
    if (off + 8 > bytes.length) throw new Error('[testkit] decodePng: truncated chunk header');
    const len = readU32(bytes, off);
    const type =
      String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    const dataOff = off + 8;
    if (dataOff + len + 4 > bytes.length) throw new Error('[testkit] decodePng: truncated chunk data');
    if (type === 'IHDR') {
      if (len !== 13) throw new Error('[testkit] decodePng: bad IHDR length');
      width = readU32(bytes, dataOff);
      height = readU32(bytes, dataOff + 4);
      bitDepth = bytes[dataOff + 8]!;
      colorType = bytes[dataOff + 9]!;
      interlace = bytes[dataOff + 12]!;
    } else if (type === 'IDAT') {
      for (let i = 0; i < len; i++) idat.push(bytes[dataOff + i]!);
    } else if (type === 'IEND') {
      break;
    }
    off = dataOff + len + 4;
  }
  if (width === 0 || height === 0) throw new Error('[testkit] decodePng: missing IHDR');
  if (bitDepth !== 8) throw new Error(`[testkit] decodePng: only 8-bit supported, got ${bitDepth}-bit (re-save as 8-bit RGB PNG)`);
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`[testkit] decodePng: only RGB/RGBA supported, got color type ${colorType}`);
  }
  if (interlace !== 0) throw new Error('[testkit] decodePng: interlaced PNG not supported (re-save non-interlaced)');
  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const raw = inflate(new Uint8Array(idat));
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`[testkit] decodePng: bad IDAT size ${raw.length}, want ${height * (stride + 1)}`);
  }
  const rgba = new Uint32Array(width * height);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    for (let i = 0; i < stride; i++) {
      const v = raw[p++]!;
      const a = i >= channels ? cur[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let recon: number;
      if (filter === 0) recon = v;
      else if (filter === 1) recon = (v + a) & 255;
      else if (filter === 2) recon = (v + b) & 255;
      else if (filter === 3) recon = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) recon = (v + paeth(a, b, c)) & 255;
      else throw new Error(`[testkit] decodePng: unknown filter ${filter} on row ${y}`);
      cur[i] = recon;
    }
    for (let x = 0; x < width; x++) {
      const o = x * channels;
      rgba[y * width + x] = (0xff000000 | (cur[o + 2]! << 16) | (cur[o + 1]! << 8) | cur[o]!) >>> 0;
    }
    prev.set(cur);
  }
  return { width, height, rgba };
}
