// Committed PERF-1 bench runner: reproducible RGB attribution for PERF-2/3.
// Also writes the full run JSON + a durable evidence manifest (PERF-NEXT-1).
// Run: Q2_PAK=/path/to/pak0.pak yarn bench:rgb
// Env: RGB_BENCH_REPS (default 10), RGB_BENCH_WARMUP (default 3),
//   RGB_BENCH_WORKERS (default "0", e.g. "0,1,3,7" for the worker sweep),
//   RGB_BENCH_ENTS (default "none,fixed,combat"),
//   RGB_ATTR_OUT (default tools/bench/evidence/raw/node-rgbattr-<commit>-<ts>.json),
//   RGB_ATTR_MANIFEST_OUT (default tools/bench/evidence/node-rgbattr-<commit>-<ts>.manifest.json).
const pak = process.env.Q2_PAK;
if (!pak) {
  console.error('Q2_PAK required (path to pak0.pak); asset tests skip without it, this bench needs real map data.');
  process.exit(1);
}
const {
  runRgbAttr, collectNodeProvenance, buildNodeManifest,
  summarizeAttrRows, ledgerHintFor, writeEvidenceManifest,
  defaultResultPath, defaultManifestPath,
} = await import('./dist/index.mjs');
const { writeFileSync, mkdirSync } = await import('node:fs');
const { dirname } = await import('node:path');
const warmup = Number(process.env.RGB_BENCH_WARMUP ?? 3);
const reps = Number(process.env.RGB_BENCH_REPS ?? 10);
const run = await runRgbAttr(pak, { warmup, reps });
const workers = [...new Set(run.rows.map((r) => r.workers))].sort((a, b) => a - b);
const provenance = await collectNodeProvenance('node-rgbattr', { pakPath: pak, warmup, reps, workers });
const doc = { ...run, provenance };
const out = process.env.RGB_ATTR_OUT ?? defaultResultPath('node-rgbattr', run.commit);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2));
console.log(`rgb-attr: wrote ${out} (commit ${run.commit}, rows ${run.rows.length})`);
const summary = summarizeAttrRows(run.rows);
const manifestOut = process.env.RGB_ATTR_MANIFEST_OUT ?? defaultManifestPath('node-rgbattr', run.commit);
const manifest = buildNodeManifest(provenance, {
  resultFile: out,
  summary,
  ledgerHint: ledgerHintFor('node-rgbattr', run.commit, summary, manifestOut),
});
const written = writeEvidenceManifest(manifest, manifestOut);
console.log(`rgb-attr: manifest ${written}`);
console.log(`ledger hint: ${manifest.ledgerHint}`);
