// Committed M8.1 bench runner (methodology recreated from the gitignored
// bench.mjs era): real-base1 frame attribution + pooled A/B.
// Run: Q2_PAK=/path/to/pak0.pak yarn bench:frame  (SW_BENCH_WORKERS=N)
const pak = process.env.Q2_PAK;
if (!pak) {
  console.error('Q2_PAK required (path to pak0.pak); asset tests skip without it, this bench needs real map data.');
  process.exit(1);
}
const { runFrameBench } = await import('./dist/index.mjs');
await runFrameBench(pak, Number(process.env.SW_BENCH_WORKERS ?? 5));
const { playBench } = await import('./dist/index.mjs');
playBench(pak);
