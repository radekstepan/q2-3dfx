// q2-bench durable evidence (PERF-NEXT-1, bench lane).
//
// Every bench run must leave evidence that outlives /tmp: a small committed
// manifest (`tools/bench/evidence/*.manifest.json`) plus the full raw run
// JSON (`tools/bench/evidence/raw/`, gitignored — large per-rep blobs).
// The perf ledger references the manifest path, never a disposable log.
//
// A manifest records everything needed to reproduce and trust the numbers:
// the exact command line + relevant env, git commit + tree dirtiness, build
// freshness (stale dist silently benchmarks old code), pak identity
// (path + bytes + mtime — NEVER the pak itself), machine + node, load,
// the full vd_* + sw_* fidelity profile, warmup/reps/workers, and a summary
// with a ledger hint. Raw per-rep samples live in the referenced result
// file (compare moving rows carry frameMs[]; stationary AttrRows carry
// frameReps[]).
//
// Browser baselines are SEPARATE records (kind 'browser-soak', imported via
// browser-soak.mjs): Node numbers are production-frame-no-present and must
// never be compared against browser presented-FPS. The soak schema forces
// an explicit compositor classification — headless SwiftShader / software
// compositing vs hardware-backed — so conditions are never ambiguous.
//
// Nothing here imports from apps/* (tools/* are leaves). No `any` in
// exported signatures.
import { execSync } from 'child_process';
import { mkdirSync, statSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem, freemem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getCVarString, listCVars } from '@q2/config';
import { machineJson } from '@q2/testkit';
import { distFreshness, repoRoot, type DistFreshness } from './rgbattr.js';

/** Manifest schema version (bump on incompatible change). */
export const EVIDENCE_MANIFEST_VERSION = 1;
/** Browser-soak record schema version. */
export const BROWSER_SOAK_SCHEMA_VERSION = 1;

/** Node runs vs imported browser soaks — never mix the two in a diff. */
export type EvidenceKind = 'node-compare' | 'node-rgbattr' | 'node-accept' | 'browser-soak';

/** Compositor classification for browser runs (must be explicit, never inferred). */
export type BrowserCompositor = 'swiftshader' | 'software' | 'hardware' | 'unknown';

export interface PakIdentity {
  /** Absolute path as given (the pak itself is NEVER copied into evidence). */
  path: string;
  bytes: number | null;
  mtimeMs: number | null;
  mtimeIso: string | null;
  missing: boolean;
}

export interface FidelityProfile {
  /** Raw vd_* cvar strings (authoritative fidelity profile). */
  vd: Record<string, string>;
  /** sw_workers / sw_accum raw strings. */
  sw: Record<string, string>;
}

export interface ProvenanceCommand {
  /** process.argv (node binary + script + args). */
  argv: string[];
  /** Allowlisted bench env only (Q2_PAK path, COMPARE_*, RGB_*, ...). */
  env: Record<string, string>;
  cwd: string;
}

export interface BrowserInfo {
  name: string;
  version: string;
  headless: boolean;
}

/** Minimal structural shape of a stationary config row (AttrRow-compatible). */
export interface AttrLike {
  scene: string;
  res: string;
  entities: string;
  mode: string;
  workers: number;
  frameMs: number | null;
}

/** Minimal structural shape of a moving-sweep row (MovingRow-compatible). */
export interface MovingLike {
  res: string;
  mode: string;
  workers: number;
  frameMs: number[];
}

/** Reproducibility core shared by every manifest. */
export interface EvidenceCore {
  manifestVersion: number;
  kind: EvidenceKind;
  date: string;
  command: ProvenanceCommand;
  commitShort: string;
  commitFull: string;
  treeDirty: boolean;
  distFresh: DistFreshness;
  pak: PakIdentity;
  machine: Record<string, string>;
  node: string;
  browser: BrowserInfo | null;
  compositor: BrowserCompositor | null;
  loadavg: number[];
  cpus: number;
  quietOk: boolean;
  fidelity: FidelityProfile | null;
  warmup: number | null;
  reps: number | null;
  workers: number[] | null;
}

/** The committed manifest: core provenance + pointer to raw results. */
export interface EvidenceManifest extends EvidenceCore {
  /** Absolute path of the full raw run JSON (evidence/raw/, gitignored). */
  resultFile: string;
  /** Small committed summary (medians, hashes, counts — not per-rep bulk). */
  summary: Record<string, string | number | boolean | null>;
  /** Imported browser soak (null for Node runs). */
  soak: BrowserSoakRecord | null;
  /** Suggested perf-ledger row text referencing this manifest. */
  ledgerHint: string;
}

/**
 * Browser soak record: the SEPARATE browser baseline. Presented-FPS is a
 * browser/CDP soak metric, never a Node number. Per-frame samples stay in
 * the raw file; percentiles live here.
 */
export interface BrowserSoakRecord {
  schemaVersion: number;
  commitShort: string;
  commitFull: string | null;
  date: string;
  browser: BrowserInfo;
  /** Explicit classification: swiftshader/software compositing vs hardware. */
  compositor: BrowserCompositor;
  /** e.g. the GL_RENDERER string; required so the class is auditable. */
  compositorDetail: string;
  /** True only for real-GPU presentation (false for SwiftShader/software). */
  hardwareBacked: boolean;
  page: string;
  resolution: string;
  width: number;
  height: number;
  renderer: string;
  workers: number[];
  durationS: number;
  samples: number;
  presentedFpsMedian: number | null;
  frameP50Ms: number | null;
  frameP95Ms: number | null;
  frameMaxMs: number | null;
  /** Workload intervals covered (stationary / moving / combat ...). */
  workloads: string[];
  notes: string;
  /** Optional path to the raw per-frame sample file (copied to raw/). */
  rawFile: string | null;
}

export interface SoakImportResult {
  manifestPath: string;
  resultPath: string;
  manifest: EvidenceManifest;
}

/** Env vars recorded in every manifest (paths/settings only, no secrets). */
export const PROVENANCE_ENV_ALLOWLIST: string[] = [
  'Q2_PAK',
  'COMPARE_WARMUP', 'COMPARE_REPS', 'COMPARE_WORKERS', 'COMPARE_YAWSTEP',
  'COMPARE_OUT', 'COMPARE_BASE', 'COMPARE_HEAD',
  'RGB_BENCH_WARMUP', 'RGB_BENCH_REPS', 'RGB_BENCH_WORKERS', 'RGB_BENCH_ENTS',
  'RGB_ATTR_OUT',
  'RGB_ACCEPT_WARMUP', 'RGB_ACCEPT_REPS', 'RGB_ACCEPT_WORKERS',
  'Q2_DETAIL_TIMING',
  'PLAYBENCH_RENDERER', 'PLAYBENCH_W', 'PLAYBENCH_H', 'PLAYBENCH_ITERS',
  'BROWSER_SOAK_IN',
];

const VD_KEYS = [
  'vd_gamma', 'vd_lodbias', 'vd_dither', 'vd_postfilter', 'vd_fog',
  'vd_16bit', 'vd_bilinear', 'vd_mipdither', 'vd_overbright', 'vd_palettetex',
  'vd_maxtexsize', 'vd_zbits', 'vd_dithermode', 'vd_reconmode', 'vd_rgbmaxdelta',
];
const SW_KEYS = ['sw_workers', 'sw_accum'];

function gitOut(args: string): string | null {
  try {
    const out = execSync(`git ${args}`, { encoding: 'utf8' }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Absolute durable-evidence directory (inside the repo, committed manifests). */
export function evidenceDir(): string {
  return join(repoRoot(), 'tools', 'bench', 'evidence');
}

/** Absolute raw-blob directory (gitignored large per-rep JSON). */
export function evidenceRawDir(): string {
  return join(evidenceDir(), 'raw');
}

/** Filtered env for the manifest (allowlist only — never whole environ). */
export function provenanceEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PROVENANCE_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Pak identity without touching contents (path + bytes + mtime). */
export function pakIdentity(pakPath: string): PakIdentity {
  try {
    const st = statSync(pakPath);
    return {
      path: resolve(pakPath),
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      mtimeIso: st.mtime.toISOString(),
      missing: false,
    };
  } catch {
    return { path: resolve(pakPath), bytes: null, mtimeMs: null, mtimeIso: null, missing: true };
  }
}

/** Full vd_* + sw_* fidelity profile snapshot (raw cvar strings). */
export function collectFidelityProfile(): FidelityProfile {
  const all = new Map(listCVars().map((c) => [c.name, String(c.value)]));
  const vd: Record<string, string> = {};
  for (const k of VD_KEYS) vd[k] = all.get(k) ?? getCVarString(k);
  const sw: Record<string, string> = {};
  for (const k of SW_KEYS) sw[k] = all.get(k) ?? getCVarString(k);
  return { vd, sw };
}

/** Machine descriptor: testkit base + memory + load (all strings). */
export async function collectMachine(): Promise<Record<string, string>> {
  const base = await machineJson().catch(() => ({ node: process.version }));
  const n = Math.max(1, cpus().length);
  const load = loadavg();
  return {
    ...base,
    memTotalMB: String(Math.round(totalmem() / 1048576)),
    memFreeMB: String(Math.round(freemem() / 1048576)),
    load1: (load[0] ?? 0).toFixed(2),
    load5: (load[1] ?? 0).toFixed(2),
    load15: (load[2] ?? 0).toFixed(2),
    quietOk: String((load[0] ?? 0) <= n),
  };
}

export interface ProvenanceOpts {
  pakPath: string;
  warmup?: number | null;
  reps?: number | null;
  workers?: number[] | null;
}

/**
 * Capture Node-run provenance. Call AFTER the measured loops: pinPerfCvars
 * leaves the pinned vd/sw profile armed, so the fidelity snapshot
 * reflects the profile the numbers were measured under.
 */
export async function collectNodeProvenance(
  kind: Exclude<EvidenceKind, 'browser-soak'>,
  opts: ProvenanceOpts,
): Promise<EvidenceCore> {
  const commitFull = gitOut('rev-parse HEAD') ?? 'unknown';
  const commitShort = gitOut('rev-parse --short HEAD') ?? commitFull.slice(0, 7);
  const dirtyOut = gitOut('status --porcelain');
  const load = loadavg();
  const n = Math.max(1, cpus().length);
  return {
    manifestVersion: EVIDENCE_MANIFEST_VERSION,
    kind,
    date: new Date().toISOString(),
    command: { argv: process.argv.slice(0), env: provenanceEnv(), cwd: process.cwd() },
    commitShort,
    commitFull,
    treeDirty: dirtyOut !== null && dirtyOut.length > 0,
    distFresh: distFreshness(),
    pak: pakIdentity(opts.pakPath),
    machine: await collectMachine(),
    node: process.version,
    browser: null,
    compositor: null,
    loadavg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    cpus: n,
    quietOk: (load[0] ?? 0) <= n,
    fidelity: collectFidelityProfile(),
    warmup: opts.warmup ?? null,
    reps: opts.reps ?? null,
    workers: opts.workers ?? null,
  };
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** Default raw result path (gitignored). Pass COMPARE_OUT/RGB_ATTR_OUT/ACCEPT_OUT to override. */
export function defaultResultPath(kind: EvidenceKind, commitShort: string): string {
  return join(evidenceRawDir(), `${kind}-${commitShort}-${stamp()}.json`);
}

/** Default manifest path (committed). Pass *_MANIFEST_OUT to override. */
export function defaultManifestPath(kind: EvidenceKind, commitShort: string): string {
  return join(evidenceDir(), `${kind}-${commitShort}-${stamp()}.manifest.json`);
}

/** Assemble a Node manifest from provenance + summary + raw-file pointer. */
export function buildNodeManifest(
  base: EvidenceCore,
  opts: { resultFile: string; summary: Record<string, string | number | boolean | null>; ledgerHint: string },
): EvidenceManifest {
  return {
    ...base,
    resultFile: resolve(opts.resultFile),
    summary: opts.summary,
    soak: null,
    ledgerHint: opts.ledgerHint,
  };
}

/** Write a manifest JSON (creating parent dirs), returning the absolute path. */
export function writeEvidenceManifest(manifest: EvidenceManifest, outPath?: string): string {
  const target = resolve(outPath ?? defaultManifestPath(manifest.kind, manifest.commitShort));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(manifest, null, 2));
  return target;
}

function med(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] ?? null;
}

function findAttr(
  rows: ReadonlyArray<AttrLike>,
  res: string, mode: string, ent: string, workers: number,
): AttrLike | undefined {
  return rows.find((r) => r.res === res && r.mode === mode && r.entities === ent && r.workers === workers);
}

/**
 * Small committed summary over stationary rows: acceptance-config medians
 * (640x480 software fixed serial, rgb fixed serial, rgb combat pooled-max)
 * plus row count. 320x240 rows are diagnostic-only and excluded by design.
 */
export function summarizeAttrRows(rows: ReadonlyArray<AttrLike>): Record<string, string | number | boolean | null> {
  const maxW = rows.reduce((m, r) => Math.max(m, r.workers), 0);
  const a = findAttr(rows, '640x480', 'software', 'fixed', 0);
  const b = findAttr(rows, '640x480', 'rgb', 'fixed', 0);
  const c = findAttr(rows, '640x480', 'rgb', 'combat', maxW);
  return {
    rows: rows.length,
    maxWorkers: maxW,
    swFixedSerial640: a?.frameMs ?? null,
    rgbFixedSerial640: b?.frameMs ?? null,
    rgbCombatPooled640: c?.frameMs ?? null,
  };
}

/** Summary over a full compare matrix (stationary medians + moving medians). */
export function summarizeCompare(
  stationary: ReadonlyArray<AttrLike>,
  moving: ReadonlyArray<MovingLike>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = summarizeAttrRows(stationary);
  for (const m of moving) {
    if (m.res === '640x480' && m.mode === 'rgb') {
      out[`moving640-${m.mode}-w${m.workers}`] = med(m.frameMs);
    }
  }
  return out;
}

/** Suggested ledger row for a single Node run (delta comes from compare-diff, never here). */
export function ledgerHintFor(
  kind: EvidenceKind, commitShort: string, summary: Record<string, string | number | boolean | null>,
  manifestPath: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const fmt = (v: string | number | boolean | null): string =>
    typeof v === 'number' ? `${v.toFixed(2)}ms` : 'n/a';
  return (
    `| ${date} | ${commitShort} | ${kind} | 640x480 sw-fixed-serial ${fmt(summary['swFixedSerial640'])} ` +
    `rgb-fixed-serial ${fmt(summary['rgbFixedSerial640'])} rgb-combat-pooled ${fmt(summary['rgbCombatPooled640'])} ` +
    `| evidence: ${manifestPath} |`
  );
}

/** Validate an imported browser soak record (unknown input, explicit errors). */
export function validateBrowserSoak(v: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof v !== 'object' || v === null) return { ok: false, errors: ['record must be an object'] };
  const r = v as Record<string, unknown>;
  const str = (k: string): string | null => (typeof r[k] === 'string' && (r[k] as string).length > 0 ? (r[k] as string) : null);
  const num = (k: string): number | null => (typeof r[k] === 'number' && Number.isFinite(r[k] as number) ? (r[k] as number) : null);
  if (r['schemaVersion'] !== BROWSER_SOAK_SCHEMA_VERSION) errors.push(`schemaVersion must be ${BROWSER_SOAK_SCHEMA_VERSION}`);
  if (str('commitShort') === null) errors.push('commitShort required');
  if (str('date') === null || Number.isNaN(Date.parse(str('date') as string))) errors.push('date must be ISO');
  const b = r['browser'];
  if (typeof b !== 'object' || b === null) {
    errors.push('browser {name, version, headless} required');
  } else {
    const bb = b as Record<string, unknown>;
    if (typeof bb['name'] !== 'string' || bb['name'].length === 0) errors.push('browser.name required');
    if (typeof bb['version'] !== 'string' || bb['version'].length === 0) errors.push('browser.version required (record the exact build)');
    if (typeof bb['headless'] !== 'boolean') errors.push('browser.headless must be boolean');
  }
  const comp = r['compositor'];
  if (comp !== 'swiftshader' && comp !== 'software' && comp !== 'hardware' && comp !== 'unknown') {
    errors.push('compositor must be one of swiftshader|software|hardware|unknown');
  } else if (comp === 'unknown') {
    errors.push('compositor must be explicitly classified (swiftshader|software|hardware) — unknown voids the baseline');
  }
  if (str('compositorDetail') === null) errors.push('compositorDetail required (e.g. GL_RENDERER string)');
  if (typeof r['hardwareBacked'] !== 'boolean') {
    errors.push('hardwareBacked must be boolean');
  } else if (typeof comp === 'string') {
    if (r['hardwareBacked'] === true && (comp === 'swiftshader' || comp === 'software')) {
      errors.push(`hardwareBacked=true contradicts compositor=${comp}`);
    }
    if (r['hardwareBacked'] === false && comp === 'hardware') {
      errors.push('hardwareBacked=false contradicts compositor=hardware');
    }
  }
  const w = num('width');
  const h = num('height');
  if (w === null || !Number.isInteger(w) || w <= 0) errors.push('width must be a positive int');
  if (h === null || !Number.isInteger(h) || h <= 0) errors.push('height must be a positive int');
  const res = str('resolution');
  if (w !== null && h !== null && res !== `${w}x${h}`) errors.push(`resolution must match width/height (${w}x${h})`);
  if (str('renderer') === null) errors.push('renderer required (software|voodoo)');
  const workers = r['workers'];
  if (!Array.isArray(workers) || workers.length === 0 ||
    !workers.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 8)) {
    errors.push('workers must be a non-empty array of 0..8');
  }
  if (num('durationS') === null || (num('durationS') as number) <= 0) errors.push('durationS must be > 0');
  if (num('samples') === null || (num('samples') as number) <= 0) errors.push('samples must be > 0');
  for (const k of ['presentedFpsMedian', 'frameP50Ms', 'frameP95Ms', 'frameMaxMs']) {
    const n = r[k];
    if (n !== null && n !== undefined && (typeof n !== 'number' || !Number.isFinite(n))) errors.push(`${k} must be a number or null`);
  }
  if (!Array.isArray(r['workloads'])) errors.push('workloads must be an array (stationary/moving/combat intervals covered)');
  return { ok: errors.length === 0, errors };
}

export interface SoakImportOpts {
  outDir?: string;
  manifestPath?: string;
}

/**
 * Import a browser soak JSON into durable evidence: validates the schema,
 * copies the raw input next to it, and writes a browser-soak manifest.
 * Throws on validation failure (the browser record must be explicit).
 */
export function importBrowserSoak(inputPath: string, opts: SoakImportOpts = {}): SoakImportResult {
  const abs = resolve(inputPath);
  const raw = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
  const check = validateBrowserSoak(raw);
  if (!check.ok) {
    throw new Error(`browser soak invalid:\n- ${check.errors.join('\n- ')}`);
  }
  const soak = raw as BrowserSoakRecord;
  const outDir = resolve(opts.outDir ?? evidenceRawDir());
  mkdirSync(outDir, { recursive: true });
  const base = `${soak.commitShort}-${stamp()}`;
  const rawName = `browser-soak-${base}.json`;
  const resultPath = join(outDir, rawName);
  if (resolve(abs) !== resultPath) copyFileSync(abs, resultPath);
  const commitFull = soak.commitFull ?? soak.commitShort;
  const load = loadavg();
  const n = Math.max(1, cpus().length);
  const manifest: EvidenceManifest = {
    manifestVersion: EVIDENCE_MANIFEST_VERSION,
    kind: 'browser-soak',
    date: new Date().toISOString(),
    command: { argv: process.argv.slice(0), env: provenanceEnv(), cwd: process.cwd() },
    commitShort: soak.commitShort,
    commitFull,
    treeDirty: (gitOut('status --porcelain') ?? '').length > 0,
    distFresh: distFreshness(),
    pak: { path: '(browser-imported)', bytes: null, mtimeMs: null, mtimeIso: null, missing: true },
    machine: {},
    node: process.version,
    browser: { ...soak.browser },
    compositor: soak.compositor,
    loadavg: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    cpus: n,
    quietOk: (load[0] ?? 0) <= n,
    fidelity: null,
    warmup: null,
    reps: soak.samples,
    workers: [...soak.workers],
    resultFile: resultPath,
    summary: {
      resolution: soak.resolution,
      renderer: soak.renderer,
      durationS: soak.durationS,
      samples: soak.samples,
      presentedFpsMedian: soak.presentedFpsMedian,
      frameP50Ms: soak.frameP50Ms,
      frameP95Ms: soak.frameP95Ms,
      frameMaxMs: soak.frameMaxMs,
      hardwareBacked: soak.hardwareBacked,
      compositor: soak.compositor,
    },
    soak,
    ledgerHint:
      `| ${new Date().toISOString().slice(0, 10)} | ${soak.commitShort} | browser-soak (${soak.compositor}` +
      `${soak.hardwareBacked ? ',hw' : ',sw'}) | ${soak.resolution} ${soak.renderer} ` +
      `presented ${soak.presentedFpsMedian ?? 'n/a'}fps p95 ${soak.frameP95Ms ?? 'n/a'}ms ` +
      `| evidence: browser-soak-${base}.manifest.json |`,
  };
  const manifestPath = writeEvidenceManifest(manifest, opts.manifestPath);
  return { manifestPath, resultPath, manifest };
}
