// @q2/testkit perf-budget unit tests — pure comparison logic ONLY.
// Timing-sensitive acceptance is NOT a unit test (it lives in tools/bench
// `bench:accept`, which exits non-zero when the budget is missed).
import { describe, expect, it } from 'vitest';
import {
  checkBudget,
  formatBudget,
  PERF_BUDGET_SOFTWARE_640_MS,
  PERF_BUDGET_VOODOO_640_MS,
  PERF_REFERENCE_CONFIG,
} from './perf-budget.js';

describe('perf-budget (pure logic, no timing)', () => {
  it('documents the 16ms reference budgets', () => {
    expect(PERF_BUDGET_SOFTWARE_640_MS).toBe(16);
    expect(PERF_BUDGET_VOODOO_640_MS).toBe(16);
    expect(PERF_REFERENCE_CONFIG.res).toBe('640x480');
    expect(PERF_REFERENCE_CONFIG.scene).toBe('spawn-north');
    expect(PERF_REFERENCE_CONFIG.workers).toEqual([0, 1, 3, 7]);
  });

  it('passes at or under budget, fails above', () => {
    expect(checkBudget(16, 16).pass).toBe(true);
    expect(checkBudget(15.99, 16).pass).toBe(true);
    expect(checkBudget(16.01, 16).pass).toBe(false);
  });

  it('reports signed margin (negative = headroom)', () => {
    expect(checkBudget(12, 16).marginMs).toBeCloseTo(-4, 9);
    expect(checkBudget(28, 16).marginMs).toBeCloseTo(12, 9);
  });

  it('formats a human line containing the verdict', () => {
    expect(formatBudget('software', checkBudget(12, 16))).toContain('PASS');
    expect(formatBudget('rgb', checkBudget(130, 16))).toContain('FAIL');
  });
});
