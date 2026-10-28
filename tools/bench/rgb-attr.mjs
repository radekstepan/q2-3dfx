// Committed PERF-1 bench runner: reproducible RGB attribution for PERF-2/3.
// Run: Q2_PAK=/path/to/pak0.pak yarn bench:rgb
// Env: RGB_BENCH_REPS (default 10), RGB_BENCH_WARMUP (default 3),
//   RGB_BENCH_WORKERS (default "0", e.g. "0,1,3,7" for the worker sweep),
//   RGB_BENCH_ENTS (default "none,fixed,combat").
const pak = process.env.Q2_PAK;
if (!pak) {
  console.error('Q2_PAK required (path to pak0.pak); asset tests skip without it, this bench needs real map data.');
  process.exit(1);
}
const { runRgbAttr } = await import('./dist/index.mjs');
await runRgbAttr(pak, {
  warmup: Number(process.env.RGB_BENCH_WARMUP ?? 3),
  reps: Number(process.env.RGB_BENCH_REPS ?? 10),
});
