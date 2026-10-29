---
'@q2/sw-renderer': patch
---

Fix frame-level recovery prefix loss after quarantine isolation (PERF-NEXT-9). A recovery whose suffix was opaque replayed only the unapplied suffix in place, but quarantine abandons the applied prefix onto a cleared replacement buffer — dropping world/foreground work whenever the first timeout landed after a healthy recovery (intermittent pooled-vs-serial divergence under timeout storms). The pool now tracks a post-quarantine full-replay fence: the first recovery after isolation replays the full retained range exactly once (opaque-only in place, blend-carrying via clear + prefix + seed + suffix). Healthy-pool recovery shapes are unchanged. Pinned by deterministic pool-level regression tests (opaque + translucent/gun combos) and a 30-frame real-thread timeout-storm test asserting pooled full-RGBA identity with serial.
