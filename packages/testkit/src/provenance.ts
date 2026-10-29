// @q2/testkit — reproducible provenance for baseline evidence (PERF-NEXT-1).
//
// Everything a ledger row needs to prove WHAT was measured, without ever
// embedding the measured asset itself:
//   - commit hash + build freshness (dist vs engine-src mtimes),
//   - pak identity: byte size, file mtime and a header hash (magic + lump
//     directory names/offsets/sizes) — never the pak bytes,
//   - machine / node versions, box load (quiet-machine check input),
//   - the pinned fidelity cvar snapshot (bench-workloads.ts).
// All fs/process access is lazy (dynamic import) so the browser bundle and
// the pure unit path stay clean; every async helper degrades to an explicit
// 'unknown'/null rather than throwing.

import { fidelityCvarSnapshot } from './bench-workloads.js';

/** Pak identity: size, header hash and lump count — never the pak itself. */
export interface PakIdentity {
  path: string | null;
  bytes: number;
  mtimeMs: number | null;
  headerHash: string;
  entries: number;
}

function fnvBytes(data: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Read a little-endian u32 from a byte array. */
function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/**
 * Identify a pak from its bytes: validates the PACK magic, counts the lump
 * directory entries and hashes the header (magic + directory table). Pure —
 * no fs. Throws an Error on non-pak bytes (caller treats as missing asset,
 * never as evidence).
 */
export function pakIdentityFromBytes(pakBytes: ArrayBuffer, path: string | null = null): Omit<PakIdentity, 'mtimeMs'> {
  const b = new Uint8Array(pakBytes);
  if (b.length < 12) throw new Error('testkit: pak too small for PACK header');
  const magic = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!);
  if (magic !== 'PACK') throw new Error('testkit: not a pak file (PACK magic missing)');
  const dirofs = u32le(b, 4);
  const dirlen = u32le(b, 8);
  if (dirlen % 64 !== 0 || dirofs + dirlen > b.length) {
    throw new Error('testkit: corrupt pak directory table');
  }
  const entries = dirlen / 64;
  // Header hash: magic + the full directory table (names/offsets/sizes).
  const dir = b.slice(dirofs, dirofs + dirlen);
  const head = b.slice(0, 12);
  const joined = new Uint8Array(head.length + dir.length);
  joined.set(head, 0);
  joined.set(dir, head.length);
  return { path, bytes: b.length, headerHash: fnvBytes(joined), entries };
}

/** File size + mtime for a pak path (null when unreadable — never throws). */
export async function pakFileStat(pakPath: string): Promise<{ bytes: number; mtimeMs: number } | null> {
  try {
    const fs = await import('fs');
    const st = fs.statSync(pakPath);
    return { bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Full pak identity: header hash from bytes when available, else fs stat only. */
export async function pakIdentity(
  pakBytes: ArrayBuffer | null,
  pakPath: string | null = null,
): Promise<PakIdentity | null> {
  if (pakBytes) {
    const id = pakIdentityFromBytes(pakBytes, pakPath);
    let mtimeMs: number | null = null;
    if (pakPath) {
      const st = await pakFileStat(pakPath);
      mtimeMs = st ? st.mtimeMs : null;
    }
    return { ...id, mtimeMs };
  }
  if (pakPath) {
    const st = await pakFileStat(pakPath);
    if (!st) return null;
    return { path: pakPath, bytes: st.bytes, mtimeMs: st.mtimeMs, headerHash: 'unread', entries: -1 };
  }
  return null;
}

/** Short git commit (dynamic child_process; 'unknown' when unavailable). */
export async function gitCommitHash(): Promise<string> {
  try {
    const cp = await import('child_process');
    return cp.execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Box load vs cpu count (quiet-machine check input; null when unavailable). */
export async function boxLoad(): Promise<{ load1: number; cpus: number; quietOk: boolean } | null> {
  try {
    const os = await import('os');
    const n = Math.max(1, os.cpus().length);
    const load1 = os.loadavg()[0] ?? 0;
    return { load1, cpus: n, quietOk: load1 <= n };
  } catch {
    return null;
  }
}

/** Machine descriptor (dynamic os import; degrades to node-only). */
export async function machineDescriptor(): Promise<Record<string, string>> {
  try {
    const os = await import('os');
    return {
      platform: os.platform(),
      arch: os.arch(),
      cpus: String(os.cpus().length),
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      node: process.version,
      date: new Date().toISOString(),
    };
  } catch {
    return { node: (() => { try { return process.version; } catch { return 'unknown'; } })() };
  }
}

/** Pure freshness comparison (unit-testable; fs stat lives in distFreshness). */
export function compareFreshness(
  distMtimeMs: number,
  srcEntries: Array<{ file: string; mtimeMs: number }>,
): { fresh: boolean; newestSrcMtimeMs: number; newestSrcFile: string; stale: string[] } {
  let newestSrcMtimeMs = 0;
  let newestSrcFile = '(none)';
  for (const e of srcEntries) {
    if (e.mtimeMs > newestSrcMtimeMs) { newestSrcMtimeMs = e.mtimeMs; newestSrcFile = e.file; }
  }
  const stale = srcEntries
    .filter((e) => !(distMtimeMs > 0 && distMtimeMs >= e.mtimeMs))
    .map((e) => `${e.file}`);
  return { fresh: stale.length === 0, newestSrcMtimeMs, newestSrcFile, stale };
}

/**
 * Dist-vs-src freshness: the bench runs from dist — a stale dist silently
 * benchmarks old code. Compares each built bundle mtime against the newest
 * .ts mtime under the matching src dir. The caller passes explicit
 * (distFile, srcDir, label) triples so this helper never hard-codes repo
 * layout. Test files (*.test.ts) are excluded from src scans — a concurrent
 * test edit must not mark the measured bundle stale.
 */
export async function distFreshness(
  pairs: Array<{ distFile: string; srcDir: string; label: string }>,
): Promise<{ fresh: boolean; distMtimeMs: number; newestSrcMtimeMs: number; newestSrcFile: string; stale: string[] }> {
  let fs: typeof import('fs');
  try {
    fs = await import('fs');
  } catch {
    return { fresh: false, distMtimeMs: 0, newestSrcMtimeMs: 0, newestSrcFile: '(unreadable)', stale: ['fs-unavailable'] };
  }
  const entries: Array<{ file: string; mtimeMs: number }> = [];
  let distMtimeMs = 0;
  const missing: string[] = [];
  const walk = (dir: string): void => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch { return; }
    for (const name of names) {
      const p = `${dir}/${name}`;
      let st: { mtimeMs: number; isDirectory(): boolean } | null = null;
      try {
        st = fs.statSync(p);
      } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(name)) continue;
      if (/\.test\.tsx?$/.test(name)) continue;
      entries.push({ file: p, mtimeMs: st.mtimeMs });
    }
  };
  for (const { distFile, srcDir, label } of pairs) {
    let distMtime = 0;
    try {
      distMtime = fs.statSync(distFile).mtimeMs;
    } catch { /* missing dist: stale */ }
    if (distMtime > distMtimeMs) distMtimeMs = distMtime;
    if (!(distMtime > 0)) missing.push(`${label} (dist missing: ${distFile})`);
    walk(srcDir);
  }
  const cmp = compareFreshness(distMtimeMs, entries);
  return {
    fresh: cmp.fresh && missing.length === 0,
    distMtimeMs,
    newestSrcMtimeMs: cmp.newestSrcMtimeMs,
    newestSrcFile: cmp.newestSrcFile,
    stale: [...missing, ...cmp.stale],
  };
}

/** Complete provenance record for one evidence run. */
export interface BenchProvenance {
  commit: string;
  node: string;
  machine: Record<string, string>;
  load: { load1: number; cpus: number; quietOk: boolean } | null;
  pak: PakIdentity | null;
  cvars: Record<string, string>;
  fresh: { fresh: boolean; newestSrcFile: string; stale: string[] } | null;
}

export interface RecordProvenanceOptions {
  pakBytes?: ArrayBuffer | null;
  pakPath?: string | null;
  /** Extra dist/src pairs for the freshness check (bench passes its own). */
  freshnessPairs?: Array<{ distFile: string; srcDir: string; label: string }>;
  /** Extra free-form fields merged alongside (browser version, notes). */
  extraCvars?: Record<string, string>;
}

/** Record full provenance (never throws — degrades fields to unknown/null). */
export async function recordProvenance(opts: RecordProvenanceOptions = {}): Promise<BenchProvenance> {
  const commit = await gitCommitHash();
  const machine = await machineDescriptor();
  const load = await boxLoad();
  let pak: PakIdentity | null = null;
  try {
    pak = await pakIdentity(opts.pakBytes ?? null, opts.pakPath ?? null);
  } catch {
    pak = null;
  }
  let fresh: BenchProvenance['fresh'] = null;
  if (opts.freshnessPairs && opts.freshnessPairs.length > 0) {
    try {
      const f = await distFreshness(opts.freshnessPairs);
      fresh = { fresh: f.fresh, newestSrcFile: f.newestSrcFile, stale: f.stale };
    } catch {
      fresh = null;
    }
  }
  return {
    commit,
    node: (() => { try { return process.version; } catch { return 'unknown'; } })(),
    machine,
    load,
    pak,
    cvars: { ...fidelityCvarSnapshot(), ...(opts.extraCvars ?? {}) },
    fresh,
  };
}

/** One-line provenance ledger (commit/build/assets/machine/fidelity). */
export function formatProvenance(p: BenchProvenance): string {
  const pak = p.pak
    ? `pak[bytes=${p.pak.bytes} entries=${p.pak.entries} hdr=${p.pak.headerHash}]`
    : 'pak[none]';
  const load = p.load
    ? `load[${p.load.load1.toFixed(1)}/${p.load.cpus}${p.load.quietOk ? '' : ' NOISY'}]`
    : 'load[n/a]';
  const fresh = p.fresh === null ? 'fresh[n/a]' : p.fresh.fresh ? 'fresh[ok]' : `fresh[STALE: ${p.fresh.stale.join('; ')}]`;
  return `commit=${p.commit} node=${p.node} ${pak} ${load} ${fresh} cvars=${JSON.stringify(p.cvars)}`;
}
