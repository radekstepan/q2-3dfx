// Browser-soak importer (PERF-NEXT-1): validates a browser soak JSON
// against the committed schema and stores it + a manifest in
// tools/bench/evidence/ alongside the Node baselines (kept SEPARATE —
// Node production-frame-no-present numbers never mix with browser
// presented-FPS).
// Run: BROWSER_SOAK_IN=./soak.json yarn bench:browser-soak
// Env: BROWSER_SOAK_IN (required, path to the soak JSON),
//   BROWSER_SOAK_OUT (optional raw-copy dir, default evidence/raw/),
//   BROWSER_SOAK_MANIFEST_OUT (optional manifest path).
// Schema + compositor rules: tools/bench/evidence/README.md.
const input = process.env.BROWSER_SOAK_IN;
if (!input) {
  console.error('BROWSER_SOAK_IN required (path to a browser soak JSON matching the schema in tools/bench/evidence/README.md).');
  process.exit(1);
}
const { importBrowserSoak } = await import('./dist/index.mjs');
try {
  const { manifestPath, resultPath } = importBrowserSoak(input, {
    outDir: process.env.BROWSER_SOAK_OUT,
    manifestPath: process.env.BROWSER_SOAK_MANIFEST_OUT,
  });
  console.log(`browser-soak: raw ${resultPath}`);
  console.log(`browser-soak: manifest ${manifestPath}`);
} catch (e) {
  console.error(`FAIL(soak-schema): ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
