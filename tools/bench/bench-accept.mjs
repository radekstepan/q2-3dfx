// Committed item-9 budget gate: warmed, repeated, uninstrumented production
// frames on the documented reference config (640x480 spawn-north).
// Run: Q2_PAK=/path/to/pak0.pak yarn bench:accept
// Env: RGB_ACCEPT_WARMUP (default 5), RGB_ACCEPT_REPS (default 10),
//   RGB_ACCEPT_WORKERS (default "0,1,3,7").
// Exit: 0 pass, 1 hard failure (stale dist/parity/fallback), 2 budget miss.
const pak = process.env.Q2_PAK;
if (!pak) {
  console.error('Q2_PAK required (path to pak0.pak); acceptance needs real map data.');
  process.exit(1);
}
const { runAcceptance } = await import('./dist/index.mjs');
const code = await runAcceptance(pak, {});
process.exit(code);
