// Controlled-comparison diff: verifies settings match, prints the table.
// Run: yarn bench:compare-diff
// Env: COMPARE_BASE (default compare-base.json), COMPARE_HEAD (default compare-head.json).
// Exit: 0 settings match (table printed regardless); 1 settings mismatch
// (comparison void) or unreadable inputs.
const { readFileSync } = await import('node:fs');
const basePath = process.env.COMPARE_BASE ?? 'compare-base.json';
const headPath = process.env.COMPARE_HEAD ?? 'compare-head.json';
let base, head;
try {
  base = JSON.parse(readFileSync(basePath, 'utf8'));
  head = JSON.parse(readFileSync(headPath, 'utf8'));
} catch (e) {
  console.error(`FAIL(inputs): cannot read ${basePath} / ${headPath} — ${e}`);
  process.exit(1);
}
const { diffComparison, formatDiff } = await import('./dist/index.mjs');
const { lines, settingsMatch } = diffComparison(base, head);
console.log(`base=${base.meta?.commit ?? '?'} head=${head.meta?.commit ?? '?'} (node ${base.meta?.node} vs ${head.meta?.node})`);
console.log(formatDiff(lines, settingsMatch));
if (!settingsMatch) {
  console.error('FAIL(settings): workloads/settings differ — comparison VOID, rerun with identical env.');
  process.exit(1);
}
