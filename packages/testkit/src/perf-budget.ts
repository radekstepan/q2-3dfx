// @q2/testkit — performance budget helpers (pure, deterministic).
//
// Timing-sensitive acceptance lives OUTSIDE unit tests (tools/bench
// `bench:accept`); this module only holds the documented budgets, the
// reference config, and the pure pass/fail math so both the bench and any
// gate can share one definition. No wall-clock reads here — unit tests
// cover only the pure comparison.

/** Documented frame budgets (docs/perf-ledger.md): ms/frame @640x480. */
export const PERF_BUDGET_SOFTWARE_640_MS = 16;
export const PERF_BUDGET_VOODOO_640_MS = 16;

/** Reference config the budget gates run on (Node, headless, Q2_PAK base1). */
export interface PerfReferenceConfig {
  scene: 'spawn-north';
  res: '640x480';
  width: 640;
  height: 480;
  /** Worker sweep for trustworthy reporting (serial + pooled). */
  workers: number[];
}

export const PERF_REFERENCE_CONFIG: PerfReferenceConfig = {
  scene: 'spawn-north',
  res: '640x480',
  width: 640,
  height: 480,
  workers: [0, 1, 3, 7],
};

export interface BudgetCheck {
  /** Measured median full-frame ms (uninstrumented acceptance metric). */
  ms: number;
  budgetMs: number;
  pass: boolean;
  /** ms - budgetMs (negative = headroom). */
  marginMs: number;
}

/** Pure budget comparison: pass when ms <= budgetMs. */
export function checkBudget(ms: number, budgetMs: number): BudgetCheck {
  return { ms, budgetMs, pass: ms <= budgetMs, marginMs: ms - budgetMs };
}

/** One-line human rendering of a budget check (for acceptance output). */
export function formatBudget(label: string, c: BudgetCheck): string {
  const verdict = c.pass ? 'PASS' : `FAIL (+${c.marginMs.toFixed(2)}ms over)`;
  return `${label}: ${c.ms.toFixed(2)}ms vs ${c.budgetMs}ms budget → ${verdict}`;
}
