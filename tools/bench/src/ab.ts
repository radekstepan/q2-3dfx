// q2-bench interleaved candidate-A/B (PERF-NEXT-6 Lane C).
//
// Compares config X vs config Y back-to-back INTERLEAVED on the same box:
// warm up both legs, then alternate timed reps (A_i, B_i per rep) so both
// legs share thermal state rep-by-rep. Complements (never duplicates)
// compare-run/compare-diff, which diff BASE vs HEAD builds sequentially in
// separate processes: this runner diffs two CONFIGS (e.g. workers 7 vs 3,
// pooled vs serial) of the SAME build in ONE process.
//
// Workload definitions are byte-identical to the compare matrix
// (pinPerfCvars + fixed cameras + fixed entity sets + pumped combat
// dlights); only reports/collectors/orchestration differ. The timing core
// is @q2/testkit measureABPair (paired per-rep deltas, settings-match
// verification, output parity, per-leg execution proof).
//
// Env: AB_A / AB_B leg specs "scene,res,entities,mode,workers"
//   (defaults: A "spawn-north,640x480,combat,software,7",
//    B "spawn-north,640x480,combat,software,3"),
//   AB_WARMUP (default 3), AB_REPS (default 5),
//   AB_OUT / AB_MANIFEST_OUT (evidence paths).
// RELEASE-8: the `rgb` (CPU Voodoo execution) legs are retired —
// parseABLegSpec normalizes an explicit `rgb` mode to `software` (old run
// JSONs still load; no new rgb legs are produced).
import { createFramebuffer } from '@q2/renderer-api';
import type { Entity } from '@q2/renderer-api';
import { setCVar } from '@q2/config';
import { SoftwareRenderer, BandWorkerPool } from '@q2/sw-renderer';
import {
  base1RefDef, base1Views, formatABEvidence, machineJson, measureABPair,
  type ABLeg, type ABPairEvidence,
} from '@q2/testkit';
import {
  combatEntities,
  fixedEntities,
  loadRgbAttrWorld,
  pinPerfCvars,
  pumpCombatLights,
  swRendererEsmPath,
  type RgbAttrEntities,
  type RgbAttrMode,
  type RgbAttrScene,
  type RgbAttrWorld,
  RGB_ATTR_ENTS,
  RGB_ATTR_SCENES,
} from './rgbattr.js';
import {
  buildNodeManifest,
  collectNodeProvenance,
  defaultManifestPath,
  defaultResultPath,
  writeEvidenceManifest,
} from './evidence.js';

/** One leg spec: "scene,res,entities,mode,workers". */
export interface ABLegSpec {
  scene: RgbAttrScene;
  width: number;
  height: number;
  entities: RgbAttrEntities;
  mode: RgbAttrMode;
  workers: number;
}

/** Parse one AB leg spec (order-preserving, clamped workers 0..8). */
export function parseABLegSpec(raw: string | undefined, fallback: string): ABLegSpec {
  const parts = (raw ?? fallback).split(',').map((s) => s.trim());
  // (the 4th field, mode, is retired: RELEASE-8 runs software only —
  // see `mode` below; the field is still consumed positionally so old
  // "scene,res,entities,mode,workers" specs keep parsing).
  const [sceneRaw = '', resRaw = '', entRaw = '', , workersRaw = ''] = parts;
  const scene: RgbAttrScene = (RGB_ATTR_SCENES as readonly string[]).includes(sceneRaw)
    ? (sceneRaw as RgbAttrScene) : 'spawn-north';
  const m = /^(\d+)x(\d+)$/.exec(resRaw);
  const width = m ? Number(m[1]) : 640;
  const height = m ? Number(m[2]) : 480;
  const entities: RgbAttrEntities = (RGB_ATTR_ENTS as readonly string[]).includes(entRaw)
    ? (entRaw as RgbAttrEntities) : 'combat';
  // RELEASE-8: CPU Voodoo execution retired — an explicit `rgb` mode falls
  // back to `software` (never a void leg; old specs keep working). Kept
  // log-free: this parser is pure (see ab.test.ts).
  const mode: RgbAttrMode = 'software';
  const w = Math.floor(Number(workersRaw));
  const workers = Number.isFinite(w) ? Math.min(8, Math.max(0, w)) : 0;
  return { scene, width, height, entities, mode, workers };
}

function describeLeg(s: ABLegSpec): string {
  return `${s.scene},${s.width}x${s.height},${s.entities},${s.mode},w=${s.workers}`;
}

function sparkParticles(cx: number, cy: number, cz: number): Array<{ origin: Float32Array; color: number }> {
  const colors = [8, 70, 200, 231, 250, 180, 33, 99, 150, 210, 240, 15];
  return colors.map((color, i) => ({
    origin: new Float32Array([cx + ((i * 37) % 17) - 8, cy + ((i * 53) % 17) - 8, cz + 10 + ((i * 29) % 25)]),
    color,
  }));
}

interface BuiltLeg {
  leg: ABLeg;
  pool: BandWorkerPool | null;
}

/** Build one leg: own renderer + own pool, same workload bytes as compare. */
function buildLeg(fw: RgbAttrWorld, spec: ABLegSpec, tag: string): BuiltLeg {
  pinPerfCvars();
  // RELEASE-8: software-only (the rgb/CPU-Voodoo execution legs are
  // retired; the parser normalizes explicit `rgb` to `software`).
  const fb = createFramebuffer(spec.width, spec.height, true);
  const r = new SoftwareRenderer();
  r.init(fb);
  r.setPalette(fw.palette);
  let pool: BandWorkerPool | null = null;
  if (spec.workers > 0) {
    setCVar('sw_workers', Math.min(8, spec.workers + 1));
    setCVar('sw_accum', 1);
    r.syncWorkersFromCvar();
    pool = BandWorkerPool.create(spec.workers, spec.width, spec.height, { indexJsPath: swRendererEsmPath() });
    if (!pool) throw new Error(`ab: pool unavailable for leg ${tag} (need worker_threads + SAB)`);
    r.attachWorkerPool(pool);
  }
  const bv = base1Views().find((v) => v.label === spec.scene)!;
  const base = base1RefDef(bv);
  const origin = bv.origin;
  const yaw = bv.angles[1]!;
  const entities: Entity[] = spec.entities === 'none' ? []
    : spec.entities === 'fixed' ? fixedEntities(r, fw, origin, yaw)
      : combatEntities(r, fw, origin, yaw);
  const data = spec.entities === 'none' ? fw.world : {
    ...fw.world,
    particles: sparkParticles(origin[0]! + Math.cos((yaw * Math.PI) / 180) * 48, origin[1]! + Math.sin((yaw * Math.PI) / 180) * 48, origin[2]! - 20),
  };
  const worldArg = { name: 'base1', data };
  // RELEASE-8: raster-only (no scanout stage on the software path — the
  // endFrame color plane IS the presented frame, so there is no pooled or
  // serial resolve leg to fence here).
  const leg: ABLeg = {
    label: `${tag}(${describeLeg(spec)})`,
    renderer: r,
    world: worldArg,
    width: spec.width,
    height: spec.height,
    viewFor: () => ({ ...base }),
    entitiesFor: () => entities,
    pump: spec.entities === 'combat' ? () => pumpCombatLights(r, origin, yaw) : undefined,
    scanout: null,
  };
  return { leg, pool };
}

/** Run one interleaved A/B pair (sequential, quiet machine, same process). */
export async function runInterleavedAB(pakPath: string, opts: {
  specA?: ABLegSpec; specB?: ABLegSpec; warmup?: number; reps?: number;
} = {}): Promise<{ evidence: ABPairEvidence; specA: ABLegSpec; specB: ABLegSpec }> {
  const specA = opts.specA ?? parseABLegSpec(process.env.AB_A, 'spawn-north,640x480,combat,software,7');
  const specB = opts.specB ?? parseABLegSpec(process.env.AB_B, 'spawn-north,640x480,combat,software,3');
  // RELEASE-8: the parser already normalizes env specs; this covers
  // programmatically-passed legs (no new rgb legs from any caller).
  for (const s of [specA, specB]) {
    if (s.mode === 'rgb') {
      console.log('ab-run: leg mode "rgb" retired RELEASE-8 — running the software leg instead');
      s.mode = 'software';
    }
  }
  const warmup = opts.warmup ?? Number(process.env.AB_WARMUP ?? 3);
  const reps = opts.reps ?? Number(process.env.AB_REPS ?? 5);
  const commit = await gitCommit();
  console.log(`ab-run: commit=${commit} warmup=${warmup} reps=${reps}`);
  console.log(`ab-run: A=${describeLeg(specA)}`);
  console.log(`ab-run: B=${describeLeg(specB)}`);
  const fw = loadRgbAttrWorld(pakPath);
  const a = buildLeg(fw, specA, 'A');
  const b = buildLeg(fw, specB, 'B');
  try {
    const evidence = measureABPair(a.leg, b.leg, { warmup, reps });
    console.log(formatABEvidence(evidence));
    for (const p of evidence.pairs) {
      const d = p.deltaPct === null ? 'n/a' : `${p.deltaPct >= 0 ? '+' : ''}${p.deltaPct.toFixed(1)}%`;
      console.log(`ab rep${p.rep}: A=${p.aMs.toFixed(2)}ms B=${p.bMs.toFixed(2)}ms Δ=${p.deltaMs >= 0 ? '+' : ''}${p.deltaMs.toFixed(2)}ms (${d})`);
    }
    if (!evidence.settingsMatch) {
      console.log(`ab: settings MISMATCH — comparison VOID (${evidence.mismatchReasons.join('; ')})`);
    }
    return { evidence, specA, specB };
  } finally {
    if (a.pool) await a.pool.dispose();
    if (b.pool) await b.pool.dispose();
  }
}

async function gitCommit(): Promise<string> {
  try {
    const cp = await import('child_process');
    return cp.execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Suggested perf-ledger row for an A/B run (delta, never a baseline). */
export function abLedgerHint(
  commit: string, evidence: ABPairEvidence, manifestPath: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const d = evidence.deltaMedPct === null ? 'n/a' : `${evidence.deltaMedPct >= 0 ? '+' : ''}${evidence.deltaMedPct.toFixed(1)}%`;
  return (
    `| ${date} | ${commit} | ab ${evidence.labelA} vs ${evidence.labelB} ` +
    `Δ=${evidence.deltaMedMs >= 0 ? '+' : ''}${evidence.deltaMedMs.toFixed(2)}ms (${d}) ` +
    `settings=${evidence.settingsMatch ? 'MATCH' : 'MISMATCH'} parity=${evidence.outputParity === null ? 'n/a' : evidence.outputParity ? 'SAME' : 'DIFFER'} ` +
    `| evidence: ${manifestPath} |`
  );
}

export interface ABEmitOptions {
  resultPath?: string;
  manifestPath?: string;
}

/** Durable evidence for an A/B run (raw pairs JSON + committed manifest). */
export async function emitABEvidence(
  pakPath: string,
  evidence: ABPairEvidence,
  ctx: { warmup: number; reps: number; commit: string; opts?: ABEmitOptions },
): Promise<{ resultFile: string; manifestFile: string }> {
  const provenance = await collectNodeProvenance('node-ab', {
    pakPath, warmup: ctx.warmup, reps: ctx.reps,
    workers: [
      ...new Set(
        [evidence.labelA, evidence.labelB].map((l) => {
          const m = /w=(\d+)/.exec(l);
          return m ? Number(m[1]) : 0;
        }),
      ),
    ],
  });
  const machine = await machineJson().catch(() => ({ node: process.version }));
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const resultFile = ctx.opts?.resultPath ?? process.env.AB_OUT ?? defaultResultPath('node-ab', ctx.commit);
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, JSON.stringify({ evidence, machine, commit: ctx.commit, provenance }, null, 2));
  const summary: Record<string, string | number | boolean | null> = {
    labelA: evidence.labelA,
    labelB: evidence.labelB,
    medA: evidence.medA,
    medB: evidence.medB,
    deltaMedMs: evidence.deltaMedMs,
    deltaMedPct: evidence.deltaMedPct,
    settingsMatch: evidence.settingsMatch,
    outputParity: evidence.outputParity,
    execProvenA: evidence.execProvenA,
    execProvenB: evidence.execProvenB,
  };
  const manifestOut = ctx.opts?.manifestPath ?? process.env.AB_MANIFEST_OUT ?? defaultManifestPath('node-ab', ctx.commit);
  const manifest = buildNodeManifest(provenance, {
    resultFile,
    summary,
    ledgerHint: abLedgerHint(ctx.commit, evidence, manifestOut),
  });
  const manifestFile = writeEvidenceManifest(manifest, manifestOut);
  console.log(`ledger hint: ${manifest.ledgerHint}`);
  return { resultFile, manifestFile };
}
