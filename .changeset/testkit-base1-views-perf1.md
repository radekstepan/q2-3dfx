---
"@q2/testkit": patch
---

perf(testkit): fixed base1 cameras helper for the PERF-1 attribution harness

Adds `base1Views()` / `base1RefDef()` (same four fixed cameras as the bench `BASE1_VIEWS`, fixed time 1.5 / fov 90 / flat light styles) so bench, goldens and gates share one camera definition. No golden changes; existing tests untouched.
