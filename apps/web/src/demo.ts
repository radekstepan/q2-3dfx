// q2ts-web demo download: fetch the shareware `q2-314-demo-x86.exe`
// (self-extract ZIP) in-browser, verify hashes, extract
// `Install/Data/baseq2/pak0.pak`, hand the bytes to the pak ingest.
//
// Headless-safe: no DOM here. Inflates with `DecompressionStream('deflate-raw')`
// (browsers + Node 22); fetch/verify injectable for tests. Nothing is
// committed or hosted: the exe stays the user's download, the extracted pak
// lives only in memory + the user's own IndexedDB cache.
import { PAK_CACHE_MAX_BYTES } from './pak-cache.js';

/** Canonical shareware demo (id's 3.14 demo, mirrored by Yamagi). */
export const DEMO_EXE_URLS: readonly string[] = [
  // Same-origin first: an operator that mirrors the *unmodified* exe next to
  // the page gets a CORS-free fetch. The public mirrors below are fallbacks
  // (they may refuse cross-origin reads — the landing shows that plainly).
  '/demo/q2-314-demo-x86.exe',
  'https://deponie.yamagi.org/quake2/idstuff/q2-314-demo-x86.exe',
  'http://tastyspleen.net/quake/downloads/q2-314-demo-x86.exe',
];

/** `q2-314-demo-x86.exe` identity (37 MiB). */
export const DEMO_EXE_SIZE = 39015499;
export const DEMO_EXE_SHA256 = '7ace5a43983f10d6bdc9d9b6e17a1032ba6223118d389bd170df89b945a04a1e';
export const DEMO_EXE_MD5 = '4d1cd4618e80a38db59304132ea0856c';

/** Extracted `Install/Data/baseq2/pak0.pak` identity (47 MiB). */
export const DEMO_PAK_SIZE = 49951322;
export const DEMO_PAK_SHA256 = 'cae257182f34d3913f3d663e1d7cf865d668feda6af393d4ecf3e9e408b48d09';

/** Inner pak path inside the self-extract archive (compared lowercased). */
export const DEMO_PAK_SUFFIX = 'baseq2/pak0.pak';

/** Refuse absurd downloads before they eat the tab. */
export const DEMO_EXE_MAX_BYTES = 96 * 1024 * 1024;

export interface DemoProgress {
  /** 0..1 when the length is known, -1 otherwise. */
  fraction: number;
  loaded: number;
  total: number;
}

export interface FetchDemoOpts {
  urls?: readonly string[];
  /** Skip exe-hash check when '' (tests); otherwise strict. */
  exeSha256?: string;
  /** Skip pak-hash check when '' (tests); otherwise strict. */
  pakSha256?: string;
  fetchImpl?: typeof fetch;
  onStatus?: (text: string) => void;
  onProgress?: (p: DemoProgress) => void;
}

export interface DemoPakResult {
  /** Raw `pak0.pak` bytes, ready for `ingestPak`. */
  pakBytes: ArrayBuffer;
  /** URL the exe actually came from. */
  exeUrl: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** SHA-256 hex of a buffer via WebCrypto. Throws without `crypto.subtle`. */
export async function sha256Hex(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const subtle = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error('sha256 unavailable (no crypto.subtle)');
  const digest = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return bytesToHex(new Uint8Array(digest));
}

/** Strict hash check (case-insensitive); '' expected skips (tests only). */
export async function verifySha256(
  buf: ArrayBuffer | Uint8Array,
  expectedHex: string,
  what: string,
): Promise<void> {
  if (!expectedHex) return;
  const got = await sha256Hex(buf);
  if (got.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new Error(`${what} sha256 mismatch: got ${got}, want ${expectedHex}`);
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
}

function readU16(view: DataView, off: number): number {
  return view.getUint16(off, true);
}

function readU32(view: DataView, off: number): number {
  return view.getUint32(off, true);
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Locate the end-of-central-directory record (searches the last 64 KiB + 22). */
export function findEocd(bytes: Uint8Array): number {
  const tail = Math.max(0, bytes.length - (65536 + 22));
  for (let off = bytes.length - 22; off >= tail; off--) {
    if (
      bytes[off] === 0x50 &&
      bytes[off + 1] === 0x4b &&
      bytes[off + 2] === 0x05 &&
      bytes[off + 3] === 0x06
    ) {
      return off;
    }
  }
  throw new Error('zip: end-of-central-directory not found (not a zip/self-extract exe?)');
}

/** Parse the central directory into entries. */
export function parseZipCentralDirectory(buf: ArrayBuffer): ZipEntry[] {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 22) throw new Error('zip: too small');
  const view = new DataView(buf);
  const eocd = findEocd(bytes);
  const count = readU16(view, eocd + 10);
  const cdSize = readU32(view, eocd + 12);
  const cdOffset = readU32(view, eocd + 16);
  if (cdOffset + cdSize > bytes.length) throw new Error('zip: central directory out of range');
  const entries: ZipEntry[] = [];
  let off = cdOffset;
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (off + 46 > bytes.length) throw new Error('zip: central entry truncated');
    if (readU32(view, off) !== CENTRAL_SIG) throw new Error('zip: bad central signature');
    const method = readU16(view, off + 10);
    const compSize = readU32(view, off + 20);
    const uncompSize = readU32(view, off + 24);
    const nameLen = readU16(view, off + 28);
    const extraLen = readU16(view, off + 30);
    const commentLen = readU16(view, off + 32);
    const localOffset = readU32(view, off + 42);
    const nameBytes = bytes.subarray(off + 46, off + 46 + nameLen);
    if (off + 46 + nameLen > bytes.length) throw new Error('zip: entry name truncated');
    entries.push({
      name: decoder.decode(nameBytes),
      method,
      compSize,
      uncompSize,
      localOffset,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate raw deflate bytes (method 8). Method 0 (stored) never reaches here. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as unknown as { DecompressionStream?: new (format: string) => unknown })
    .DecompressionStream;
  if (!DS) throw new Error('zip: deflated entry needs DecompressionStream');
  const ds = new DS('deflate-raw') as TransformStream<Uint8Array, Uint8Array>;
  const src = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const out = await new Response(src).arrayBuffer();
  return new Uint8Array(out);
}

/** Extract one central-directory entry's bytes (stored or deflated). */
export async function extractZipEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const off = entry.localOffset;
  if (off + 30 > bytes.length) throw new Error(`zip: local header out of range: ${entry.name}`);
  if (readU32(view, off) !== LOCAL_SIG) throw new Error(`zip: bad local header: ${entry.name}`);
  const nameLen = readU16(view, off + 26);
  const extraLen = readU16(view, off + 28);
  const dataOff = off + 30 + nameLen + extraLen;
  // Sizes come from the central directory (local sizes may be zero behind a
  // data descriptor — id's installer archives don't need it, but be safe).
  if (dataOff + entry.compSize > bytes.length) {
    throw new Error(`zip: entry data out of range: ${entry.name}`);
  }
  const data = bytes.slice(dataOff, dataOff + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`zip: unsupported method ${entry.method}: ${entry.name}`);
}

/**
 * Pull `pak0.pak` out of a `q2-314-demo-x86.exe` buffer. Pure except inflate.
 * Throws when the pak is missing or fails the `PACK` magic check.
 */
export async function extractDemoPak(exeBuf: ArrayBuffer): Promise<ArrayBuffer> {
  const entries = parseZipCentralDirectory(exeBuf);
  const lower = entries.map((e) => ({ e, n: e.name.toLowerCase().replace(/\\/g, '/') }));
  const hit =
    lower.find((x) => x.n.endsWith(DEMO_PAK_SUFFIX)) ??
    lower.find((x) => x.n.endsWith('pak0.pak'));
  if (!hit) throw new Error('demo exe has no pak0.pak (wrong file?)');
  if (hit.e.uncompSize > PAK_CACHE_MAX_BYTES || hit.e.compSize > PAK_CACHE_MAX_BYTES) {
    throw new Error('demo pak implausibly large, refusing');
  }
  const raw = await extractZipEntry(exeBuf, hit.e);
  if (raw.length < 12 || String.fromCharCode(raw[0]!, raw[1]!, raw[2]!, raw[3]!) !== 'PACK') {
    throw new Error('demo pak0.pak failed PACK magic check');
  }
  return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
}

async function fetchToBytes(
  fetchImpl: typeof fetch,
  url: string,
  onProgress?: (p: DemoProgress) => void,
): Promise<ArrayBuffer> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`demo fetch HTTP ${res.status} (${url})`);
  if (!res.body) {
    const plain = await res.arrayBuffer();
    onProgress?.({ fraction: 1, loaded: plain.byteLength, total: plain.byteLength });
    return plain;
  }
  const total = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  const known = Number.isFinite(total) && total > 0 ? total : 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    loaded += next.value.length;
    if (loaded > DEMO_EXE_MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* best-effort */
      }
      throw new Error('demo exe exceeds size cap, refusing');
    }
    onProgress?.({ fraction: known > 0 ? loaded / known : -1, loaded, total: known });
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer as ArrayBuffer;
}

/**
 * Download the shareware demo (first URL that works), verify + extract the
 * inner `pak0.pak`. Reports human-readable status via `onStatus` and byte
 * progress via `onProgress`. Throws the last error when all URLs fail.
 */
export async function fetchDemoPak(opts: FetchDemoOpts = {}): Promise<DemoPakResult> {
  const urls = opts.urls ?? DEMO_EXE_URLS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const exeSha = opts.exeSha256 ?? DEMO_EXE_SHA256;
  const pakSha = opts.pakSha256 ?? DEMO_PAK_SHA256;
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      opts.onStatus?.(`downloading shareware demo… (${url})`);
      const exe = await fetchToBytes(fetchImpl, url, opts.onProgress);
      opts.onStatus?.(`verifying demo… (${(exe.byteLength / 1048576).toFixed(1)} MiB)`);
      await verifySha256(exe, exeSha, 'demo exe');
      opts.onStatus?.('extracting pak0.pak…');
      const pakBytes = await extractDemoPak(exe);
      await verifySha256(pakBytes, pakSha, 'demo pak0.pak');
      opts.onStatus?.(`demo ready (${(pakBytes.byteLength / 1048576).toFixed(1)} MiB pak)`);
      return { pakBytes, exeUrl: url };
    } catch (e) {
      lastErr = e;
      opts.onStatus?.(`demo source failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('demo download failed (all sources)');
}
