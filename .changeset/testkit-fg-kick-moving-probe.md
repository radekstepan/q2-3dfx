---
"@q2/testkit": patch
---

Pin browser async-FG kick histogram + per-class completion invariant + moving-camera probe (TASK.md items 3-4 gaps, testkit lane): new BrowserFgKickSummary/summarizeBrowserFgKicks/readBrowserFgKicks over existing testBandExecStats (drain order world-first, null when disarmed, no producer change); reconcileForegroundAttribution holds published per-class worker/main splits to the zero-kick rule (null-by-design pinned with producer reason); bench runMovingConfig exported for a Q2_PAK-gated 320x240 diagnostic moving-camera probe (non-gating, budgets/goldens untouched).
