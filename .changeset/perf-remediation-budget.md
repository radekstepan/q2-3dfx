---
"@q2/testkit": patch
---

Add perf-budget helpers (documented ≤16ms/frame @640x480 budgets, reference config, pure check/format). Timing-sensitive acceptance stays in tools/bench bench:accept; unit tests cover only the deterministic comparison.
