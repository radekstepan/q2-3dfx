// Interleaved candidate-A/B run (PERF-NEXT-6 Lane C): config X vs config Y
// back-to-back interleaved on the same box, one process, shared thermals.
// Run: Q2_PAK=/path/to/pak0.pak yarn bench:ab
// Env: AB_A / AB_B leg specs "scene,res,entities,mode,workers"
//   (defaults A "spawn-north,640x480,combat,rgb,7",
//    B "spawn-north,640x480,combat,rgb,3"),
//   AB_WARMUP (default 3), AB_REPS (default 5),
//   AB_OUT (default tools/bench/evidence/raw/node-ab-<commit>-<ts>.json),
//   AB_MANIFEST_OUT (default tools/bench/evidence/node-ab-<commit>-<ts>.manifest.json).
// Run SEQUENTIALLY (never concurrent across agents), on a quiet machine.
// A settings mismatch VOIDS the comparison (reported, never a result).
const pak = process.env.Q2_PAK;
if (!pak) {
  console.error('Q2_PAK required (path to pak0.pak); A/B needs real map data.');
  process.exit(1);
}
const warmup = Number(process.env.AB_WARMUP ?? 3);
const reps = Number(process.env.AB_REPS ?? 5);
const { runInterleavedAB, emitABEvidence } = await import('./dist/index.mjs');
const { execSync } = await import('node:child_process');
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch { /* offline */ }
const { evidence } = await runInterleavedAB(pak, { warmup, reps });
const ev = await emitABEvidence(pak, evidence, { warmup, reps, commit });
console.log(`ab: evidence rows ${ev.resultFile}`);
console.log(`ab: manifest ${ev.manifestFile}`);
if (!evidence.settingsMatch) {
  console.error(`FAIL(settings): ${evidence.mismatchReasons.join('; ')} — comparison VOID, rerun with comparable legs.`);
  process.exit(1);
}
