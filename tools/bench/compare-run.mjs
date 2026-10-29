// Controlled-comparison run: sequential quiet-machine matrix, one JSON out.
// Run: Q2_PAK=/path/to/pak0.pak yarn bench:compare-run
// Env: COMPARE_WARMUP (default 3), COMPARE_REPS (default 5),
//   COMPARE_WORKERS (default "0,1,3,7"), COMPARE_YAWSTEP (default 2),
//   COMPARE_OUT (default compare-<commit>.json in cwd).
// Run SEQUENTIALLY (never concurrent across agents), on a quiet machine,
// with the same env both times. The diff step verifies comparability.
const pak = process.env.Q2_PAK;
if (!pak) {
  console.error('Q2_PAK required (path to pak0.pak); comparison needs real map data.');
  process.exit(1);
}
const { runComparisonMatrix } = await import('./dist/index.mjs');
const { writeFileSync } = await import('node:fs');
const run = await runComparisonMatrix(pak, {});
const out = process.env.COMPARE_OUT ?? `compare-${run.meta.commit}.json`;
writeFileSync(out, JSON.stringify(run, null, 2));
console.log(`compare-run: wrote ${out} (commit ${run.meta.commit}, quiet=${run.meta.quietOk})`);
