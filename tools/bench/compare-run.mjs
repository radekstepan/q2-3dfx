// Controlled-comparison run: sequential quiet-machine matrix, one JSON out
// plus a durable evidence manifest (PERF-NEXT-1).
// Run: Q2_PAK=/path/to/pak0.pak yarn bench:compare-run
// Env: COMPARE_WARMUP (default 3), COMPARE_REPS (default 5),
//   COMPARE_WORKERS (default "0,1,3,7"), COMPARE_YAWSTEP (default 2),
//   COMPARE_OUT (default tools/bench/evidence/raw/compare-<commit>-<ts>.json),
//   COMPARE_MANIFEST_OUT (default tools/bench/evidence/node-compare-<commit>-<ts>.manifest.json).
// Run SEQUENTIALLY (never concurrent across agents), on a quiet machine,
// with the same env both times. The diff step verifies comparability.
// Baseline recipe (separate worktree, untouched checkout): see
// tools/bench/evidence/README.md "Capturing the 4631ca2 baseline".
const pak = process.env.Q2_PAK;
if (!pak) {
  console.error('Q2_PAK required (path to pak0.pak); comparison needs real map data.');
  process.exit(1);
}
const {
  runComparisonMatrix, collectNodeProvenance, buildNodeManifest,
  summarizeCompare, ledgerHintFor, writeEvidenceManifest,
  defaultResultPath, defaultManifestPath,
} = await import('./dist/index.mjs');
const { writeFileSync, mkdirSync } = await import('node:fs');
const { dirname } = await import('node:path');
const run = await runComparisonMatrix(pak, {});
// Provenance is captured AFTER the loops: pinPerfCvars leaves the pinned
// vd_*/sw_* profile armed, so the fidelity snapshot matches the run.
const provenance = await collectNodeProvenance('node-compare', {
  pakPath: pak, warmup: run.meta.warmup, reps: run.meta.reps, workers: run.meta.workers,
});
const doc = { ...run, provenance };
const out = process.env.COMPARE_OUT ?? defaultResultPath('node-compare', run.meta.commit);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2));
console.log(`compare-run: wrote ${out} (commit ${run.meta.commit}, quiet=${run.meta.quietOk})`);
const summary = summarizeCompare(run.stationary, run.moving);
const manifestOut = process.env.COMPARE_MANIFEST_OUT ?? defaultManifestPath('node-compare', run.meta.commit);
const manifest = buildNodeManifest(provenance, {
  resultFile: out,
  summary,
  ledgerHint: ledgerHintFor('node-compare', run.meta.commit, summary, manifestOut),
});
const written = writeEvidenceManifest(manifest, manifestOut);
console.log(`compare-run: manifest ${written}`);
console.log(`ledger hint: ${manifest.ledgerHint}`);
